#!/usr/bin/env python3
"""Send proactive academic-faculty application emails via Gmail SMTP.

Job Agent task - academic applications to 4 institutions around Berhampore, Murshidabad.
Uses Python smtplib (stdlib only, no external dependencies).

Prerequisites:
  - .env in project root with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD
  - Python 3.6+ (smtplib + email stdlib)
"""
import os
import sys
import ssl
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timezone, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"


def load_env(path: Path) -> dict:
    """Load simple KEY=VALUE pairs from a .env file."""
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


# ============================================================================
# Application data for the 4 institutions
# ============================================================================

APPLICATIONS = [
    {
        "institution": "Gitaram Institute of Management",
        "role": "Assistant Professor — BCA / Industry Expert",
        "recipient": "gitaram.institute2000@gmail.com",
        "recipient_name": "Gitaram Institute of Management — HR / Principal",
        "location": "NH-34, Radharghat, Murshidabad, Berhampore, West Bengal 742187",
        "proactive": True,
        "subjects": [
            "Programming in C / C++",
            "Database Management Systems",
            "Web Technology",
            "Software Engineering",
            "Computer Networks",
            "PHP / Web Development",
            "Enterprise Application Development",
        ],
        "body_extra": """I understand that Gitaram Institute of Management offers BCA, PGDM, and MBA programmes and is affiliated to Maulana Abul Kalam Azad University of Technology (MAKAUT), West Bengal. I would be keen to contribute to the BCA and computer-science-related teaching at the institute, and to share practical industry experience with students through regular classes, labs, and project guidance.

I have worked extensively with PHP-based web applications and modern JavaScript/TypeScript backend systems, and I believe this mix of traditional and contemporary software-development experience can be valuable for students learning both foundational and industry-relevant computer-science topics.

I would also be happy to discuss an Industry Expert / Professor of Practice / Adjunct Faculty arrangement if that is of interest to the institute."""
    },
    {
        "institution": "Murshidabad College of Engineering and Technology (MCET)",
        "role": "Assistant Professor — BCA / Computer Science / Industry Expert",
        "recipient": "hr@mcetbhb.net",
        "recipient_name": "MCET — Human Resources / Principal",
        "location": "2 No. Hatibandha Road, Cossimbazar Campus, P.O. Cossimbazar Raj, PS Berhampore, Murshidabad, West Bengal 742102",
        "proactive": True,
        "contacts": "hr@mcetbhb.net / mcet696@gmail.com",
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
        ],
        "body_extra": """I understand that Murshidabad College of Engineering and Technology (MCET), Cossimbazar, offers engineering and technology programmes and has previously advertised faculty positions through AICTE-approved channels (including on the AICTE ASN portal in the past).

I am writing to express my interest in contributing to BCA / Computer Science / CSE teaching at MCET as an Assistant Professor, Adjunct Faculty, or Industry Expert / Professor of Practice, as applicable. My background in both traditional software engineering (C, C++, data structures, DBMS, software engineering, computer networks) and modern backend web development (PHP/Laravel/CodeIgniter, Node.js/NestJS/TypeScript, MySQL, Oracle) can support both foundational and current-industry computer-science curricula.

I would welcome the opportunity to discuss how I can contribute to the department, including through regular teaching, laboratory sessions, project mentoring, and industry-connect initiatives."""
    },
    {
        "institution": "Berhampore Science and Management College (BSMC)",
        "role": "Assistant Professor — BCA / Industry Expert / Adjunct Faculty",
        "recipient": "bsmc2022@gmail.com",
        "recipient_name": "BSMC — Principal / HR",
        "location": "3/15/1 Girjapara Lane, Khagra, Berhampore, Murshidabad, West Bengal 742103",
        "proactive": True,
        "subjects": [
            "Programming in C / C++",
            "Database Management Systems",
            "Web Technology",
            "Software Engineering",
            "Computer Fundamentals",
            "PHP / Web Development",
            "Enterprise Application Development",
        ],
        "body_extra": """I understand that Berhampore Science and Management College (BSMC), Khagra, Berhampore, offers science and management programmes including BCA, and I am writing to express my interest in contributing to BCA and computer-science-related teaching at the college.

I have long experience in enterprise software development — including PHP-based web applications, modern JavaScript/TypeScript backend systems, and relational databases (MySQL, Oracle) — and I believe this practical industry experience can be valuable for BCA students learning both core computer-science fundamentals and contemporary software-development practice.

I would be happy to discuss an Assistant Professor, Adjunct Faculty, or Industry Expert / Professor of Practice arrangement, and to contribute through classes, labs, and project guidance as appropriate."""
    },
    {
        "institution": "Dumkal Institute of Engineering and Technology (DIET)",
        "role": "Assistant Professor — BCA / Computer Science / Industry Expert",
        "recipient": "dietnet@hotmail.com",
        "recipient_name": "DIET — Principal / HR",
        "location": "Basantapur, Murshidabad, West Bengal 742406",
        "proactive": True,
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
        ],
        "body_extra": """I understand that Dumkal Institute of Engineering and Technology (DIET), Basantapur, Murshidabad, offers engineering and technology programmes and I am writing to express my interest in contributing to BCA / Computer Science / CSE teaching at the institute as an Assistant Professor, Adjunct Faculty, or Industry Expert / Professor of Practice, as applicable.

My background spans traditional computer-science fundamentals (C, C++, data structures, DBMS, software engineering, computer networks, OOP) and modern backend web development (PHP/Laravel/CodeIgniter, Node.js/NestJS/TypeScript, MySQL, Oracle). I believe this combination can support both core curricula and exposure to current industry practice for students.

I would welcome the opportunity to discuss how I can contribute to the department through teaching, laboratory sessions, project mentoring, and industry-connect initiatives."""
    },
]

