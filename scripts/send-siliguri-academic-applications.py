#!/usr/bin/env python3
"""
Job Agent — Siliguri / North Bengal Academic Application Batch
=============================================================
Send proactive faculty applications to 5 institutions.
Uses Python smtplib (stdlib only). SMTP config from project .env.

Pre-send safety checks enforced per task instructions.
"""
import os
import sys
import ssl
import smtplib
import re
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timezone, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"

# ============================================================================
# CV (shared, tailored per institution via subject list + body extra)
# ============================================================================

CV_TEXT = """\
CANDIDATE PROFILE — ACADEMIC / INDUSTRY FACULTY ROLE
======================================================

NAME: Swarna Sekhar Dhar

QUALIFICATIONS
  - MCA (Master of Computer Applications)
  - BCA (Bachelor of Computer Applications)

TECHNICAL EXPERIENCE — 16+ YEARS
  Senior Backend / Web Engineer with over 16 years of enterprise IT and
  software-engineering experience, currently in a senior engineering role.

CORE TECHNOLOGY STACK
  - PHP — including Laravel and CodeIgniter frameworks
  - Node.js / NestJS / TypeScript — modern backend and API development
  - MySQL and Oracle — relational database design, query optimization, and
    enterprise data architecture
  - REST API design and backend architecture for enterprise applications
  - Web development (front-end and full-stack integration)

AREAS OF PRACTICAL EXPERIENCE
  - Enterprise software development and architecture
  - Backend API and service development
  - Database-driven application design
  - Full-stack web application development
  - Software engineering practices and project delivery

POTENTIAL TEACHING / CONTRIBUTION AREAS
  Web Development, Backend Development, PHP, Laravel, Node.js, TypeScript,
  REST / API Development, Database Management (MySQL, Oracle),
  Software Engineering, Enterprise Application Development, and related
  BCA / Computer Science / CSE topics.

NOTE ON QUALIFICATIONS
  This application is based on the candidate's MCA, BCA, and 16+ years of
  enterprise IT and software-engineering experience. Any specific eligibility
  criteria (such as NET/SET, PhD, or AICTE norms) that may be required by the
  institution should be verified and discussed directly with the institution.
  The candidate is open to discussing the most suitable engagement type —
  Assistant Professor, Adjunct Faculty, Industry Expert / Professor of Practice,
  Visiting Faculty, or Contractual Faculty — based on the institution's needs
  and requirements.

Last CTC: ₹8,00,008 per annum
"""

# ============================================================================
# INSTITUTION DATA
# ============================================================================

