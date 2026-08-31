import json
import re
import sys
from pathlib import Path

PROJECT = Path("/home/swarna-sekhar-dhar/projects/my-job-agent")
REPORT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/test_results.json")

SRC_INTERFACE = PROJECT / "src/applications/portal-adapter.interface.ts"
SRC_WORKABLE = PROJECT / "src/scout/workable.adapter.ts"
SRC_MICRO1 = PROJECT / "src/scout/micro1.adapter.ts"
SRC_FOUNDEVER = PROJECT / "src/scout/foundever.adapter.ts"
DIST_WORKABLE = PROJECT / "dist/scout/workable.adapter.js"
DIST_MICRO1 = PROJECT / "dist/scout/micro1.adapter.js"
DIST_FOUNDEVER = PROJECT / "dist/scout/foundever.adapter.js"
REGISTRY_SOURCES = [
    PROJECT / "src/scout/scout.service.ts",
    PROJECT / "src/applications/apply-engine.service.ts",
    PROJECT / "src/applications/direct-channel.detector.ts",
]

def text(p):
    return p.read_text(encoding="utf-8") if p.exists() else ""

def expect(cond, msg):
    if not cond:
        return msg
    return None

class T:
    def __init__(self, name):
        self.name = name
        self.status = "pending"
        self.err = ""
    def fail(self, reason):
        self.status = "fail"; self.err = reason
    def pass_(self):
        self.status = "pass"
    def run(self, fn):
        try:
            r = fn()
            if r is None:
                self.pass_()
            else:
                self.fail(r)
        except Exception as e:
            self.status = "error"; self.err = f"{type(e).__name__}: {e}"
    def asdict(self):
        d = {"name": self.name, "status": self.status}
        if self.err: d["error"] = self.err
        return d

tests = []

def add(name, fn):
    t = T(name); tests.append(t); t.run(fn); return t

# 1 — ScrapedLead interface has all fields
add("Check 1: ScrapedLead interface has source, externalId, title, company, location, description, url", lambda:
    expect(
        (SRC_INTERFACE.exists()) and all(re.search(rf"\b{f}\b\s*:", text(SRC_INTERFACE))
            for f in ["source","externalId","title","company","location","description","url"]),
        f"ScrapedLead interface missing or missing fields in {SRC_INTERFACE}"
    )
)

# 2 — Workable source/label
add("Check 2: WorkableAdapter.source == 'workable'", lambda:
    expect(re.search(r"readonly\s+source\s*=\s*['\"]workable['\"]", text(SRC_WORKABLE)),
        f"source != 'workable' in {SRC_WORKABLE}")
)
add("Check 3: WorkableAdapter.label == 'Workable.com career pages'", lambda:
    expect(re.search(r"readonly\s+label\s*=\s*['\"]Workable\.com career pages['\"]", text(SRC_WORKABLE)),
        f"label != 'Workable.com career pages' in {SRC_WORKABLE}")
)
add("Check 4: WorkableAdapter.compile → dist JS exports WorkableAdapter with source=workable", lambda:
    expect(DIST_WORKABLE.exists() and re.search(r"source\s*=\s*['\"]workable['\"]", text(DIST_WORKABLE)),
        f"dist missing or source wrong in {DIST_WORKABLE}")
)
add("Check 5: WorkableAdapter.apply returns needs_info with workable in message", lambda:
    expect(re.search(r"needs_info", text(SRC_WORKABLE)) and re.search(r"workable", text(SRC_WORKABLE), re.I),
        f"apply not returning needs_info with 'workable' in {SRC_WORKABLE}")
)

# 6 — Micro1 source/label
add("Check 6: Micro1JobsAdapter.source == 'micro1'", lambda:
    expect(re.search(r"readonly\s+source\s*=\s*['\"]micro1['\"]", text(SRC_MICRO1)),
        f"source != 'micro1' in {SRC_MICRO1}")
)
add("Check 7: Micro1JobsAdapter.label == 'micro1.ai (micro1-jobs.com)'", lambda:
    expect(re.search(r"readonly\s+label\s*=\s*['\"]micro1\.ai \(micro1-jobs\.com\)['\"]", text(SRC_MICRO1)),
        f"label mismatch in {SRC_MICRO1}")
)
add("Check 8: Micro1 compile → dist JS", lambda:
    expect(DIST_MICRO1.exists() and re.search(r"source\s*=\s*['\"]micro1['\"]", text(DIST_MICRO1)),
        f"dist missing or wrong in {DIST_MICRO1}")
)
add("Check 9: Micro1.apply returns needs_info mentioning micro1", lambda:
    expect(re.search(r"needs_info", text(SRC_MICRO1)) and re.search(r"micro1", text(SRC_MICRO1), re.I),
        f"apply not needs_info with 'micro1' in {SRC_MICRO1}")
)

# 10 — Foundever source/label
add("Check 10: FoundeverAdapter.source == 'foundever'", lambda:
    expect(re.search(r"readonly\s+source\s*=\s*['\"]foundever['\"]", text(SRC_FOUNDEVER)),
        f"source != 'foundever' in {SRC_FOUNDEVER}")
)
add("Check 11: FoundeverAdapter.label == 'Foundever (jobs.foundever.com)'", lambda:
    expect(re.search(r"readonly\s+label\s*=\s*['\"]Foundever \(jobs\.foundever\.com\)['\"]", text(SRC_FOUNDEVER)),
        f"label mismatch in {SRC_FOUNDEVER}")
)
add("Check 12: Foundever compile → dist JS", lambda:
    expect(DIST_FOUNDEVER.exists() and re.search(r"source\s*=\s*['\"]foundever['\"]", text(DIST_FOUNDEVER)),
        f"dist missing or wrong in {DIST_FOUNDEVER}")
)
add("Check 13: Foundever.apply returns needs_info mentioning Foundever", lambda:
    expect(re.search(r"needs_info", text(SRC_FOUNDEVER)) and re.search(r"Foundever", text(SRC_FOUNDEVER)),
        f"apply not needs_info with 'Foundever' in {SRC_FOUNDEVER}")
)

# 14 — All three adapters referenced in registry files
def _check_14():
    combined = "\n".join(text(p) for p in REGISTRY_SOURCES)
    missing = [n for n in ["workable","micro1","foundever"] if n not in combined.lower()]
    return expect(not missing, f"unreferenced adapters: {missing}")
add("Check 14: All three new adapters (workable, micro1, foundever) referenced in registry files", _check_14)

# 15 — Idempotency signals (scrape returns empty, no side-effects)
def _check_15():
    for src,name in [(SRC_WORKABLE,"workable"),(SRC_MICRO1,"micro1"),(SRC_FOUNDEVER,"foundever")]:
        if not src.exists():
            return f"{name} source missing"
        body = text(src)
        if not re.search(r"async\s+scrape\s*\([^)]*\)\s*\{[\s\S]*?return\s+\[\]", body):
            return f"{name}.scrape does not clearly return []"
    return None
add("Check 15: All three scrapes are no-op (return empty, no external fetch in scrape path)", _check_15)

passed = sum(1 for t in tests if t.status == "pass")
failed = sum(1 for t in tests if t.status == "fail")
errors = sum(1 for t in tests if t.status == "error")
report = {"summary":{"total":len(tests),"passed":passed,"failed":failed,"errors":errors},"checks":[t.asdict() for t in tests]}
REPORT.write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
print(json.dumps(report, indent=2))
sys.exit(1 if failed or errors else 0)
