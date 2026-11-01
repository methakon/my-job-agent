#include "http_client.hpp"

#include <curl/curl.h>

#include <mutex>

namespace hermes {
namespace http {

namespace {

std::once_flag g_curl_init_once;

void ensure_curl_initialised() {
    // curl_global_init is not thread safe and must run once before any other thread uses libcurl.
    std::call_once(g_curl_init_once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
}

struct Sink {
    std::string* out;
    long limit;
    bool overflow;
};

size_t write_cb(char* data, size_t size, size_t nmemb, void* userdata) {
    Sink* sink = static_cast<Sink*>(userdata);
    const size_t n = size * nmemb;
    if (static_cast<long>(sink->out->size() + n) > sink->limit) {
        sink->overflow = true;
        return 0;   // tells libcurl to abort the transfer
    }
    sink->out->append(data, n);
    return n;
}

}  // namespace

bool is_acceptable_url(const std::string& url) {
    static const std::string kScheme = "https://";
    if (url.size() <= kScheme.size() || url.compare(0, kScheme.size(), kScheme) != 0) return false;
    for (char c : url) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (u <= 0x20 || u == 0x7F) return false;   // no whitespace, control characters or NUL
    }
    return url[kScheme.size()] != '/' && url[kScheme.size()] != '?' && url[kScheme.size()] != '#';
}

Response perform(const Request& req) {
    Response res;

    if (!is_acceptable_url(req.url)) {
        res.error = "refused: URL must be a well-formed https:// URL";
        return res;
    }
    if (req.method != "GET" && req.method != "POST") {
        res.error = "refused: unsupported method " + req.method;
        return res;
    }
    // A header is one line. CR/LF inside a value would let a caller-supplied string add headers.
    for (const std::string& h : req.headers) {
        if (h.find('\r') != std::string::npos || h.find('\n') != std::string::npos) {
            res.error = "refused: header contains a line break";
            return res;
        }
    }

    ensure_curl_initialised();
    CURL* curl = curl_easy_init();
    if (!curl) {
        res.error = "curl_easy_init failed";
        return res;
    }

    struct curl_slist* header_list = nullptr;
    for (const std::string& h : req.headers) header_list = curl_slist_append(header_list, h.c_str());

    Sink sink{&res.body, req.max_response_bytes, false};
    char err_buf[CURL_ERROR_SIZE] = {0};

    curl_easy_setopt(curl, CURLOPT_URL, req.url.c_str());
    curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, err_buf);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &sink);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, req.timeout_secs);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, req.timeout_secs < 10 ? req.timeout_secs : 10L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);       // a redirect could leave https://
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);             // required for timeouts in threads
    if (header_list) curl_easy_setopt(curl, CURLOPT_HTTPHEADER, header_list);
    if (req.method == "POST") {
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, req.body.c_str());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(req.body.size()));
    }

    const CURLcode rc = curl_easy_perform(curl);
    if (rc == CURLE_OK) {
        long status = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
        res.transport_ok = true;
        res.status = status;
    } else if (sink.overflow) {
        res.error = "response exceeded " + std::to_string(req.max_response_bytes) + " bytes";
    } else {
        res.error = err_buf[0] ? std::string(err_buf) : std::string(curl_easy_strerror(rc));
    }

    curl_slist_free_all(header_list);
    curl_easy_cleanup(curl);
    return res;
}

}  // namespace http
}  // namespace hermes