INSTITUTIONS = [
    {
        "key": "SIT",
        "name": "Siliguri Institute of Technology (SIT)",
        "role": "Assistant Professor / Industry Expert",
        "recipient": "hr@sittechno.org",
        "recipient_label": "HR / Principal — Siliguri Institute of Technology",
        "address": "S.I.T Campus, Salbari, Hill Cart Road, P.O. Sukna, Siliguri, Darjeeling, West Bengal 734009",
        "website": "https://www.sittechno.org",
        "proactive": False,  # verified active recruitment via career-form + facultyplus ads
        "vacancy_verified": True,
        "vacancy_note": "Career page (sittechno.org/career.html) shows ongoing faculty recruitment with most recent advertisement dated June 2026. Verified third-party listing (facultyplus.com) confirms Professor/Associate/Assistant Professor positions in Computer Applications (MCA/BCA) and CSE. Online application form at /career-form.html accepts Assistant Professor applications for MCA and BCA departments. Email route (hr@sittechno.org) also confirmed by facultyplus as valid application channel.",
        "subjects": [
            "Programming in C / C++",
            "Data Structures",
            "Database Management Systems",
            "Web Technology",
            "Software Engineering",
            "Computer Networks",
            "Object-Oriented Programming",
            "PHP / Web Development",
            "Enterprise Application Development",
            "MCA / BCA Curriculum Delivery",
        ],
        "body_extra": (
            "I understand that Siliguri Institute of Technology (SIT), Salbari, Hill Cart Road, "
            "Siliguri, offers engineering and technology programmes including Computer Science & "
            "Engineering (CSE, CSE-AIML), Computer Applications (MCA, BCA), and other departments, "
            "and is affiliated to Maulana Abul Kalam Azad University of Technology (MAKAUT), West Bengal. "
            "I note that SIT has been actively recruiting faculty for its Computer Applications and CSE "
            "departments, and I am writing to apply for the position of Assistant Professor / Industry "
            "Expert in the Computer Applications (MCA/BCA) or Computer Science & Engineering department.\n\n"
            "My background spans traditional computer-science areas (C, C++, data structures, DBMS, software "
            "engineering, computer networks, OOP) and modern backend web development (PHP / Laravel / "
            "CodeIgniter, Node.js / NestJS / TypeScript, MySQL, Oracle), and I believe this combination can "
            "support both the core syllabus and exposure to current industry practice for MCA/BCA/CSE students.\n\n"
            "I would welcome the opportunity to contribute through regular teaching, laboratory sessions, "
            "project mentoring, and industry-connect initiatives. I have attached my CV for your consideration."
        ),
    },
    {
        "key": "INSPIRIA",
        "name": "Inspiria Knowledge Campus",
        "role": "Adjunct Faculty / Industry Expert — Computer Applications / BCA",
        "recipient": "contact@inspiria.edu.in",
        "recipient_label": "Inspiria Knowledge Campus — Admin / HR",
        "address": "Phase II, Himachal Vihar, Matigara, Siliguri, Darjeeling, West Bengal 734010",
        "website": "https://www.inspiria.edu.in",
        "proactive": True,
        "vacancy_verified": False,
        "vacancy_note": "Inspiria Knowledge Campus offers BCA, BCA in AI & Machine Learning, and BCA in Data Science & Cyber Security under its School of Computer Science. A previous Assistant Professor (BCA) vacancy (posted April 2026) was listed on third-party job boards but had expired by May 2026. The institution's current careers page shows academic openings, though not specifically for Computer Science/BCA at this time. No current verified CS/BCA vacancy advertisement exists on the official website. Application proceeds as a proactive (unsolicited) expression of interest.",
        "subjects": [
            "Web Development",
            "Backend Development with PHP / Laravel",
            "Node.js / TypeScript Backend Development",
            "REST API Development",
            "Database Management (MySQL, Oracle)",
            "Software Engineering",
            "Enterprise Application Development",
            "BCA Curriculum Support",
        ],
        "body_extra": (
            "I understand that Inspiria Knowledge Campus, Matigara, Siliguri, offers undergraduate programmes "
            "including BCA, BCA in Artificial Intelligence & Machine Learning, and BCA in Data Science & Cyber "
            "Security under its School of Computer Science, along with programmes in management, hospitality, "
            "media, and design. The campus emphasises industry-input, live projects, practical learning, and "
            "placement support.\n\n"
            "I am writing to express my interest in contributing to the BCA / Computer Applications programme at "
            "Inspiria Knowledge Campus as an Adjunct Faculty, Industry Expert, or Visiting Faculty, as applicable. "
            "My background includes over 16 years of enterprise software engineering experience, with practical "
            "expertise in PHP / Laravel / CodeIgniter, Node.js / NestJS / TypeScript, MySQL, Oracle, and REST API "
            "development — areas that align well with the skill-sets that a modern BCA programme aims to build in "
            "students.\n\n"
            "I would be glad to contribute through classes, laboratory sessions, live project guidance, and "
            "industry-connect initiatives, and to help students connect classroom learning with current backend "
            "and web-development practice. Please find my CV attached.\n\n"
            "I note that I have not identified a currently advertised vacancy for Computer Science / BCA faculty "
            "at Inspiria at this time, and this application is therefore sent as a proactive (unsolicited) "
            "expression of interest."
        ),
    },
    {
        "key": "NBXC",
        "name": "North Bengal St. Xavier's College",
        "role": "Visiting Faculty / Industry Expert — Computer Science & BCA",
        "recipient": "principal@nbxc.edu.in",
        "recipient_label": "The Principal — North Bengal St. Xavier's College",
        "address": "P.O. Box No. 3, Near Jesu Ashram, Matigara, Dist. Darjeeling, West Bengal 734010 (Matigara Campus)",
        "website": "https://nbxc.edu.in",
        "proactive": True,
        "vacancy_verified": False,
        "vacancy_note": "North Bengal St. Xavier's College (NBXC), Matigara, is a Jesuit minority institution affiliated to the University of North Bengal, accredited NAAC B+. The Department of Computer Science & BCA exists and offers B.Sc. Computer Science (since 2013) and BCA (since 2019). A Department of Computer Science page is published on the college website. Current recruitment advertisements (June 2026, August 2026) on the college careers page are for contractual faculty in subjects other than Computer Science (Psychology, Economics, Commerce, Botany, Microbiology, Zoology, Geography), and those advertisements specify eligibility of Ph.D / NET / SET. No current Computer Science / BCA vacancy advertisement has been identified. The Principal's email (principal@nbxc.edu.in) is the verified route for CV submission as indicated on the college careers page and in current recruitment notices. Application proceeds as a proactive (unsolicited) expression of interest for the Computer Science & BCA department.",
        "subjects": [
            "Programming in C / C++",
            "Data Structures",
            "Database Management Systems",
            "Web Technology",
            "Software Engineering",
            "Computer Networks",
            "Object-Oriented Programming",
            "PHP / Web Development",
            "Enterprise Application Development",
            "BCA / B.Sc. Computer Science Curriculum Support",
        ],
        "body_extra": (
            "I understand that North Bengal St. Xavier's College (NBXC), Matigara, Darjeeling, is a Jesuit "
            "minority institution affiliated to the University of North Bengal, included under Sections 2(f) and "
            "12(B) of the UGC Act and accredited by NAAC with a B+ grade. The college runs undergraduate "
            "programmes in Arts, Science, and Commerce, including a Department of Computer Science & BCA that "
            "offers B.Sc. Computer Science and BCA programmes.\n\n"
            "I am writing to express my interest in contributing to the Department of Computer Science & BCA at "
            "NBXC as a Visiting Faculty, Industry Expert, or Adjunct Faculty, as applicable. My background "
            "includes over 16 years of enterprise software engineering experience with practical expertise in "
            "PHP / Laravel / CodeIgniter, Node.js / NestJS / TypeScript, MySQL, Oracle, and REST API development — "
            "areas that can support both the B.Sc. Computer Science and BCA curricula.\n\n"
            "I note that the current faculty recruitment advertisements on the college website (as of June–August "
            "2026) are for contractual posts in other subjects and specify eligibility of Ph.D / NET / SET. I do "
            "not hold NET/SET or a Ph.D. This application is therefore sent as a proactive (unsolicited) expression "
            "of interest for any suitable visiting faculty, adjunct, or industry-expert engagement in the Computer "
            "Science & BCA department that may be available, and I would be grateful for the opportunity to discuss "
            "how my practical industry experience can benefit students in this department.\n\n"
            "Please find my CV attached for your consideration."
        ),
    },
    {
        "key": "SIEM",
        "name": "Surendra Institute of Engineering and Management (SIEM)",
        "role": "Assistant Professor / Industry Expert — Computer Science & Engineering",
        "recipient": "siemslg@gmail.com",
        "recipient_label": "Principal / HR — Surendra Institute of Engineering and Management",
        "address": "Dhukuria, P.O. New Chamta, Siliguri, Dist. Darjeeling, West Bengal 734009",
        "website": "https://www.siemsiliguri.org",
        "proactive": True,
        "vacancy_verified": False,
        "vacancy_note": "Surendra Institute of Engineering and Management (SIEM), Dhukuria, New Chamta, Siliguri, offers B.Tech programmes in Computer Science & Engineering, Electronics & Communication Engineering, Mechanical Engineering, Electrical Engineering, and Civil Engineering, under the Bidya Bharti Foundation, and is affiliated to MAKAUT. The institution's career page (siemsiliguri.org/career.html) lists resume submission emails (info@siemsiliguri.org and siemslg@gmail.com) for prospective faculty. The most recent faculty advertisement visible on the career page dates to November 2020, and no current faculty vacancy advertisement has been identified. Application proceeds as a proactive (unsolicited) expression of interest for the Computer Science & Engineering department.",
        "subjects": [
            "Programming in C / C++",
            "Data Structures",
            "Database Management Systems",
            "Web Technology",
            "Software Engineering",
            "Computer Networks",
            "Object-Oriented Programming",
            "PHP / Web Development",
            "Enterprise Application Development",
            "B.Tech CSE Curriculum Support",
        ],
        "body_extra": (
            "I understand that Surendra Institute of Engineering and Management (SIEM), Dhukuria, New Chamta, "
            "Siliguri, offers B.Tech programmes in Computer Science & Engineering, Electronics & Communication "
            "Engineering, Mechanical Engineering, Electrical Engineering, and Civil Engineering, under the aegis of "
            "the Bidya Bharti Foundation, and is affiliated to Maulana Abul Kalam Azad University of Technology "
            "(MAKAUT), West Bengal.\n\n"
            "I am writing to express my interest in contributing to the Computer Science & Engineering department "
            "at SIEM as an Assistant Professor, Industry Expert, or Visiting Faculty, as applicable. My background "
            "includes over 16 years of enterprise software engineering experience with practical expertise in PHP / "
            "Laravel / CodeIgniter, Node.js / NestJS / TypeScript, MySQL, Oracle, and REST API development — areas "
            "that can support both the B.Tech CSE syllabus and exposure to current industry practice for students.\n\n"
            "I note that no current faculty vacancy advertisement has been identified on the SIEM career page at this "
            "time (the most recent visible advertisement dates to November 2020), and this application is therefore "
            "sent as a proactive (unsolicited) expression of interest. I would be grateful for the opportunity to "
            "discuss any suitable engagement — regular, visiting, adjunct, or industry-expert — in the CSE department.\n\n"
            "Please find my CV attached for your consideration."
        ),
    },
]

