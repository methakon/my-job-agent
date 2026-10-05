#ifndef ENGINE_HARDWARE_CONFIG_HPP
#define ENGINE_HARDWARE_CONFIG_HPP

#include <string>
#include <vector>
#include <memory>
#include <thread>
#include <fstream>
#include <chrono>

struct HardwareSpec {
    unsigned int total_logical_cores{0};
    unsigned int allocated_worker_threads{0};
    unsigned int reserved_io_threads{0};
    size_t total_memory_mb{0};
    std::string cpu_model{"Generic x86_64"};
};

class HardwareManager {
public:
    static HardwareSpec detect_hardware() {
        HardwareSpec spec;
        spec.total_logical_cores = std::thread::hardware_concurrency();
        if (spec.total_logical_cores == 0) spec.total_logical_cores = 4;

        // Reserve 25% cores for I/O, DB connection pool, HTTP portal & systemd logging (min 2, max 10)
        spec.reserved_io_threads = std::max(2u, std::min(10u, spec.total_logical_cores / 4));
        spec.allocated_worker_threads = spec.total_logical_cores - spec.reserved_io_threads;
        spec.total_memory_mb = 16384; // 16GB local RAM

        return spec;
    }
};

// Abstract Decision Engine Backend Interface (Section 5: GPU/CPU Portability Boundary)
struct StrategyInputRef {
    double spot_price{0.0};
    double open_price{0.0};
    double prev_close{0.0};
    double iv{0.0};
    double iv_rank{0.0};
    double oi_trend{0.0};
    double rv_percentile{0.0};
    double delta{0.0};
    double gamma{0.0};
    std::string symbol;
};

struct StrategyDecisionResult {
    std::string action; // BUY, SELL, NO_TRADE
    double confidence{0.0};
    std::string reason;
    std::string backend_used;
};

class IDecisionEngineBackend {
public:
    virtual ~IDecisionEngineBackend() = default;
    virtual std::string backend_name() const = 0;
    virtual StrategyDecisionResult evaluate(const StrategyInputRef& input) = 0;
};

// Native Parallel CPU Evaluator Backend
class CpuParallelDecisionBackend : public IDecisionEngineBackend {
public:
    std::string backend_name() const override { return "CpuParallelDecisionBackend_v1"; }
    StrategyDecisionResult evaluate(const StrategyInputRef& input) override {
        StrategyDecisionResult res;
        double spread = MathAbs(input.spot_price - input.prev_close) / input.spot_price;
        bool isConfidencePass = spread > 0.001;
        if (isConfidencePass && input.iv_rank >= 0.2) {
            res.action = "BUY";
            res.confidence = 72.5;
            res.reason = "CPU_PARALLEL_GAP_IMPULSE_PASS";
        } else {
            res.action = "NO_TRADE";
            res.confidence = 52.0;
            res.reason = "FILTERS_NOT_PASSED";
        }
        res.backend_used = backend_name();
        return res;
    }

private:
    static double MathAbs(double v) { return v >= 0 ? v : -v; }
};

// Stability & Soak-Test Telemetry Monitor (Section 6)
class SoakTestTelemetryMonitor {
public:
    SoakTestTelemetryMonitor() : start_time_(std::chrono::steady_clock::now()) {}

    void log_telemetry_snapshot(size_t ticks_processed, size_t contracts_evaluated) {
        auto now = std::chrono::steady_clock::now();
        double uptime_sec = std::chrono::duration<double>(now - start_time_).count();

        size_t rss_bytes = read_process_rss();
        double rss_mb = rss_bytes / (1024.0 * 1024.0);

        history_.push_back({uptime_sec, rss_mb});
        if (history_.size() > 30) {
            history_.erase(history_.begin());
        }

        std::string status = "WARMING_UP";
        double slope_mb_per_min = 0.0;

        if (history_.size() >= 5) {
            double dt_sec = history_.back().first - history_.front().first;
            double drss_mb = history_.back().second - history_.front().second;
            if (dt_sec > 1.0) {
                slope_mb_per_min = (drss_mb / dt_sec) * 60.0;
            }

            if (slope_mb_per_min > 2.0) {
                status = "LEAK_ALERT_CLIMBING_HIGH_SLOPE";
            } else if (slope_mb_per_min > 0.5) {
                status = "SLOPE_WARMUP_CLIMBING";
            } else if (slope_mb_per_min < -0.5) {
                status = "STABLE_SLOPE_DECREASING";
            } else {
                status = "STABLE_SLOPE_FLAT";
            }
        }

        std::ofstream log("logs/soak_test_telemetry.log", std::ios::app);
        if (log.is_open()) {
            log << "[SOAK_TEST_TELEMETRY] uptime_sec=" << uptime_sec
                << " rss_mb=" << rss_mb
                << " ticks_processed=" << ticks_processed
                << " contracts_evaluated=" << contracts_evaluated
                << " rss_slope_mb_min=" << slope_mb_per_min
                << " status=" << status << "\n";
        }
    }

private:
    size_t read_process_rss() {
        std::ifstream statm("/proc/self/statm");
        if (!statm.is_open()) return 0;
        size_t pages = 0;
        size_t rss_pages = 0;
        statm >> pages >> rss_pages;
        return rss_pages * 4096; // 4KB page size
    }

    std::chrono::steady_clock::time_point start_time_;
    std::vector<std::pair<double, double>> history_;
};

#endif // ENGINE_HARDWARE_CONFIG_HPP
