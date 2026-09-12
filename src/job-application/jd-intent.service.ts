/**
 * JA-012 — JD Intent Extraction service
 *
 * Deterministic extraction of a structured representation from a job description.
 * Same JD → same JdIntent every time. Each field is tagged explicit vs inferred.
 *
 * doneWhen: "Same JD produces a stable representation traceable to source text or labelled inference."
 */

import { Injectable, Logger } from '@nestjs/common';
import { JdIntent, JdSeniority, JdExperience, JdSkill, JdResponsibility, JdLocation, JdEmploymentType, JdCompensation, JdAuthorization, JdNotice, JdTechDomain, JdChannel, JdEmployer, JdFreshness, FieldEvidence, EvidenceKind } from './jd-intent-model';

function fe(explicit: boolean, source: string): FieldEvidence {
  return { evidence: explicit ? 'explicit' : 'inferred', source };
}

const STOP = new Set([
  'the','a','an','and','or','for','with','in','on','at','to','of','is','it','we','our','you','your',
  'that','this','as','by','from','not','no','be','are','was','has','have','will','would','can','could',
  'should','may','all','also','more','new','based','using','use','working','work','who','what','which',
  'how','when','where','why','please','apply','role','position','job','we','are','looking','seeking',
  'hiring','join','our','team','company','industry','experience','years','plus','strong',
]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s: string): string[] {
  const t = normalize(s).split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));
  return t;
}

function wordBoundary(s: string): string {
  // Escape all regex specials except `|` — skill terms use `|` as alternation intentionally.
  return '\\b' + s.replace(/[.*+?^${}()[\]\\]/g, '\\$&') + '\\b';
}

/** SHA-256 of the normalized text, first 64 hex chars. Same JD → same fingerprint. */
async function fingerprint(text: string): Promise<string> {
  const crypto = await import('crypto');
  const buf = crypto.createHash('sha256').update(normalize(text)).digest();
  return buf.toString('hex').slice(0, 64);
}

@Injectable()
export class JdIntentService {
  private readonly logger = new Logger(JdIntentService.name);

  // ---- public API -------------------------------------------------------

  async extract(jdText: string, meta?: { title?: string | null; company?: string | null; url?: string | null }): Promise<JdIntent> {
    const originalText = jdText;
    const fp = await fingerprint(originalText);
    const norm = normalize(originalText);
    const tks = tokens(originalText);

    return {
      roleTitle: this.extractRoleTitle(norm, meta?.title),
      seniority: this.extractSeniority(norm, originalText, meta?.title),
      employer: this.extractEmployer(norm, originalText, meta?.company),
      mustHaveSkills: this.extractMustHaveSkills(originalText, norm, tks),
      preferredSkills: this.extractPreferredSkills(originalText, norm, tks),
      experience: this.extractExperience(norm, originalText),
      responsibilities: this.extractResponsibilities(originalText, norm),
      location: this.extractLocation(norm, originalText),
      employmentType: this.extractEmploymentType(norm, originalText),
      compensation: this.extractCompensation(norm, originalText),
      authorization: this.extractAuthorization(norm, originalText),
      notice: this.extractNotice(norm, originalText),
      techDomain: this.extractTechDomain(norm, originalText, tks),
      channel: this.extractChannel(norm, originalText),
      freshness: this.extractFreshness(norm, originalText),
      originalText,
      fingerprint: fp,
    };
  }

  // ---- role title -------------------------------------------------------

  private extractRoleTitle(norm: string, metaTitle: string | null | undefined): string | null {
    if (metaTitle && metaTitle.trim()) return metaTitle.trim();
    // Try: first meaningful line / heading
    const firstLine = norm.split(/\n/).find(l => l.trim().length > 5);
    if (firstLine) {
      const m = firstLine.match(/^(?:senior|lead|principal|staff|head|director|manager|engineer|developer|designer|product|data|devops|qa|analyst|architect|consultant|consultant|scientist|manager|coordinator|specialist|associate|intern|internship|administrator|executive|assistant|chief|vp|evp|cxo)\s*[\w\s-]+/i);
      if (m) return m[0].trim();
    }
    return null;
  }

  // ---- seniority --------------------------------------------------------