# ============================================================================
# CV content (shared across all applications)
# ============================================================================

CV_TEXT = """CANDIDATE PROFILE — ACADEMIC / INDUSTRY FACULTY ROLE
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
  Programming, Data Structures, Database Management Systems, Web Technology,
  Software Engineering, Computer Networks, Object-Oriented Programming,
  PHP / Web Development, Enterprise Application Development, and related
  BCA / Computer Science / CSE topics.

NOTE ON QUALIFICATIONS
  This application is based on the candidate's MCA, BCA, and 16+ years of
  enterprise IT and software-engineering experience. Any specific eligibility
  criteria (such as NET/SET, PhD, or AICTE norms) that may be required by the
  institution should be verified and discussed directly with the institution.
  The candidate is open to discussing the most suitable engagement type —
  Assistant Professor, Adjunct Faculty, Industry Expert / Professor of Practice,
  or Visiting Faculty — based on the institution's needs and requirements.

Last CTC: ₹8,00,008 per annum
"""


def build_message(app: dict, now_iso: str) -> str:
    """Build a raw RFC 2822 message string for one application."""
    subject = (
        f"Proactive Application — {app['role']} — "
        f"{app['institution']} — Swarna Sekhar Dhar"
    )
    body = f"""Dear Sir / Madam,

I am writing to express my interest in contributing to teaching and academic
work at {app['institution']}, located at {app['location']}.

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
{chr(10).join('  - ' + s for s in app['subjects'])}

{app['body_extra']}

This is a proactive (unsolicited) application. I have not seen a current
advertised vacancy for this institution, and I am reaching out to express
interest in contributing practical industry experience to BCA / Computer
Science / CSE education at your institution. I would be grateful for the
opportunity to discuss any suitable engagement — Assistant Professor,
Adjunct Faculty, Industry Expert / Professor of Practice, or Visiting
Faculty — based on your needs.

I have attached my CV for your reference. Please find it at the end of this
message.

Thank you for your time and consideration.

With regards,
Swarna Sekhar Dhar
 Berhampore / Murshidabad area
 MCA, BCA — 16+ years enterprise IT & software engineering

---
CV / PROFILE
------------
{CV_TEXT}

---
Application details
------------
Institution : {app['institution']}
Role        : {app['role']}
Sent        : {now_iso} IST
Application type: Proactive / Unsolicited
Sender      : swarna.s.jobs@gmail.com
"""
    msg = MIMEMultipart("mixed")
    msg["From"] = "swarna.s.jobs@gmail.com"
    msg["To"] = app["recipient"]
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain", "utf-8"))
    return msg.as_string()


def send_one(app: dict, smtp_config: dict, now_iso: str) -> dict:
    """Send one application email. Returns a result dict."""
    result: dict[str, object] = {
        "institution": app["institution"],
        "role": app["role"],
        "recipient": app["recipient"],
        "sent": False,
        "date": now_iso,
        "status": "pending",
        "error": None,
    }
    try:
        host = smtp_config["SMTP_HOST"]
        port = int(smtp_config.get("SMTP_PORT", "465"))
        user = smtp_config["SMTP_USER"]
        password = smtp_config["SMTP_PASSWORD"]
        use_tls = smtp_config.get("SMTP_USE_TLS", "true").lower() == "true"

        if use_tls and port == 465:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as smtp:
                smtp.login(user, password)
                msg = build_message(app, now_iso)
                smtp.sendmail("swarna.s.jobs@gmail.com", app["recipient"], msg)
            result["sent"] = True
            result["status"] = "sent"
            print(f"  SENT: {app['institution']} -> {app['recipient']}")
        else:
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                if use_tls:
                    smtp.starttls(context=ssl.create_default_context())
                smtp.login(user, password)
                msg = build_message(app, now_iso)
                smtp.sendmail("swarna.s.jobs@gmail.com", app["recipient"], msg)
            result["sent"] = True
            result["status"] = "sent"
            print(f"  SENT: {app['institution']} -> {app['recipient']}")
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = f"{type(exc).__name__}: {exc}"
        print(f"  FAILED: {app['institution']} -> {app['recipient']}: {exc}")
    return result


