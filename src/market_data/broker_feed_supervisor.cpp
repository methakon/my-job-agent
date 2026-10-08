#include "market_data/broker_feed_supervisor.hpp"
#include "common/env_loader.hpp"
#include "common/crypto_util.hpp"
#include <iostream>
#include <chrono>

BrokerFeedSupervisor::BrokerFeedSupervisor(std::shared_ptr<RoadmapDbClient> db_client,
                                           OptionTickReceiver& receiver,
                                           std::vector<std::string> symbols)
    : db_client_(std::move(db_client)),
      receiver_(receiver),
      default_symbols_(std::move(symbols)) {}

BrokerFeedSupervisor::~BrokerFeedSupervisor() {
    stop();
}

void BrokerFeedSupervisor::start() {
    if (running_.exchange(true)) return;

    std::cout << "🛡️ [BrokerFeedSupervisor] Starting native C++ market-data feed supervisor...\n";

    persist_thread_ = std::thread([this]() {
        db_persistence_worker();
    });

    supervisor_thread_ = std::thread([this]() {
        supervisor_loop();
    });
}

void BrokerFeedSupervisor::stop() {
    if (!running_.exchange(false)) return;

    std::cout << "🛡️ [BrokerFeedSupervisor] Stopping market-data supervisor...\n";

    if (active_client_) {
        active_client_->disconnect();
    }

    persist_cv_.notify_all();

    if (supervisor_thread_.joinable()) {
        supervisor_thread_.join();
    }
    if (persist_thread_.joinable()) {
        persist_thread_.join();
    }
}

SupervisorStatus BrokerFeedSupervisor::get_status() const {
    std::lock_guard<std::mutex> lock(status_mutex_);
    SupervisorStatus s;
    s.active_provider = active_provider_name_;
    s.is_connected = active_client_ && active_client_->is_connected();
    s.total_ticks_received = total_ticks_;
    s.last_tick_timestamp_ms = last_tick_ts_;
    s.last_error = last_error_;
    return s;
}

bool BrokerFeedSupervisor::is_token_usable(const std::string& provider, BrokerCredentials& out_creds) {
    if (!db_client_) return false;

    auto status_info = db_client_->fetch_broker_token_status(provider);
    if (!status_info.is_valid) {
        return false;
    }

    // Permanent guard: reject test / mock client_ids
    if (status_info.client_id.empty() ||
        status_info.client_id.rfind("test_", 0) == 0 ||
        status_info.client_id.rfind("mock_", 0) == 0 ||
        status_info.client_id == "test_client_id") {
        std::cerr << "⚠️ [BrokerFeedSupervisor] Guard: Rejected test/mock client_id for provider " << provider 
                  << " (client_id: " << status_info.client_id << ")\n";
        return false;
    }

    std::string raw_token = db_client_->fetch_active_broker_token_raw(provider);
    if (raw_token.empty() ||
        raw_token.rfind("test_", 0) == 0 ||
        raw_token.rfind("mock_", 0) == 0) {
        return false;
    }

    std::string secret = EnvLoader::get("ENCRYPTION_KEY", EnvLoader::get("APP_SECRET", ""));
    std::string decrypted = crypto_util::decrypt_token_if_needed(raw_token, secret);
    if (decrypted.empty()) {
        return false;
    }

    out_creds.provider = provider;
    out_creds.access_token = decrypted;

    if (provider == "fyers") {
        out_creds.app_id = !status_info.client_id.empty()
            ? status_info.client_id
            : EnvLoader::get("FYERS_APP_ID", "");
    } else if (provider == "upstox") {
        out_creds.app_id = !status_info.client_id.empty()
            ? status_info.client_id
            : EnvLoader::get("UPSTOX_API_KEY", "");
    }

    token_issued_at_[provider] = status_info.issued_at;
    return true;
}

std::string BrokerFeedSupervisor::select_best_provider(BrokerCredentials& out_creds) {
    BrokerCredentials creds_fyers, creds_upstox;
    bool fyers_ok = is_token_usable("fyers", creds_fyers);
    bool upstox_ok = is_token_usable("upstox", creds_upstox);

    // If a provider failed 2 or more consecutive times, demote it to allow failover
    if (fyers_ok && fail_counts_["fyers"] >= 2) {
        std::cerr << "⚠️ [BrokerFeedSupervisor] FYERS has " << fail_counts_["fyers"] 
                  << " consecutive connection failures. Demoting to fallback.\n";
        fyers_ok = false;
    }
    if (upstox_ok && fail_counts_["upstox"] >= 2) {
        std::cerr << "⚠️ [BrokerFeedSupervisor] Upstox has " << fail_counts_["upstox"] 
                  << " consecutive connection failures. Demoting to fallback.\n";
        upstox_ok = false;
    }

    // If both are usable, prefer the more recently issued token
    if (fyers_ok && upstox_ok) {
        if (token_issued_at_["upstox"] > token_issued_at_["fyers"]) {
            out_creds = creds_upstox;
            return "upstox";
        } else {
            out_creds = creds_fyers;
            return "fyers";
        }
    }

    if (upstox_ok) {
        out_creds = creds_upstox;
        return "upstox";
    }

    if (fyers_ok) {
        out_creds = creds_fyers;
        return "fyers";
    }

    // If all providers failed repeatedly, reset fail counts so we can retry after backoff
    if (fail_counts_["fyers"] >= 2 && fail_counts_["upstox"] >= 2) {
        fail_counts_["fyers"] = 0;
        fail_counts_["upstox"] = 0;
    }

    return "";
}