  private extractSeniority(norm: string, original: string, metaTitle: string | null | undefined): JdSeniority {
    const rankMap: Array<[RegExp, 'junior' | 'mid' | 'senior' | 'lead' | 'principal' | 'director' | 'head']> = [
      [/vp\s*of|vice\s*president|head\s*of|chief\s*[a-z]+|cxo|c-suite|e?x?ecutive\s*(director|summary)/i, 'director'],
      [/principal\s*(engineer|software|staff)?|architect/i, 'principal'],
      [/lead\s*(engineer|software|developer|manager|architect)?|staff\s*(engineer|software)?|senior\s*(engineer|software|developer|manager|architect|consultant|analyst|data|devops|qa| scientist|associate)?|head\s*(of|engineer|developer)?/i, 'lead'],
      [/senior/i, 'senior'],
      [/mid[- ]?level|intermediate|2[- ]?4\s*years|3[- ]?5\s*years|5[- ]?7\s*years|mid[- ]?senior/i, 'mid'],
      [/junior|jr\.?|entry|associate|fresher|0[- ]?1\s*years|1[- ]?2\s*years|intern|internship|rotational/i, 'junior'],
    ];

    for (const [re, level] of rankMap) {
      if (re.test(norm)) {
        return {
          level,
          evidence: { evidence: 'explicit', source: this.snippet(original, re) },
        };
      }
    }

    // Inferred from title words
    if (metaTitle) {
      const titleNorm = metaTitle.toLowerCase();
      if (/principal|director|head|vp|chief|cxo|executive/i.test(titleNorm)) {
        return { level: 'director', evidence: { evidence: 'inferred', source: '' } };
      }
      if (/lead|architect|staff\s*engineer|sr\.?|senior/i.test(titleNorm)) {
        return { level: 'senior', evidence: { evidence: 'inferred', source: '' } };
      }
      if (/mid|intermediate|2[- ]?4/i.test(titleNorm)) {
        return { level: 'mid', evidence: { evidence: 'inferred', source: '' } };
      }
      if (/junior|jr\.?|entry|associate|fresher|intern/i.test(titleNorm)) {
        return { level: 'junior', evidence: { evidence: 'inferred', source: '' } };
      }
    }

    return { level: 'unknown', evidence: { evidence: 'inferred', source: '' } };
  }

  // ---- employer ---------------------------------------------------------

  private extractEmployer(norm: string, original: string, metaCompany: string | null | undefined): JdEmployer {
    let name: string | null = null;
    let evidence: FieldEvidence = { evidence: 'inferred', source: '' };

    if (metaCompany && metaCompany.trim()) {
      name = metaCompany.trim();
      evidence = { evidence: 'explicit', source: metaCompany.trim() };
    } else {
      // Look for "at <Company>" / "<Company> is hiring" / "Company: <name>"
      const m = norm.match(/at\s+([a-z][a-z0-9\s&.]+?)(?:\s+is|\s+are|\s+hiring|\s+looking|\s+seeking|\s+,\s*|$)/);
      if (m && m[1].trim().length > 2) {
        name = m[1].trim();
        evidence = { evidence: 'explicit', source: this.snippet(original, new RegExp(wordBoundary('at'))) };
      }
    }

    const industry = this.extractIndustry(norm, original);
    const sizeHint = this.extractSizeHint(norm, original);

    return { name, industry, sizeHint, evidence };
  }

  private extractIndustry(norm: string, original: string): string | null {
    const m = norm.match(/\b(finance|financial|fintech|banking|bank|insurance|insurance\s*tech|health|healthcare|health\s*tech|heath\s*care|hospital|pharma|pharmaceuticals|biotech|bio\s*tech|education|edtech|ecom|ecommerce|retail|saaS|saas|software|cloud|iot|ai|ml|machine\s*learning|data|analytics|logistics|supply\s*chain|manufacturing|energy|oil\s*&?\s*gaz|telecom|media|publishing|real\s*estate|property|consulting|legal|law|government|public\s*sector|defence|defense)\b/i);
    if (m) return m[1].toLowerCase();
    return null;
  }

  private extractSizeHint(norm: string, original: string): string | null {
    const m = norm.match(/\b(fortune\s*\d+|startup|early[- ]?stage|late[- ]?stage|scale[- ]?up|sistema|smb|small\s*(and\s*)?medium|enterprise|large[- ]?scale|multi[- ]?national|global|growing|hyper[- ]?growth|high[- ]?growth| Series A| Series B| Series C| Series D| Series E)/i);
    if (m) return m[0].toLowerCase();
    return null;
  }

  // ---- skills -----------------------------------------------------------