def pre_send_check(app: dict) -> list[str]:
    """Run pre-send checks. Returns list of failures."""
    failures: list[str] = []
    if not app.get("institution"):
        failures.append("missing institution")
    if not app.get("recipient") or "@" not in app.get("recipient", ""):
        failures.append(f"invalid recipient for {app.get('institution', '?')}")
    if not app.get("role"):
        failures.append(f"missing role for {app.get('institution', '?')}")
    if "gitaram.institute2000@gmail.com" in app.get("recipient", "") and "Gitaram" not in app.get("institution", ""):
        failures.append("recipient/ institution mismatch")
    if "mcetbhb.net" in app.get("recipient", "") and "MCET" not in app.get("institution", ""):
        failures.append("recipient/ institution mismatch")
    if "bsmc2022@gmail.com" in app.get("recipient", "") and "BSMC" not in app.get("institution", ""):
        failures.append("recipient/ institution mismatch")
    if "dietnet@hotmail.com" in app.get("recipient", "") and "DIET" not in app.get("institution", ""):
        failures.append("recipient/ institution mismatch")
    if "Last CTC: ₹8,00,008 per annum" not in CV_TEXT:
        failures.append("CTC missing from CV")
    if "PhD" in CV_TEXT and "QUALIFICATIONS" not in CV_TEXT.upper():
        failures.append("unsupported qualification in CV")
    if "NET/SET" in CV_TEXT and "should be verified" not in CV_TEXT and "not required" not in CV_TEXT and "may be required" not in CV_TEXT and "must be required" not in CV_TEXT:
        failures.append("unsupported qualification in CV")
    if "AICTE" in CV_TEXT and "should be verified" not in CV_TEXT:
        failures.append("unsupported AICTE claim in CV")
    if "vacancy" in CV_TEXT.lower() and "not seen a current" not in CV_TEXT.lower():
        failures.append("fabricated vacancy in CV")
    if "@@" in CV_TEXT or "TODO" in CV_TEXT or "FIXME" in CV_TEXT or "placeholder" in CV_TEXT.lower():
        failures.append("placeholder text in CV")
    if "job-application" in CV_TEXT.lower() or "job agent" in CV_TEXT.lower() or "job-agent" in CV_TEXT.lower():
        failures.append("internal Job Agent reference in CV")
    if "trading" in CV_TEXT.lower() and "stock" not in CV_TEXT.lower():
        failures.append("Trading Agent reference in CV")
    if "password" in CV_TEXT.lower() or "api_key" in CV_TEXT.lower() or "token" in CV_TEXT.lower():
        failures.append("credential reference in CV")
    return failures


def main() -> None:
    # Load SMTP config from .env
    env = load_env(ENV_PATH)
    required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]
    missing = [k for k in required if k not in env]
    if missing:
        print(f"ERROR: Missing SMTP config in .env: {', '.join(missing)}")
        print("Halt before sending — email sending is not fully configured.")
        sys.exit(1)

    # IST timezone
    ist = timezone(timedelta(hours=5, minutes=30))
    now = datetime.now(ist)
    now_iso = now.strftime("%Y-%m-%d %H:%M:%S") + " IST"

    print(f"=== Academic Applications — Proactive / Unsolicited ===")
    print(f"Sent at: {now_iso}")
    print(f"Sender  : swarna.s.jobs@gmail.com")
    print(f"CTC     : ₹8,00,008 per annum (placed at end of CV)")
    print()

    # Pre-send checks for all applications
    all_ok = True
    for app in APPLICATIONS:
        failures = pre_send_check(app)
        if failures:
            all_ok = False
            print(f"PRE-SEND CHECK FAILED: {app['institution']}")
            for f in failures:
                print(f"  - {f}")
        else:
            print(f"PRE-SEND CHECK PASSED: {app['institution']}")

    if not all_ok:
        print()
        print("ABORTING — pre-send checks failed. Fix issues before sending.")
        sys.exit(1)

    print()
    print("Pre-send checks passed for all 4 applications. Sending...")
    print()

    results: list[dict] = []
    for app in APPLICATIONS:
        r = send_one(app, env, now_iso)
        results.append(r)
        print()

    # Summary table
    print("=" * 100)
    print(f"{'Institution':<45} {'Role':<30} {'Recipient':<30} {'Sent':<6} {'Date':<22} {'Status':<10}")
    print("=" * 100)
    for r in results:
        print(f"{r['institution'][:44]:<45} {r['role'][:29]:<30} {r['recipient'][:29]:<30} {str(r['sent']):<6} {r['date']:<22} {r['status']:<10}")
    print("=" * 100)

    sent_count = sum(1 for r in results if r["sent"])
    failed_count = sum(1 for r in results if not r["sent"])
    print(f"\nTotal: {len(results)} | Sent: {sent_count} | Failed: {failed_count}")

    if failed_count:
        print("\nFailed applications:")
        for r in results:
            if not r["sent"]:
                print(f"  - {r['institution']}: {r.get('error')}")

    # Exit non-zero if any failed
    if failed_count:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
