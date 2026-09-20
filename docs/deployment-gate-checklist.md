# Deployment Gate Checklist (Category E)
## These items stop at the deployment gate — implementation ready, marking blocked until live.

### Gate 362: Stability Across Multiple Regimes
- Status: Code ready — requires multi-regime validation
- Evidence needed: Demonstrate strategy stability across trending, ranging, volatile regimes
- Prerequisite: Monday live data for regime classification

### Gate 365: Reproducible Release Artifact + Pinned Versions
- Status: Build pipeline exists (npm run build, nest build)
- Evidence needed: Pin model/risk versions in config, create release artifact
- Action: Create release tag + version manifest

### Gate 368: Working Kill Switch + Order Deduplication
- Status: Emergency controller exists (emergency-trading.controller.ts)
- Evidence needed: Kill switch test passes, dedup logic verified
- Action: Verify existing emergency controller works

### Gate 371: Approved Micro-Capital + Fixed Loss Limits
- Status: Risk limits in .env, paper trading active
- Evidence needed: Operator-approved capital allocation
- BLOCKED: Requires explicit operator decision

### Gate 374: Review Early Live Results
- Status: Process gate — requires live results to review
- BLOCKED: Requires Monday live trading results