  private extractMustHaveSkills(original: string, norm: string, tks: string[]): JdSkill[] {
    // Patterns that elevate a skill to must-have
    const MUST_PREFIXES = [
      /\b(required|must\s*have|mandatory|essential|needed|needs|looking\s*for|you\s*should\s*have|you\s*must|proficient\s*in|experience\s*with|experience\s*in|knowledge\s*of|knowledge\s*in|familiar\s*with|expertise\s*in|expertise\s*with|strong\s*(knowledge|experience|background|foundation)\s*(in|with|of))/i,
    ];

    const skills = this.knownSkills();
    const found: JdSkill[] = [];
    const seen = new Set<string>();

    for (const skill of skills) {
      const re = new RegExp(wordBoundary(skill.term), 'i');
      if (!re.test(original)) continue;
      if (seen.has(skill.term)) continue;
      // Determine if it's flagged as must-have
      let kind: 'must-have' | 'preferred' | 'nice-to-have' = 'must-have';
      let evidence = { evidence: 'explicit', source: this.snippet(original, re) };

      // Reflect ordering cues: "must have X, preferred Y" — but per the seed we only separate must-have from others,
      // and we don't split preferred vs nice-to-have here. Mark as must-have when the skill appears adjacent to a must-pref ix.
      let isMust = false;
      for (const prefixRe of MUST_PREFIXES) {
        // Check the 60 chars before the match
        const idx = norm.search(re);
        if (idx < 0) continue;
        const windowBefore = norm.slice(Math.max(0, idx - 80), idx);
        if (prefixRe.test(windowBefore)) { isMust = true; break; }
        const windowAfter = norm.slice(idx, idx + 80);
        if (prefixRe.test(windowAfter)) { isMust = true; break; }
      }

      if (isMust) {
        kind = 'must-have';
      } else {
        // Default: if the skill is common and appears, treat as must-have (conservative — better to over-flag)
        kind = 'must-have';
      }

      found.push({ name: skill.name, kind, evidence: fe(true, this.snippet(original, new RegExp(wordBoundary(skill.term), 'i'))) });
      seen.add(skill.term);
    }

    // Deduplicate by name
    const byName = new Map<string, JdSkill>();
    for (const s of found) {
      byName.set(s.name.toLowerCase(), s);
    }
    return Array.from(byName.values());
  }

  private extractPreferredSkills(original: string, norm: string, tks: string[]): JdSkill[] {
    // Preferred skills are those explicitly tagged as preferred/nice-to-have or in a "nice-to-have"/"bonus" section.
    const PREF_PREFIXES = [
      /\b(preferred|nice[- ]?to[- ]?have|bonus|good[- ]?to[- ]?have|advantageous|plus|nice|desirable|would\s*be\s*an\s*added|can\s*be\s*a\s*plus|would\s*be\s*a\s*plus|nice[- ]?to[- ]?have|optional)/i,
    ];

    const skills = this.knownSkills();
    const found: JdSkill[] = [];
    const seen = new Set<string>();

    for (const skill of skills) {
      const re = new RegExp(wordBoundary(skill.term), 'i');
      if (!re.test(original)) continue;
      if (seen.has(skill.term)) continue;
      let isPreferred = false;
      const idx = original.search(re);
      if (idx < 0) continue;
      for (const prefixRe of PREF_PREFIXES) {
        const windowBefore = original.slice(Math.max(0, idx - 80), idx);
        const windowAfter = original.slice(idx, idx + 80);
        if (prefixRe.test(windowBefore) || prefixRe.test(windowAfter)) {
          isPreferred = true;
          break;
        }
      }

      if (isPreferred) {
        found.push({
          name: skill.name,
          kind: 'preferred',
          evidence: { evidence: 'explicit', source: this.snippet(original, re) },
        });
        seen.add(skill.term);
      }
    }

    const byName = new Map<string, JdSkill>();
    for (const s of found) byName.set(s.name.toLowerCase(), s);
    return Array.from(byName.values());
  }

