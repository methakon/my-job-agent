# C++ Autonomous Self-Learning Trading Agent Requirement & Architecture Specification

**Project Directory**: `/home/swarna-sekhar-dhar/projects/cpp-trading-agent`  
**Git Branch**: `feat/cpp-trading-agent`  
**Trading Instrument Scope**: **Option Chain Contracts ONLY (Call `CE` & Put `PE` strike contracts across NIFTY, BANKNIFTY, FINNIFTY, SENSEX). Index is used strictly as an underlying reference benchmark.**  
**Chosen Stack Architecture**: **Option 3: Pure Embedded C++ Engine + Embedded Web Dashboard**  
**Server RAM Target**: **15 MB – 20 MB RSS** (Zero Node.js runtime on server)  
**CI/CD Pipeline**: **Automated GitHub Actions (Compile Matrix $\rightarrow$ Cppcheck Scan $\rightarrow$ CTest Suite $\rightarrow$ $<15\mu\text{s}$ Latency Gate $\rightarrow$ SSH Deployment to Oracle VM).**  
**Execution Phase**: Paper Trading (Current) $\longrightarrow$ Real Live Execution (Automated Promotion Gate)  
**Primary Mission**: **Learn from historical & live market data, learn from mistakes and successes, and continuously self-improve to SURVIVE and drive CONSISTENT PROFITABILITY.**  
**Data Preservation Guarantee**: **100% Reuse of Existing Oracle Cloud MySQL Data (6.9M+ Rows Preserved).**  
**Security Mandate**: **Zero-Trust Hardened Security & Penetration Defense.**

---

## 1. Automated CI/CD Pipeline Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        AUTOMATED GITHUB ACTIONS CI/CD PIPELINE                         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   ┌────────────────────────┐      Git Push / PR       ┌────────────────────────────┐   │
│   │ Developer Push / PR to │ ───────────────────────> │ GitHub Actions CI Runner   │   │
│   │ feat/cpp-trading-agent │                          │ (GCC 13 & Clang 17 Matrix) │   │
│   └────────────────────────┘                          └────────────────────────────┘   │
│                                                                     │                  │
│                                                                     ▼                  │
│                                                       ┌────────────────────────────┐   │
│                                                       │ Static Audit & Security    │   │
│                                                       │ (Cppcheck & Clang-Tidy)    │   │
│                                                       └────────────────────────────┘   │
│                                                                     │                  │
│                                                                     ▼                  │
│                                                       ┌────────────────────────────┐   │
│                                                       │ CTest & Latency Gate       │   │
│                                                       │ (P99 Latency < 15µs Gate)  │   │
│                                                       └────────────────────────────┘   │
│                                                                     │                  │
│                                                                     ▼                  │
│   ┌────────────────────────┐      Automated SCP       ┌────────────────────────────┐   │
│   │ Oracle Cloud VM        │ <─────────────────────── │ Packaging & SSH Deployment │   │
│   │ (Hot-Reload Service)   │   Binary Upload (~5MB)   │ (systemctl hot restart)    │   │
│   └────────────────────────┘                          └────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Pipeline Workflow Stages (`.github/workflows/cpp-agent-ci-cd.yml`):
1. **Matrix Build**: Dual compiler verification using GCC 13 and Clang 17 under `-O3` Release optimization.
2. **Static Analysis & Security Audit**: Runs `cppcheck` and `clang-tidy` to prevent buffer overflows, uninitialized memory, or resource leaks.
3. **Automated CTest Suite**: Executes regression unit tests covering canonical tick parsing, SOLID risk engine, and ACID transaction rollbacks.
4. **Latency Benchmark Gate**: Measures tick decision latency. Fails the build if $p_{99}$ latency exceeds $15\,\mu\text{s}$.
5. **Automated SCP Deployment**: On merge to `feat/cpp-trading-agent`, packages the 5MB C++ executable binary, uploads it to Oracle Cloud VM (`Dhargent`) via SSH, and performs a zero-downtime service restart (`systemctl restart cpp-trading-agent`).
6. **Post-Deploy Health Check**: Performs automated HTTP `/health` probe verification.