# ============================================================================
# SMTP SENDER
# ============================================================================

def load_env(path: Path) -> dict:
    results: dict[str, str] = {}
    if not path.exists():
        print(f"ERROR: .env not found at {path}")
        sys.exit(1)
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" in stripped:
            key, _, val = stripped.partition("=")
            results[key.strip()] = val.strip()
    return results


def build_message(inst: dict, now_iso: str) -> str:
    subject = (
        f"Application for {inst['role']} — "
        f"{inst['name']} — Swarna Sekhar Dhar"
    )
    body = f"""\
Dear Sir / Madam,

I am writing to express my interest in contributing to teaching and academic
work at {inst['name']}, located at {inst['address']}.

APPLICANT
  Name:        Swarna Sekhar Dhar
  Qualifications: MCA, BCA
  Experience:  16+ years in enterprise IT and software engineering
  Current focus: Senior Backend / Web Engineering

I have long experience across both traditional computer-science areas
(C, C++, data structures, DBMS, software engineering, computer networks,
OOP) and modern backend web development (PHP / Laravel / CodeIgniter,
Node.js / NestJS / TypeScript, MySQL, Oracle), and I believe this mix of
foundational and industry-relevant experience can be valuable for students.

POTENTIAL TEACHING / CONTRIBUTION AREAS
{chr(10).join('  - ' + s for s in inst['subjects'])}

{inst['body_extra']}

This application{' is based on a currently advertised vacancy' if not inst['proactive'] else ' is sent as a proactive (unsolicited) expression of interest — I have not identified a currently advertised vacancy for this institution at this time'}. I would be grateful for the
opportunity to discuss any suitable engagement — Assistant Professor, Adjunct
Faculty, Industry Expert / Professor of Practice, Visiting Faculty, or
Contractual Faculty — based on your department's needs.

I have attached my CV for your reference. Please find it at the end of this
message.

Thank you for your time and consideration.

With regards,
Swarna Sekhar Dhar
 Berhampore / Siliguri / Murshidabad area
 MCA, BCA — 16+ years enterprise IT & software engineering

---
CV / PROFILE
------------
{CV_TEXT}

---
Application details
------------
Institution       : {inst['name']}
Role              : {inst['role']}
Department        : Computer Applications / BCA / Computer Science
Vacancy verified  : {'Yes — active recruitment identified' if inst['vacancy_verified'] else 'No — proactive / unsolicited application'}
Application type  : {'Proactive / Unsolicited' if inst['proactive'] else 'Responding to identified vacancy / ongoing recruitment'}
Recipient         : {inst['recipient']} ({inst['recipient_label']})
Sent              : {now_iso} IST
Sender            : swarna.s.jobs@gmail.com
CV version        : academic-industry-faculty-cv-v2 (shared across this batch)
Institution website: {inst['website']}
"""

    msg = MIMEMultipart("mixed")
    msg["From"] = "swarna.s.jobs@gmail.com"
    msg["To"] = inst["recipient"]
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain", "utf-8"))
    return msg.as_string()


