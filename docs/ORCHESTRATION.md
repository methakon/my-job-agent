# ORCHESTRATION.md

## Rule 27 — heavy work runs outside the trading window

**Operator's reconstruction (2026-10-15), not the original wording:**
Heavy work (deploys, restarts, full test suites) runs only after trading and post-market analysis
finish. Keep system load low in both trading and non-trading sessions. Docs-only commits are exempt.

**The user's original words, verbatim:**
> deployment and testing time after trading and post market analysis is finish also take care of
> system load during trading session and non trading session.

**How this repo applies it:**
- Deploys, engine restarts and full regression suites wait until after post-market analysis.
- Load is managed in *both* states: an idle trading session is not a licence to run heavy jobs.
- Docs-only commits (no `src/`, no behavioural change) are exempt from the timing rule.
- Because the local MySQL instance on 3306 is shared with `land_record`, local test runs are
  themselves "system load" — concurrency stress runs are not free just because they are local.

**Discovered the hard way (2026-10-15):** a 16-thread contention stress test was run repeatedly
against that shared local instance during a live session. It never touched the Oracle VM, but it
did contend with `land_record` on the same server. Rule 27 covers this case explicitly.