---

## 2. Instrument Scope: Option Chain Contracts (CE & PE)

The C++ Trading Agent trades **strictly on Option Chain Contracts (Calls `CE` and Puts `PE`)**, NOT directly on index futures or spot indices:

- **Tradable Instruments**: Option Chain strikes across active expirations (e.g., `NSE:NIFTY26SEP24300CE`, `NSE:BANKNIFTY26SEP52000PE`, `BSE:SENSEX17SEP73900CE`).
- **Underlying Index Role**: Spot Index values (`NSE:NIFTY50`, `NSE:BANKNIFTY`, `BSE:SENSEX`) serve purely as **reference benchmarks** for spot direction, moneyness, IV Skew surfaces, and gap ATR calculations.
- **Execution Target**: All BUY/SELL orders, paper order fills, position tracking, trailing stops, and PnL accounting are executed exclusively on **Option Chain Contract instruments (`CE` / `PE`)**.

---

## 3. Data Preservation & Canonical Tick Compatibility

The C++ agent is 100% backward-compatible with the existing database schema and canonical tick interpreter (`canonical-tick.ts`). **Zero data loss or destructive migration will occur.**

### Native C++ `CanonicalTick` Struct Layout (Memory-Mapped):
```cpp
struct CanonicalTick {
    char instrumentKey[64];      // e.g. "NSE:NIFTY26SEP23000PE"
    char source[16];             // e.g. "UPSTOX", "FYERS"
    char providerInstrumentId[64];
    char underlying[16];         // e.g. "NIFTY", "BANKNIFTY"
    char exchange[8];            // e.g. "NSE", "BSE"
    uint8_t optionType;          // 1: CE, 2: PE, 0: N/A
    double strike;               // 23000.00
    double ltp;                  // Last Traded Price
    double bid;                  // Best Bid
    double ask;                  // Best Ask
    int32_t bidQty;
    int32_t askQty;
    double volume;
    double oi;                   // Open Interest
    double changeOi;             // Change in Open Interest
    double iv, delta, gamma, theta, vega; // Option Greeks
    uint64_t sourceTimestampMs;   // Epoch ms timestamp from broker
    uint64_t receivedTimestampMs; // System receive timestamp
    uint8_t dataQuality;         // 1: GOOD, 0: STALE
};
```
*Memory Footprint*: ~256 bytes per struct (1 Million ticks stored in just 256 MB RAM!).

---

## 4. Zero-Trust Security & Penetration Defense Architecture

- **TLS 1.3 / WSS Encryption**: Enforced on all WebSockets and HTTP endpoints.
- **C++ Memory Safety**: Compiled with `-fstack-protector-strong -D_FORTIFY_SOURCE=2 -Wl,-z,relro,-z,now -pie -fPIE`.
- **Anti-DDoS**: Embedded C++ token-bucket rate limiter.
- **SQL Injection Immune**: 100% prepared parameterized SQL statements (`mysql_stmt_prepare`).

---

## 5. Prime Mission Directive: Survival & Self-Improvement Loop

$$\text{Objective} = \max \left( \mathbb{E}[\text{Net PnL}] \right) \quad \text{subject to} \quad \text{Max Drawdown} < 5\%, \; \text{Sharpe} > 2.0, \; \text{Risk-First Rules}$$

---

## 6. Promotion Gates (Paper Trading $\longrightarrow$ Live Real Trading)

1. **Sharpe Ratio Gate**: Continuous 30-day paper Sharpe Ratio $> 2.0$.
2. **Drawdown Gate**: Maximum paper portfolio drawdown $< 5\%$.
3. **Execution Latency Gate**: $p_{99}$ decision latency $< 15\,\mu\text{s}$.
4. **Expectancy Gate**: Positive expectancy across all 5 weekday market regimes.
5. **Zero Schema/ACID Failures**: 100% audit log consistency in decision journal.