void BrokerFeedSupervisor::evaluate_and_connect() {
    BrokerCredentials creds;
    std::string chosen_provider = select_best_provider(creds);

    if (chosen_provider.empty()) {
        std::lock_guard<std::mutex> lock(status_mutex_);
        last_error_ = "No active, valid broker token found in provider_tokens table";
        std::cerr << "⚠️ [BrokerFeedSupervisor] " << last_error_ << ". Standing by for token...\n";
        return;
    }

    // Compute token hash to detect rotations
    auto hash_bytes = crypto_util::Sha256::hash(creds.access_token);
    std::string token_hash;
    for (size_t i = 0; i < 8 && i < hash_bytes.size(); ++i) {
        char buf[3];
        snprintf(buf, sizeof(buf), "%02x", hash_bytes[i]);
        token_hash += buf;
    }

    bool need_new_client = (!active_client_) ||
                           (active_provider_name_ != chosen_provider) ||
                           (active_token_hash_ != token_hash) ||
                           (!active_client_->is_connected());

    if (!need_new_client) {
        return;
    }

    std::cout << "🔄 [BrokerFeedSupervisor] Establishing connection with provider: "
              << chosen_provider << " (Token Hash: " << token_hash << ")\n";

    if (active_client_) {
        active_client_->disconnect();
        active_client_.reset();
    }

    std::unique_ptr<IBrokerWebSocketClient> new_client;
    if (chosen_provider == "upstox") {
        new_client = std::make_unique<UpstoxWebSocketClient>();
    } else if (chosen_provider == "fyers") {
        new_client = std::make_unique<FyersWebSocketClient>();
    }

    if (!new_client) return;

    new_client->set_on_tick([this](const CanonicalOptionTick& t) {
        handle_tick(t);
    });

    new_client->set_on_disconnect([this](const std::string& reason) {
        handle_disconnect(reason);
    });

    bool connected = new_client->connect(creds);
    if (connected) {
        fail_counts_[chosen_provider] = 0;
        new_client->subscribe(default_symbols_);
        active_client_ = std::move(new_client);
        active_provider_name_ = chosen_provider;
        active_token_hash_ = token_hash;
        should_reconnect_ = false;

        std::lock_guard<std::mutex> lock(status_mutex_);
        last_error_.clear();
        std::cout << "🌟 [BrokerFeedSupervisor] Active feed established via " << chosen_provider << "\n";
    } else {
        fail_counts_[chosen_provider]++;
        std::lock_guard<std::mutex> lock(status_mutex_);
        last_error_ = "Failed to connect to " + chosen_provider + " (fail count: " + std::to_string(fail_counts_[chosen_provider]) + ")";
        std::cerr << "❌ [BrokerFeedSupervisor] " << last_error_ << ". Will retry or failover.\n";
    }
}

void BrokerFeedSupervisor::handle_tick(const CanonicalOptionTick& tick) {
    // 1. Instant RAM ingestion (0ms) into trading pipeline
    receiver_.ingest_tick(tick);

    // 2. Queue for background DB persistence
    {
        std::lock_guard<std::mutex> lock(persist_mutex_);
        if (tick_persist_queue_.size() < 10000) {
            tick_persist_queue_.push(tick);
        }
    }
    persist_cv_.notify_one();

    // 3. Telemetry
    {
        std::lock_guard<std::mutex> lock(status_mutex_);
        total_ticks_++;
        last_tick_ts_ = tick.timestamp_ms;
    }
}

void BrokerFeedSupervisor::handle_disconnect(const std::string& reason) {
    std::cerr << "⚠️ [BrokerFeedSupervisor] Active connection disconnected (" << reason << "). Triggering reconnect.\n";
    if (!active_provider_name_.empty()) {
        fail_counts_[active_provider_name_]++;
    }
    should_reconnect_ = true;
}

void BrokerFeedSupervisor::supervisor_loop() {
    int check_interval_sec = 5;

    while (running_.load()) {
        try {
            bool conn_ok = active_client_ && active_client_->is_connected();
            if (!conn_ok || should_reconnect_.load()) {
                evaluate_and_connect();
            }
        } catch (const std::exception& e) {
            std::cerr << "❌ [BrokerFeedSupervisor] Loop error: " << e.what() << "\n";
        } catch (...) {
            std::cerr << "❌ [BrokerFeedSupervisor] Unknown loop error.\n";
        }

        for (int i = 0; i < check_interval_sec * 10 && running_.load(); ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (should_reconnect_.load()) break;
        }
    }
}

void BrokerFeedSupervisor::db_persistence_worker() {
    while (running_.load()) {
        std::vector<CanonicalOptionTick> batch;
        {
            std::unique_lock<std::mutex> lock(persist_mutex_);
            persist_cv_.wait_for(lock, std::chrono::milliseconds(500), [this]() {
                return !tick_persist_queue_.empty() || !running_.load();
            });

            while (!tick_persist_queue_.empty() && batch.size() < 100) {
                batch.push_back(tick_persist_queue_.front());
                tick_persist_queue_.pop();
            }
        }

        if (!batch.empty() && db_client_) {
            for (const auto& tick : batch) {
                db_client_->save_canonical_market_snapshot(tick);
            }
        }
    }
}