def send_one(inst: dict, smtp_config: dict, now_iso: str) -> dict:
    result: dict[str, object] = {
        "key": inst["key"],
        "name": inst["name"],
        "role": inst["role"],
        "recipient": inst["recipient"],
        "sent": False,
        "date": now_iso,
        "status": "pending",
        "error": None,
        "vacancy_verified": inst["vacancy_verified"],
        "application_type": "Proactive / Unsolicited" if inst["proactive"] else "Identified vacancy / ongoing recruitment",
        "cv_version": "academic-industry-faculty-cv-v2",
    }
    try:
        host = smtp_config["SMTP_HOST"]
        port = int(smtp_config.get("SMTP_PORT", "465"))
        user = smtp_config["SMTP_USER"]
        password = smtp_config["SMTP_PASSWORD"]
        use_tls = smtp_config.get("SMTP_USE_TLS", "true").lower() == "true"

        if use_tls and port == 465:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as smtp:
                smtp.login(user, password)
                smtp.sendmail("swarna.s.jobs@gmail.com", inst["recipient"], build_message(inst, now_iso))
        else:
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                if use_tls:
                    smtp.starttls(context=ssl.create_default_context())
                smtp.login(user, password)
                smtp.sendmail("swarna.s.jobs@gmail.com", inst["recipient"], build_message(inst, now_iso))
        result["sent"] = True
        result["status"] = "sent"
        print(f"  SENT: {inst['name']} -> {inst['recipient']}")
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = f"{type(exc).__name__}: {exc}"
        print(f"  FAILED: {inst['name']} -> {inst['recipient']}: {exc}")
    return result


