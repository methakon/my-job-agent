# Skill Card Template

> Items 137–149. Every strategy/signal must have a skill card documenting its behavior,
> effectiveness, lifecycle, and micro-failure history.

## Naming Convention (Item 137)

```
SK-{category}-{name}
```

- **category**: `GAP`, `ORB`, `VA`, `OPTION`, `MICRO`, `REGIME`, `EVENT`
- **name**: camelCase descriptive name
- Examples: `SK-GAP-fadeWithReversal`, `SK-ORB-breakoutToTarget`, `SK-VA-bounceFromPOC`

## Mandatory Fields (Item 138)

```yaml
skill_id: SK-{category}-{name}
version: "1.0.0"
status: ACTIVE | DECAYED | RETIRED
category: GAP | ORB | VA | OPTION | MICRO | REGIME | EVENT
created: 2026-09-19
description: >
  One-line description of what this skill represents.

# Conditions
regime_filter: [trend, range]           # regime families where this skill applies
min_volume: 50000                       # minimum session volume
min_atr: 2.0                           # minimum ATR for activation
session_filter: [pre_open, opening, mid] # session phases

# Entry/Exit
entry_type: LIMIT | MARKET | STOP
entry_offset_atr: 0.5                  # ATR-based entry offset
stop_loss_atr: 1.0                     # ATR-based stop
target_atr: 2.0                        # ATR-based target
time_stop_minutes: 45                  # maximum hold time

# Sizing
risk_per_trade_pct: 0.5               # % of equity risked
max_position_pct: 5.0                  # max % of equity in position
```

## Result Tracking (Item 139)

```yaml
# After each trade
result:
  entry_time: "2026-09-19T09:30:00+05:30"
  exit_time: "2026-09-19T10:15:00+05:30"
  entry_price: 25000
  exit_price: 25200
  pnl: 200
  pnl_pct: 0.8
  mae: -150
  mae_pct: -0.6
  mfe: 300
  mfe_pct: 1.2
  r_multiple: 2.0                      # PnL / risk
  hold_minutes: 45
```

## Effectiveness Decay (Item 140)

Skills have a half-life tracked via rolling-window statistics:

```yaml
effectiveness:
  window_trades: 20                    # rolling window size
  win_rate: 0.65
  avg_r_multiple: 0.8
  sharpe_20: 1.2
  decay_flag: false                    # set true when metrics fall below threshold
  decay_threshold_win_rate: 0.45
  decay_threshold_sharpe: 0.3
```

## Version Lifecycle (Item 141)

```
v1.0.0 → v1.0.1 (fix) → v1.1.0 (parameter change) → v2.0.0 (structural change)
```

- **Minor**: parameter adjustment
- **Major**: structural change (different entry/exit logic)
- Previous versions archived with `status: RETIRED`

## Task History (Item 142)

```yaml
task_history:
  - session: "2026-09-19"
    action: "entry"
    result: "WIN"
    notes: "Clean gap fade, filled within 30 minutes"
  - session: "2026-09-18"
    action: "skipped"
    reason: "regime_filter: not in range"
```

## Display Style (Item 143)

At line speed, skill cards display as:

```
SK-GAP-fadeWithReversal v1.2 [ACTIVE] WR:62% R:0.8 Sharpe:1.1 | Last:WIN 2026-09-19
```

## Micro-Failure Blacklist (Item 144)

```yaml
micro_failures:
  - date: "2026-09-15"
    type: "SLIPPAGE"
    magnitude: 0.3
    notes: "Spread widened at entry"
  - date: "2026-09-12"
    type: "TIME_STOP"
    magnitude: 0.2
    notes: "Held too long, profit reversed"
blacklist_threshold: 3                  # 3 micro-failures → DECAYED status
```

## Skill Categories

| Category | Description | Example |
|----------|-------------|---------|
| GAP | Gap-based strategies | fade, follow, closer |
| ORB | Opening range breakout | breakout, false break |
| VA | Value area strategies | POC bounce, VA breakout |
| OPTION | Options-specific | IV crush, skew trade |
| MICRO | Microstructure signals | OBI shift, OFI spike |
| REGIME | Regime-dependent | trend-following, mean-revert |
| EVENT | Event-driven | RBI day, FOMC |

## Skill Card Lifecycle States

```
ACTIVE → DECAYED → RETIRED
                ↗ (re-analyzed) ↘
         ACTIVE ← DECAYED (if improved)
```
