# Roadmap Classification Evidence — pg_monitor/checks.py backup freshness finding

## Finding
File: `pg_monitor/checks.py`
Range: lines 296-312 (dbreach_monitor check)
Issue: backup freshness staleness check is logged but does NOT affect the `completed` flag;
       a stale backup file still produces `completed=True` if the file exists and DB is reachable.

## Classification
**OUT_OF_SCOPE**

## Roadmap ID
NONE

## Acceptance Criterion
NONE

## Evidence
### Authoritative roadmap source
Table: `job_application_roadmap_items` (Job Agent DB, SSH tunnel 127.0.0.1:3307 → 10.0.0.99:3306, database=myjob_agent)

All 40 Job Agent roadmap items were queried. The complete item list is Job Application roadmap work: baseline audit, submission sandbox safety, regression baseline, qualification engine, eligibility, JD intent, candidate evidence, semantic skill matching, skill-gap severity, career fit, job quality, application ROI, explainability, near-miss rescue, evidence library, CV strategy, CV tailoring, semantic-drift protection, ATS scoring, channel learning, ATS question discovery, browser field mapping, deduplication, employer intelligence, recruiter memory, rejection learning, interview/offer learning, confidence calibration, template tracking, template performance, CV strategy learning, application lifecycle, portal status polling, follow-up automation, precision queue, decision/explanation UI, application digest, closed-loop learning, learning safety, KPI dashboard.

### Keyword search against all items
Searched every item's `item` + `doneWhen` fields for: pg, backup, monitor, database, postgres, reliability, persistence, data-loss.

Result: **no Job Agent roadmap item addresses database backup monitoring, PostgreSQL backup freshness, or pg_monitor subsystem.**

The only keyword-adjacent item is:
- JA-054 "Confidence calibration" — "Calibration metrics are available and monitored."
  - This is about confidence-score calibration metrics for the job application decision pipeline.
  - It does NOT cover database backup monitoring, PostgreSQL, or pg_monitor.
  - It is a Job Agent decision-quality metric, not infrastructure monitoring.

### Subsystem identification
`pg_monitor/` is a PostgreSQL backup monitoring subsystem. This is infrastructure/operations monitoring, not Job Application roadmap functionality. The Job Agent roadmap tracks job-application-domain capabilities: qualification, application preparation, submission, follow-up, learning, and decision support. Database backup freshness is an infrastructure reliability concern outside that scope.

## Decision
**Do NOT generate Job Agent implementation work for this finding.**

This finding belongs to a different workstream (infrastructure/operations monitoring). It should NOT be classified as Job Agent work merely because it exists in the same repository. Classifying it as Job Agent work would be scope drift.

## Recommended handling
- If the repository has a separate infrastructure/operations roadmap or backlog, file this finding there.
- If no such roadmap exists, flag the finding to the operator as "infrastructure workstream — not Job Agent" and ask where it should be tracked.
- Do NOT modify `pg_monitor/checks.py` from the Job Agent worker unless and until this is explicitly reclassified as IN_SCOPE or INDIRECT_DEPENDENCY for a specific Job Agent acceptance criterion.

## Classification timestamp
2026-09-18 (IST)

## Classification made by
Job Agent Worker (read-only, evidence-based, no guessing)