  private knownSkills(): Array<{ term: string; name: string }> {
    return [
      { term: 'javascript', name: 'JavaScript' },
      { term: 'typescript', name: 'TypeScript' },
      { term: 'python', name: 'Python' },
      { term: 'java', name: 'Java' },
      { term: 'kotlin', name: 'Kotlin' },
      { term: 'swift', name: 'Swift' },
      { term: 'go', name: 'Go' },
      { term: 'golang', name: 'Go' },
      { term: 'rust', name: 'Rust' },
      { term: 'c\+\+', name: 'C++' },
      { term: 'c#', name: 'C#' },
      { term: 'csharp', name: 'C#' },
      { term: 'ruby', name: 'Ruby' },
      { term: 'php', name: 'PHP' },
      { term: 'scala', name: 'Scala' },
      { term: 'sql', name: 'SQL' },
      { term: 'nosql', name: 'NoSQL' },
      { term: 'mongodb', name: 'MongoDB' },
      { term: 'postgresql', name: 'PostgreSQL' },
      { term: 'mysql', name: 'MySQL' },
      { term: 'redis', name: 'Redis' },
      { term: 'elasticsearch', name: 'Elasticsearch' },
      { term: 'kafka', name: 'Kafka' },
      { term: 'rabbitmq', name: 'RabbitMQ' },
      { term: 'docker', name: 'Docker' },
      { term: 'kubernetes', name: 'Kubernetes' },
      { term: 'k8s', name: 'Kubernetes' },
      { term: 'terraform', name: 'Terraform' },
      { term: 'ansible', name: 'Ansible' },
      { term: 'jenkins', name: 'Jenkins' },
      { term: 'github\s*actions|github\s*actions', name: 'GitHub Actions' },
      { term: 'gitlab\s*ci', name: 'GitLab CI' },
      { term: 'ci/cd|continuous\s*integration|continuous\s*deployment', name: 'CI/CD' },
      { term: 'aws', name: 'AWS' },
      { term: 'azure', name: 'Azure' },
      { term: 'gcp|google\s*cloud', name: 'Google Cloud' },
      { term: 'react', name: 'React' },
      { term: 'angular|angularjs', name: 'Angular' },
      { term: 'vue\.?js|vuejs', name: 'Vue.js' },
      { term: 'next\.?js|nextjs', name: 'Next.js' },
      { term: 'node\.?js|nodejs|node', name: 'Node.js' },
      { term: 'express', name: 'Express' },
      { term: 'nestjs|nest\.js', name: 'NestJS' },
      { term: 'django', name: 'Django' },
      { term: 'flask', name: 'Flask' },
      { term: 'rails|ruby\s*on\s*rails', name: 'Ruby on Rails' },
      { term: 'spring\s*(boot)?|springframe', name: 'Spring' },
      { term: 'hibernate', name: 'Hibernate' },
      { term: 'microservices|microservice', name: 'Microservices' },
      { term: 'rest|restful|api', name: 'REST API' },
      { term: 'graphql', name: 'GraphQL' },
      { term: 'grpc', name: 'gRPC' },
      { term: 'web\s*socket|websocket', name: 'WebSockets' },
      { term: 'oauth|open\s*auth|openid|oidc', name: 'OAuth / OpenID' },
      { term: 'jwt|json\s*web\s*token', name: 'JWT' },
      { term: 'machine\s*learning|ml|deep\s*learning|neural|llm|gpt|transformer', name: 'Machine Learning' },
      { term: 'data\s*engineering|etl|pipelines|airflow|dbt', name: 'Data Engineering' },
      { term: 'devops|sre|site\s*reliability', name: 'DevOps / SRE' },
      { term: 'security|infosec|application\s*security|appsec|oauth|penetration\s*test', name: 'Security' },
      { term: 'agile|scrum|kanban', name: 'Agile' },
      { term: 'git|github|gitlab|bitbucket', name: 'Git' },
    ];
  }

  // ---- experience -------------------------------------------------------

  private extractExperience(norm: string, original: string): JdExperience {
    let minYears: number | null = null;
    let maxYears: number | null = null;
    let evidence: FieldEvidence = { evidence: 'inferred', source: '' };

    // Match against original text (preserves `-` in `3-5`) so the range second group binds.
    const yearPhrases = original.match(/(?:minimum|at\s*least|need|needs|required|should\s*have|looking\s*for|experience)\s*[\w\s]{0,20}?(\d+)\s*(?:[-–]\s*(\d+))?\s*years?|(?:minimum|at\s*least|need|needs)\s*[\w\s]{0,20}?(\d+)\s*\+\s*years?|(\d+)\s*\+\s*years?|(\d+)\s*(?:[-–]\s*(\d+))?\s*years?/gi);

    if (yearPhrases) {
      let low = Infinity, high = -Infinity;
      for (const phrase of yearPhrases) {
        const m1 = phrase.match(/(\d+)\s*\+\s*years?/i);
        if (m1) {
          const n = parseInt(m1[1], 10);
          if (n >= 0) { low = Math.min(low, n); high = Math.max(high, Infinity); }
        }
        const m2 = phrase.match(/(\d+)\s*(?:[-–]\s*(\d+))?\s*years?/i);
        if (m2) {
          const a = parseInt(m2[1], 10);
          const b = m2[2] ? parseInt(m2[2], 10) : a;
          low = Math.min(low, a);
          high = Math.max(high, b);
        }
      }
      if (low < Infinity) minYears = low;
      if (high > -Infinity && high !== Infinity) maxYears = high;
      evidence = { evidence: 'explicit', source: this.snippet(original, /(?:minimum|at\s*least|need|needs|required|should\s*have|looking\s*for|experience)\s*[\w\s]{0,20}?\d+/) };
    } else {
      // Inferred from seniority level if present
      if (/\b(senior|lead|principal|director|head|architect)\b/i.test(norm)) {
        minYears = 5;
        maxYears = null;
        evidence = { evidence: 'inferred', source: '' };
      } else if (/\b(mid|intermediate|2[- ]?4|3[- ]?5)\b/i.test(norm)) {
        minYears = 2;
        maxYears = 5;
        evidence = { evidence: 'inferred', source: '' };
      } else if (/\b(junior|jr\.?|entry|associate|fresher|intern)\b/i.test(norm)) {
        minYears = 0;
        maxYears = 2;
        evidence = { evidence: 'inferred', source: '' };
      } else {
        minYears = null;
        maxYears = null;
        evidence = { evidence: 'inferred', source: '' };
      }
    }

    return { minYears, maxYears, evidence };
  }