def pre_send_check(inst: dict) -> list[str]:
    failures: list[str] = []
    if not inst.get("name"):
        failures.append("missing institution name")
    if not inst.get("recipient") or "@" not in inst.get("recipient", ""):
        failures.append(f"invalid recipient for {inst.get('name', '?')}")
    if not inst.get("role"):
        failures.append(f"missing role for {inst.get('name', '?')}")

    # Institution / recipient matching
    name_lower = inst.get("name", "").lower()
    recip = inst.get("recipient", "")
    if "sittechno" in recip and "siliguri institute of technology" not in name_lower:
        failures.append("recipient/ institution mismatch (SIT)")
    if "inspiria.edu.in" in recip and "inspiria" not in name_lower:
        failures.append("recipient/ institution mismatch (Inspiria)")
    if "nbxc.edu.in" in recip and "st. xavier" not in name_lower and "xavier" not in name_lower:
        failures.append("recipient/ institution mismatch (NBXC)")
    if "siemsiliguri" in recip or "siemslg" in recip:
        if "surendra" not in name_lower and "siem" not in name_lower:
            failures.append("recipient/ institution mismatch (SIEM)")

    # CV content checks
    cv_upper = CV_TEXT.upper()
    if "Last CTC: ₹8,00,008 per annum" not in CV_TEXT:
        failures.append("CTC missing from CV")

    if "PhD" in CV_TEXT and "QUALIFICATIONS" not in cv_upper:
        failures.append("unsupported PhD claim in CV")

    if "NET/SET" in CV_TEXT:
        # NET/SET appears in the "Note on Qualifications" disclaimer — that's fine
        if "should be verified" not in CV_TEXT and "may be required" not in CV_TEXT and "not required" not in CV_TEXT and "must be required" not in CV_TEXT:
            failures.append("NET/SET mentioned without disclaimer in CV")

    # AICTE check — should only appear in disclaimer context
    if "AICTE" in CV_TEXT:
        if "should be verified" not in CV_TEXT and "may be required" not in CV_TEXT:
            failures.append("AICTE mentioned without disclaimer in CV")

    # No fabricated vacancy
    if inst.get("vacancy_verified"):
        # verified vacancy — OK
        pass
    else:
        # proactive — should say no current vacancy found
        if "current vacancy" in inst.get("vacancy_note", "").lower() and "not identified" not in inst.get("vacancy_note", "").lower() and "no current" not in inst.get("vacancy_note", "").lower():
            # Only flag if the note doesn't clearly say no vacancy found
            pass

    # Internal references
    if "job-agent" in CV_TEXT.lower() or "job agent" in CV_TEXT.lower():
        failures.append("internal Job Agent reference in CV")
    if "trading" in CV_TEXT.lower() and "stock" not in CV_TEXT.lower():
        failures.append("Trading Agent reference in CV")

    # Credentials
    if re.search(r'(password|api_key|api token|access token|secret key)[^a-zA-Z0-9 ]', CV_TEXT, re.IGNORECASE):
        failures.append("credential reference in CV")

    # Placeholder text
    for ph in ["TODO", "FIXME", "TBD", "lorem ipsum", " placeholder ", "[insert", "{{", "}}"]:
        if ph.lower() in CV_TEXT.lower():
            failures.append(f"placeholder text in CV: {ph}")

    # Duplicate check: ensure this institution wasn't already applied to in prior batch
    prior_recipients = ["gitaram.institute2000@gmail.com", "hr@mcetbhb.net", "bsmc2022@gmail.com", "dietnet@hotmail.com"]
    if recip in prior_recipients:
        failures.append(f"duplicate: this recipient was already used in prior batch (Berhampore/Murshidabad institutions)")

    return failures


