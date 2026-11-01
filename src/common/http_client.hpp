#ifndef COMMON_HTTP_CLIENT_HPP
#define COMMON_HTTP_CLIENT_HPP

// In-process HTTPS client (libcurl). Replaces the `popen("curl ...")` calls.
//
// Why: those calls built a shell command line by concatenation, with request data (an OAuth
// `code` taken from the query string of an unauthenticated callback, a JSON body, a URL built from
// an instrument key) inside single quotes. A single quote in the value ended the quoting and the
// remainder ran as shell. Here no shell exists: the URL, headers and body are passed to libcurl as
// data, so no value can change what is executed.
//
// Scope: HTTPS only, no redirects, TLS verification on, bounded response size. That is all the
// callers need, and refusing the rest keeps the surface small.

#include <string>
#include <vector>

namespace hermes {
namespace http {

struct Request {
    std::string method = "GET";            // "GET" or "POST"
    std::string url;                       // must start with https://
    std::vector<std::string> headers;      // "Name: value"
    std::string body;                      // sent verbatim for POST
    long timeout_secs = 15;
    long max_response_bytes = 8L * 1024 * 1024;
};

struct Response {
    bool transport_ok = false;             // the exchange completed (any HTTP status)
    long status = 0;                       // HTTP status when transport_ok
    std::string body;
    std::string error;                     // set when !transport_ok

    bool ok_2xx() const { return transport_ok && status >= 200 && status < 300; }
};

// True when `url` is acceptable to perform(): https scheme, a host, and no control characters or
// whitespace. Exposed so the policy is testable without a network.
bool is_acceptable_url(const std::string& url);

Response perform(const Request& req);

}  // namespace http
}  // namespace hermes

#endif  // COMMON_HTTP_CLIENT_HPP
