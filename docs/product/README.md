# Product documentation — C++ options trading engine

**Repository:** `my-job-agent` (C++ engine subtree)
**Branch:** `feat/cpp-trading-agent`
**Baseline revision:** `05130a9`
**Document set revision:** 1.0

---

## Purpose of this set

This package is the professional specification set for the C++ paper-trading
engine: requirements, technical design, learning methods, and roadmap.

It is **derived from the source at the baseline revision**, not transcribed from
earlier prose. Every substantive claim carries a `file:line` reference so a
reader can verify it without trusting this document.

## Why a new set exists

Three conflicting documents already occupied this space:

| Existing file | Actual subject | Disposition |
|---|---|---|
| `docs/REQUIREMENTS.md` | The TypeScript job-search agent (`my-job-agent`) | Superseded for this component — wrong system |
| `docs/PROJECT_DETAILS.md` | The TypeScript job-search agent | Superseded for this component — wrong system |
| `docs/REQUIREMENTS_AND_ARCHITECTURE.md` | This engine, but aspirational | Superseded — claims not supported by code |

`REQUIREMENTS_AND_ARCHITECTURE.md` asserts a CI pipeline with a latency gate and
SSH deployment, a 15–20 MB RSS target, and a promotion path from paper to live
execution. The workflow file has **no latency step** and its deploy job is
hard-disabled with `if: false` (`.github/workflows/cpp-agent-ci-cd.yml:165-173`).
Treat that document as historical intent, not current state.

---

## Status legend

Every requirement and module in this set carries one of these markers. They are
**not** interchangeable, and collapsing them is the failure mode this legend
exists to prevent.

| Marker | Meaning |
|---|---|
| **SPECIFIED** | Described in a document or header comment; no evidence it executes. |
| **IMPLEMENTED** | The code exists, compiles, and has a callable entry point. |
| **TESTED** | Exercised by a test target in `tests/`; the test passes. |
| **WIRED** | Reached by the production runtime path starting at `src/main.cpp`. |

A module can be IMPLEMENTED and TESTED but **not WIRED**. Several central ones are.

---

## Reading order

1. **[SRS.md](SRS.md)** — what the system must do, with per-requirement status.
2. **[TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md)** — how it is built: processes, modules, data, interfaces.
3. **[LEARNING_METHODS.md](LEARNING_METHODS.md)** — every statistical/learning method, its maths, and whether it runs.
4. **[ROADMAP.md](ROADMAP.md)** — gate-by-gate state and the prioritised next actions.

---

## The one fact to read first

**The gate research pipeline (G0–G22) is not wired into the runtime.** All
twelve pipeline modules compile into the production binary via
`file(GLOB_RECURSE ENGINE_SOURCES "src/engine/*.cpp")` (`CMakeLists.txt:41`) and
`add_executable(cpp-trading-agent ...)` (`CMakeLists.txt:44`), but a repository-wide
search for every gate class name returns no call site outside the gate files
themselves. `src/main.cpp` (lines 20–172) never references a gate, and
`src/engine/native_paper_runtime.cpp` (lines 1–8, 142–283) includes no gate header.

The only executable ordering that exists is the assertion sequence in
`tests/unit_and_integration_tests.cpp`. No gate output is consumed by any
decision, order, or persistence path.

Consequence for the reader: everything in `LEARNING_METHODS.md` describes
**methods that are implemented and unit-tested but not in the live loop**, with
the single exception of `adaptive_policy`, which is wired but pinned to its
exploratory branch. The roadmap treats closing that gap as the primary
engineering item.

---

## Evidence discipline

- Claims cite `path:line`, resolved against `05130a9`.
- Where a claim could not be verified from source, it is marked **UNVERIFIED**
  in the body rather than asserted.
- Where a documented behaviour contradicts the code, both are reported and the
  code governs.
- No credential values appear in this set; configuration is referenced by key
  name only.

## Maintenance

This set is versioned with the code. When behaviour changes, update the affected
document in the same commit as the change, and bump the document set revision.