  // ---- responsibilities -------------------------------------------------

  private extractResponsibilities(original: string, norm: string): JdResponsibility[] {
    // Split on line breaks / bullets / numbered lists
    const lines = original.split(/\n/).map(l => l.trim()).filter(Boolean);
    const resps: JdResponsibility[] = [];

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (/^(?:responsibilities|what\s*you\s*ll\s*do|your\s*day[- ]?to[- ]?day|day[- ]?to[- ]?day|duties|what\s*you\s*will\s*do|in\s*this\s*role|in\s*this\s*position|in\s*this\s*job)\b/i.test(lower)) {
        // This line is a header — skip, but capture the section
        continue;
      }
      // Bullet or numbered line that looks like a responsibility
      if (/^[-•*]\s+/i.test(line) || /^\d+[.)]\s+/i.test(line) || /^[A-Z][a-z]/i.test(line)) {
        const text = line.replace(/^[-•*\d+.)\s]+/, '').trim();
        if (text.length > 5 && text.length < 600) {
          resps.push({ text, evidence: { evidence: 'explicit', source: text.slice(0, 200) } });
        }
      }
    }

    // Fallback: if no bullets found, treat sentences containing action verbs as responsibilities
    if (resps.length === 0) {
      const sentences = original.split(/(?<=[.!?])\s+/);
      const actionVerbs = /\b(develop|build|design|implement|write|create|lead|manage|own|drive| architect|code|test|ship|deploy|maintain|support|collaborate|work|partner|contribute|analyze|analyse|monitor|improve|optimize|optimise|scale|integrate|define|deliver|execute|evaluate|research|prototype|mentor|coach|review|plan|strategize|strategise|automate|reduce|increase|grow|expand)\b/i;
      for (const sent of sentences) {
        const t = sent.trim();
        if (t.length > 10 && t.length < 500 && actionVerbs.test(t)) {
          resps.push({ text: t, evidence: { evidence: 'explicit', source: t.slice(0, 200) } });
        }
      }
    }

    return resps.slice(0, 30); // cap
  }

  // ---- location ----------------------------------------------------------

  private extractLocation(norm: string, original: string): JdLocation {
    const locRe = /\b(location|based|office|work\s*from|remote|relocate|hyderabad|mumbai|delhi|bengaluru|bangalore|chennai|kolkata|pune|gurgaon|noida|ghaziabad|jaipur|coimbatore|uk|united\s*kingdom|london|berlin|paris|amsterdam|new\s*york|nyc|sf|san\s*francisco|seattle|chicago|austin|boston|los\s*angeles|tel\s*aviv|israel|europe|eu|asia|remote\s*only|on[- ]?site|hybrid|work\s*from\s*home|wfh)\b/i;
    const m = locRe.exec(norm);
    let raw: string | null = null;
    let remoteAllowed: boolean | null = null;
    let evidence: FieldEvidence = { evidence: 'inferred', source: '' };

    if (m) {
      const matchStart = m.index;
      const window = norm.slice(Math.max(0, matchStart - 30), Math.min(norm.length, matchStart + 120));
      raw = original.split(/\n/).find(l => l.toLowerCase().includes(m[0].toLowerCase()))?.trim() || window.trim();
      evidence = { evidence: 'explicit', source: window.trim() };
    }

    // Remote hints
    if (/\b(remote\s*only|only\s*remote|wfh|work\s*from\s*home|remote[- ]?first|remote[- ]?friendly|fully\s*remote)\b/i.test(norm)) {
      remoteAllowed = true;
    } else if (/\b(on[- ]?site|onsite|in[- ]?office|on[- ]?campus|work\s*from\s*our\s*office|must\s*be\s*on[- ]?site|hybrid\s*but|hybrid\s*,\s*3\s*days|3\s*days\s*onsite)\b/i.test(norm)) {
      remoteAllowed = false;
    } else if (/\b(hybrid|in[- ]?office|in\s*person|onsite)\b/i.test(norm)) {
      remoteAllowed = false; // hybrid conservatively = cannot be fully remote
    }

    return { raw: raw ?? '', remoteAllowed, evidence };
  }

  // ---- employment type ---------------------------------------------------

  private extractEmploymentType(norm: string, original: string): JdEmploymentType {
    if (/\b(part[- ]?time|contract|temporary|freelance|internship|seasonal|6[- ]?month|3[- ]?month|around[- ]?the[- ]?clock)\b/i.test(original)) {
      // When part-time language AND contract language both appear, part-time wins — hours pattern is the more
      // specific employment-type signal (contract alone is an engagement model, not an hours model).
      const hasPartTime = /\b(part[- ]?time|parttime|part[- ]?time)\b/i.test(original);
      const hasContract = /\b(contract|freelance|temporary|seasonal)\b/i.test(original);
      if (hasPartTime) {
        return { kind: 'part-time', evidence: { evidence: 'explicit', source: this.snippet(original, /\b(part[- ]?time|parttime)\b/i) } };
      }
      return { kind: 'contract', evidence: { evidence: 'explicit', source: this.snippet(original, /\b(contract|freelance|temporary|seasonal)\b/i) } };
    }
    if (/\b(full[- ]?time|fulltime|permanent|ft\s*role|full[- ]?time\s*position)\b/i.test(original)) {
      const source = this.snippet(original, /\b(full[- ]?time|fulltime|permanent)\b/i);
      return { kind: 'full-time', evidence: { evidence: 'explicit', source } };
    }
    return { kind: 'unknown', evidence: { evidence: 'inferred', source: '' } };
  }

  // ---- compensation ------------------------------------------------------

  private extractCompensation(norm: string, original: string): JdCompensation {
    // Match against original text (preserve hyphens, dots, currency symbols)
    const ctcRe = /\b(\d{2,3})(?:\s*[-–]\s*(\d{2,4}))?\s*(lpa|lp|a|usd|eur|gbp|inr|₹|\$|€|£|cad|aud)\b/i;
    const m = ctcRe.exec(original);
    let raw: string | null = null;
    let minCtc: number | null = null;
    let maxCtc: number | null = null;
    let currencyHint: string | null = null;
    let evidence: FieldEvidence = { evidence: 'inferred', source: '' };

    if (m) {
      const a = parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : a;
      minCtc = a;
      maxCtc = b > a ? b : a;
      currencyHint = m[3].toUpperCase();
      raw = original.split(/\n/).find(l => l.toLowerCase().includes(m[0].toLowerCase()))?.trim() || m[0];
      evidence = { evidence: 'explicit', source: raw };
    } else {
      // Inferred from salary-related terms without number
      if (/\b(salary|ctc|compensation|pay|package|remuneration|pay\s*range|salary\s*range)\b/i.test(norm)) {
        raw = this.snippet(original, /\b(salary|ctc|compensation|pay|package|remuneration|pay\s*range|salary\s*range)\b/i);
        evidence = { evidence: 'explicit', source: raw };
      }
    }

    return { raw: raw ?? '', minCtc, maxCtc, currencyHint, evidence };
  }

  // ---- authorization -----------------------------------------------------

  private extractAuthorization(norm: string, original: string): JdAuthorization {
    if (/\b(us\s*citizen|us\s*residents?|united\s*states\s*citizen|american\s*citizen|canadian\s*citizen|australian\s*citizen|uk\s*citizen|british\s*citizen|european\s*citizen|eu\s*citizen|citizens?\s*only|citizens\s*only|only\s*(us|uk|eu|india|for)\s*citizens)\b/i.test(norm)) {
      const kind = /\b(us|united\s*states|american)\b/i.test(norm) ? 'citizen' :
        /\b(uk|british)\b/i.test(norm) ? 'citizen' :
        /\b(eu|european)\b/i.test(norm) ? 'citizen' : 'citizen';
      const source = this.snippet(original, /\b(citizens?\s*only|only\s*for\s*citizens)\b/i);
      return { required: true, kind: 'citizen', evidence: { evidence: 'explicit', source } };
    }
    if (/\b(permanent\s*resident|green\s*card|pr\s*card|pr\s*status|g permanent|permanent resident)\b/i.test(norm)) {
      const source = this.snippet(original, /\b(permanent\s*resident|green\s*card|pr)\b/i);
      return { required: true, kind: 'pr', evidence: { evidence: 'explicit', source } };
    }
    if (/\b(work\s*permit|visa\s*required|authorization\s*to\s*work|work\s*authoriz|sponsorship\s*for\s*visa|visa\s*sponsor|sponsorship\s*available|we\s*sponsor|willing\s*to\s*sponsor|h1b|work\s*visa)\b/i.test(norm)) {
      const source = this.snippet(original, /\b(work\s*permit|visa|sponsor|authorization)\b/i);
      return { required: true, kind: 'sponsorship', evidence: { evidence: 'explicit', source } };
    }
    if (/\b(no\s*sponsorship|no\s*visa\s*sponsor|we\s*do\s*not\s*sponsor|not\s*eligible\s*for\s*sponsorship|sponsorship\s*not\s*available)\b/i.test(norm)) {
      const source = this.snippet(original, /\b(no\s*sponsorship|no\s*visa\s*sponsor)\b/i);
      return { required: false, kind: 'no sponsorship', evidence: { evidence: 'explicit', source } };
    }
    return { required: false, kind: 'unknown', evidence: { evidence: 'inferred', source: '' } };
  }

  // ---- notice -----------------------------------------------------------

  private extractNotice(norm: string, original: string): JdNotice {
    let kind: 'immediate' | 'notice' | null = null;
    let days: number | null = null;
    let evidence: FieldEvidence = { evidence: 'inferred', source: '' };

    if (/\b(immediate|start\s*immediately|join\s*immediately|start\s*right\s*away|immediate\s*joining|day[- ]?1|start\s*date:\s*today|available\s*immediately)\b/i.test(norm)) {
      kind = 'immediate';
      days = 0;
      evidence = { evidence: 'explicit', source: this.snippet(original, /\b(immediate|start\s*immediately|join\s*immediately)\b/i) };
    } else {
      const noticeRe = /\b(\d+)\s*(?:days?|weeks?|months?)\s*(?:notice|prior|before|advance|lead\s*time)/i;
      const m = noticeRe.exec(norm);
      if (m) {
        kind = 'notice';
        days = parseInt(m[1], 10);
        if (/\b(week|weeks)\b/i.test(m[0])) days = days * 7;
        else if (/\b(month|months)\b/i.test(m[0])) days = days * 30;
        evidence = { evidence: 'explicit', source: this.snippet(original, noticeRe) };
      } else {
        // Check for any notice mention without parseable number
        if (/\b(notice\s*period|notice\s*days|notice\s*required|notice\s*before|notice\s*advance)\b/i.test(norm)) {
          kind = 'notice';
          days = null;
          evidence = { evidence: 'explicit', source: this.snippet(original, /\b(notice\s*period|notice\s*days)\b/i) };
        }
      }
    }

    return { kind, days, evidence };
  }

  // ---- tech domain ------------------------------------------------------

  private extractTechDomain(norm: string, original: string, tks: string[]): JdTechDomain {
    const technologies: string[] = [];
    const seen = new Set<string>();

    const techTerms = [
      'javascript','typescript','python','java','kotlin','swift','go','golang','rust','c++','c#','csharp','ruby','php','scala',
      'sql','nosql','mongodb','postgresql','mysql','redis','elasticsearch','kafka','rabbitmq','docker','kubernetes','k8s',
      'terraform','ansible','jenkins','github actions','gitlab ci','ci/cd','aws','azure','gcp','google cloud',
      'react','angular','vue.js','next.js','node.js','express','nestjs','django','flask','rails','ruby on rails','spring','hibernate',
      'microservices','rest','graphql','grpc','websocket','oauth','jwt','machine learning','ml','deep learning','llm','gpt','transformer',
      'data engineering','etl','airflow','dbt','devops','sre','security','infosec','agile','scrum','git','github',
      'figma','sketch','xd','ui','ux','design','frontend','front-end','backend','back-end','fullstack','full-stack',
      'mobile','ios','android','react native','flutter','xamarin','ionic',
      'testing','qa','quality','test','unit test','integration test','e2e','selenium','cypress','jest','mocha','playwright',
      'monitoring','logging','observability','datadog','sentry','new relic','prometheus','grafana','elk','splunk',
    ];

    for (const term of techTerms) {
      const re = new RegExp(wordBoundary(term), 'i');
      if (re.test(norm) && !seen.has(term.toLowerCase())) {
        technologies.push(term);
        seen.add(term.toLowerCase());
      }
    }

    let domain: string | null = null;
    const domainRe = /\b(finance|financial|fintech|banking|bank|insurance|insurance\s*tech|health|healthcare|health\s*tech|pharma|pharmaceuticals|biotech|bio\s*tech|education|edtech|ecommerce|ecom|retail|saaS|saas|software|cloud|iot|ai|ml|machine\s*learning|data|analytics|logistics|supply\s*chain|manufacturing|energy|telecom|media|publishing|real\s*estate|consulting|legal|law|government|defence|defense)\b/i;
    const dm = domainRe.exec(norm);
    if (dm) domain = dm[1].toLowerCase();

    return { technologies, domain, evidence: { evidence: 'explicit', source: technologies.slice(0, 3).join(', ') } };
  }

  // ---- channel ----------------------------------------------------------

  private extractChannel(norm: string, original: string): JdChannel {
    if (/\b(greenhouse|lever|workable|ashby|smartrecruiters|teamtailor|taleo|icims|knight\s*api)\b/i.test(original)) {
      const source = this.snippet(original, /\b(greenhouse|lever|workable|ashby|smartrecruiters|teamtailor|taleo|icims)\b/i);
      return { kind: 'ats', target: null, evidence: { evidence: 'explicit', source } };
    }
    const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
    const emailMatch = original.match(emailRe);
    if (emailMatch) {
      const target = emailMatch[0].toLowerCase();
      const source = this.snippet(original, emailRe);
      if (/\b(email|mail|send|apply\s*by\s*email|apply\s*via\s*email)\b/i.test(norm)) {
        return { kind: 'email', target, evidence: { evidence: 'explicit', source } };
      }
      return { kind: 'email', target, evidence: { evidence: 'explicit', source } };
    }
    if (/\b(apply\s*(?:online|here|now|through|via)|apply\s*through\s*our\s*(?:website|portal|career\s*page)|apply\s*at\s*our\s*(?:website|portal))\b/i.test(norm)) {
      const source = this.snippet(original, /\b(apply\s*(?:online|here|now|through|via)|apply\s*through|apply\s*at)\b/i);
      return { kind: 'portal', target: null, evidence: { evidence: 'explicit', source } };
    }
    if (/\b(referral|refer|employee\s*referral|refer\s*a\s*friend|referral\s*bonus)\b/i.test(norm)) {
      const source = this.snippet(original, /\b(referral|refer)\b/i);
      return { kind: 'referral', target: null, evidence: { evidence: 'explicit', source } };
    }
    if (norm.includes('http') || /\b(www\.|careers?\.|jobs?\.|apply\.|applynow\.)/i.test(norm)) {
      const source = this.snippet(original, /\b(https?|www\.|careers?\.|jobs?\.|apply)/i);
      return { kind: 'external-link', target: null, evidence: { evidence: 'explicit', source } };
    }
    return { kind: 'unknown', target: null, evidence: { evidence: 'inferred', source: '' } };
  }

  // ---- freshness ---------------------------------------------------------

  private extractFreshness(norm: string, original: string): JdFreshness {
    let posted: string | null = null;
    let ageDays: number | null = null;
    let evidence: FieldEvidence = { evidence: 'inferred', source: '' };

    // "Posted N days ago", "Posted on <date>", "N days ago", "N hours ago", "N weeks ago"
    const daysAgoRe = /\b(\d+)\s*(?:days?|d)\s*(?:ago|old)\b/i;
    const m1 = daysAgoRe.exec(norm);
    if (m1) {
      ageDays = parseInt(m1[1], 10);
      posted = this.snippet(original, daysAgoRe);
      evidence = { evidence: 'explicit', source: posted };
    } else {
      const hoursAgoRe = /\b(\d+)\s*(?:hours?|h)\s*(?:ago|old)\b/i;
      const m2 = hoursAgoRe.exec(norm);
      if (m2) {
        ageDays = Math.ceil(parseInt(m2[1], 10) / 24);
        posted = this.snippet(original, hoursAgoRe);
        evidence = { evidence: 'explicit', source: posted };
      } else {
        const weeksAgoRe = /\b(\d+)\s*(?:weeks?|wks?)\s*(?:ago|old)\b/i;
        const m3 = weeksAgoRe.exec(norm);
        if (m3) {
          ageDays = parseInt(m3[1], 10) * 7;
          posted = this.snippet(original, weeksAgoRe);
          evidence = { evidence: 'explicit', source: posted };
        }
      }
    }

    if (!posted) {
      // Try "Posted on <date>"
      const postedOnRe = /\bposted\s*(?:on|in|at|this)\s*[a-z]{3,9}\s+\d{1,2},?\s*\d{4}|\bposted\s*(?:on|in|at)\s*\d{1,2}\s*[a-z]{3,9}\s*\d{4}|\bdate:\s*[a-z]{3,9}\s+\d{1,2},?\s*\d{4}/i;
      const m4 = postedOnRe.exec(norm);
      if (m4) {
        posted = this.snippet(original, postedOnRe);
        evidence = { evidence: 'explicit', source: posted };
        ageDays = null;
      }
    }

    return { posted, ageDays, evidence };
  }

  // ---- helpers ----------------------------------------------------------

  private snippet(original: string, re: RegExp): string {
    const m = re.exec(original.toLowerCase());
    if (m) {
      const idx = re.lastIndex;
      const start = Math.max(0, m.index - 40);
      const end = Math.min(original.length, idx + 60);
      // Undo lowercasing to return original-case snippet
      const rawSnippet = original.slice(start, end).trim();
      return rawSnippet.replace(/\n/g, ' ').slice(0, 160);
    }
    return '';
  }
}