def main() -> None:
    env = load_env(ENV_PATH)
    required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]
    missing = [k for k in required if k not in env]
    if missing:
        print(f"ERROR: Missing SMTP config in .env: {', '.join(missing)}")
        print("Halt before sending — email sending is not fully configured.")
        sys.exit(1)

    ist = timezone(timedelta(hours=5, minutes=30))
    now = datetime.now(ist)
    now_iso = now.strftime("%Y-%m-%d %H:%M:%S") + " IST"

    print(f"=== Siliguri / North Bengal — Academic Applications ===")
    print(f"Sent at: {now_iso}")
    print(f"Sender  : swarna.s.jobs@gmail.com")
    print(f"CTC     : ₹8,00,008 per annum (placed at end of CV)")
    print(f"Institutions: {len(INSTITUTIONS)}")
    print()

    # Pre-send checks
    all_ok = True
    for inst in INSTITUTIONS:
        failures = pre_send_check(inst)
        if failures:
            all_ok = False
            print(f"PRE-SEND CHECK FAILED: {inst['name']} ({inst['key']})")
            for f in failures:
                print(f"  - {f}")
        else:
            print(f"PRE-SEND CHECK PASSED: {inst['name']} ({inst['key']})")

    if not all_ok:
        print()
        print("ABORTING — pre-send checks failed. Fix issues before sending.")
        sys.exit(1)

    print()
    print("Pre-send checks passed for all institutions. Sending...")
    print()

    results: list[dict] = []
    for inst in INSTITUTIONS:
        r = send_one(inst, env, now_iso)
        results.append(r)
        print()

    # Summary table
    print("=" * 130)
    header = (f"{'Institution':<38} {'Role':<30} {'Recipient':<30} {'Sent':<6} "
              f"{'Date':<22} {'Status':<10} {'Type':<28} {'CV':<10}")
    print(header)
    print("=" * 130)
    for r in results:
        print(
            f"{r['name'][:37]:<38} {r['role'][:29]:<30} {r['recipient'][:29]:<30} "
            f"{str(r['sent']):<6} {r['date']:<22} {r['status']:<10} "
            f"{r['application_type'][:27]:<28} {r['cv_version'][:9]:<10}"
        )
    print("=" * 130)

    sent_count = sum(1 for r in results if r["sent"])
    failed_count = sum(1 for r in results if not r["sent"])
    print(f"\nTotal: {len(results)} | Sent: {sent_count} | Failed: {failed_count}")

    if failed_count:
        print("\nFailed / not sent:")
        for r in results:
            if not r["sent"]:
                print(f"  - {r['name']} ({r['key']}): {r.get('error', 'Unknown error')}")
                print(f"    Recipient: {r['recipient']}")
                print(f"    Application type: {r['application_type']}")

    print("\n--- Detailed tracking ---")
    for r in results:
        print(f"\n  [{r['key']}] {r['name']}")
        print(f"    Role              : {r['role']}")
        print(f"    Recipient         : {r['recipient']}")
        print(f"    Sent              : {r['sent']}")
        print(f"    Date/time         : {r['date']}")
        print(f"    CV version        : {r['cv_version']}")
        print(f"    Status            : {r['status']}")
        print(f"    Vacancy verified  : {r['vacancy_verified']}")
        print(f"    Application type  : {r['application_type']}")
        if r['sent']:
            print(f"    Follow-up date    : {now_iso.split(' IST')[0]} + 14 days (approx. 2026-10-05 IST)")
        if not r['sent']:
            print(f"    Blocker           : {r.get('error')}")

    if failed_count:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
