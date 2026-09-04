## Upstox Sandbox Isolation — Implementation Plan (2026-09-05, spec v2)

> NOTE: spec v2 (paste_2, same day) SUPERSEDES v1 where they conflict:
> - v1 §6 "NO TICK RECORDING for Sandbox" → **v2 §2 REQUIRES a physically separate
>   `sandbox_ticks` table** (rich metadata, own indexes, async non-blocking ingest).
> - Test list replaced by v2 §15 A–L; acceptance = v2 §20 checklist.
> Mode-columns/provider/config work done under v1 remains valid (v2 keeps
> on_real_data + data_source + trading_environment semantics; I use
> executionProvider/executionMode as the explicit source/environment fields).

## Architecture reality (audited)
- **FYERS = REAL market-data provider** (WebSocket ticks → `fnf_market_snapshots` /
  `fnf_option_quotes`). Execution is internal paper fills (`openTrade`/`closeTrade`)
  on real data. Mode model: FYERS pipeline = `on_real_data=true,
  executionProvider=FYERS, executionMode=REAL`.
- **Upstox Sandbox = opt-in, isolated** (`on_real_data=false, provider=UPSTOX,
  mode=SANDBOX`), its own path: sandbox_ticks → sandbox analytics → PAPER orders.
  Real path NEVER waits on sandbox (async ingest, independent failure).

## Tables & role
| Table | Role | Mode columns |
|---|---|---|
| fnf_trades | executions/positions/P&L | on_real_data, execution_provider, execution_mode (added) |
| fnf_portfolios | capital/equity envelope | on_real_data, execution_provider, execution_mode (added) |
| fnf_decision_journal | persisted signals/decisions | on_real_data, execution_provider, execution_mode (added) |
| fnf_trade_reflections | post-trade learning | on_real_data, execution_provider (added) |
| fnf_trade_reports | T-07 outbox | on_real_data, execution_provider (added) |
| fnf_market_snapshots(_history), fnf_option_quotes(_history) | **FYERS real ticks — untouched** | none (never written by sandbox) |
| **sandbox_ticks (NEW)** | **Upstox sandbox ticks — physically separate** | source=UPSTOX, environment=SANDBOX, on_real_data=false, + instrument/symbol/ts/price/bid/ask/expiry/strike/type |

Defaults preserve FYERS: every existing/new real row gets on_real_data=1, FYERS, REAL.

## Aggregation audit — sites that must filter real-only
1. `learningSummary()` — closed-trade win rate/netPnl/byAlgo → on_real_data=true ✓
2. `rectifyDecay()` — decay model from closed trades → on_real_data=true ✓
3. `listTrades()` — ledger → realOnly default true ✓ (+/trades/sandbox endpoint)
4. `listPortfolios()` — envelope → real-only default ✓ (+/portfolios/sandbox)
5. Tick queries ("latest ticks") — real tables only; sandbox ticks live in
   sandbox_ticks → physically impossible to mix.

## Additive pieces
1. Entity columns on 5 tables + indexes + shared-DB ALTER (migrated 2026-09-05).
2. Config: UPSTOX_SANDBOX_ENABLED=false + client_id/_secret/_access_token unset.
3. `ExecutionProvider` interface + `UpstoxSandboxProvider` (SANDBOX-only base URL,
   fail-closed, REAL-mode config rejected, disabled without creds).
4. `SandboxTick` entity + table + `UpstoxSandboxIngestionService` (async queue;
   enqueue → background flush; never awaits sandbox on the real path).
5. Isolation filters at audited sites + sandbox query endpoints.
6. Log tags [REAL][FYERS] / [SANDBOX][UPSTOX].
7. Tests spec-v2 §15 A–L + keep Gate-0/feature suites green.
8. Docs UPSTOX_SANDBOX.md (§18) + acceptance checklist (§20).

## Acceptance (spec v2 §20)
Sandbox independently enableable; creds isolated; ticks stored separately in
sandbox_ticks; FYERS real ticks untouched; every record environment-identified;
on_real_data enforced; no cross-environment leakage by default; sandbox cannot
execute real orders nor reach live endpoints; sandbox never blocks FYERS;
tests prove isolation; docs explain later credential configuration.

