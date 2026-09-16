import { Injectable } from '@nestjs/common';

// ---- a minimal structural extraction of a job lead's raw description ----
// deterministic: same title+description+company+url -> same ExtractedJob every time.
// reuses the keyword/section heuristics already scattered across qualification.service.ts
// (KNOWN_TECH, MUST_HAVE_KEYWORDS, tech categories, section heuristics), candidate-evidence.service.ts
// (category extractors), and process-learning.service.ts (PROCESS_PATTERNS) — this is a
// consolidation/extraction, not new heuristics.

export interface ExtractedJob {
  title: string;
  company: string;
  url: string | null;
  description: string | null;
  extractedSkills: string[];
  responsibilities: string[];
  keyRequirements: string[];
  techStack: string[];
  location: string | null;
  employmentType: string | null; // full-time | part-time | contract | freelance | internship | remote | not-specified
  salaryRange: string | null;
  applyChannel: string | null; // email | careers-page-form | documented-process | unknown
  openingType: string | null; // new-grad | experienced | senior | lead | manager | intern | not-specified
  daysAgo: number | null;
  sourceHint: string | null;
}

// small controlled keyword sets — these mirror the sets already used elsewhere in the codebase
// (qualification.service.ts KNOWN_TECH + tech categories + MUST_HAVE_KEYWORDS + section heuristics).
// Kept here so the extractor is self-contained and testable.

const EMPLOYMENT_TYPE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(full[- ]?time)\b/i, label: 'full-time' },
  { pattern: /\b(part[- ]?time)\b/i, label: 'part-time' },
  { pattern: /\b(contract(?:or)?)\b/i, label: 'contract' },
  { pattern: /\b(freelance|independent contractor)\b/i, label: 'freelance' },
  { pattern: /\b(intern|internship)\b/i, label: 'internship' },
  { pattern: /\b(remote)\b/i, label: 'remote' },
];

const OPENING_TYPE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(intern|internship|training|apprentice)\b/i, label: 'intern' },
  { pattern: /\b(new grad|graduate|fresh|freshers?)\b/i, label: 'new-grad' },
  { pattern: /\b(junior|jr|level 1|entry[-\s]?level|associate|0?\-[23]\s*years?)\b/i, label: 'junior' },
  { pattern: /\b(senior|sr|level 4|level ?5|5\+? years?|7\+? years?|8\+? years?|10\+? years?|12\+? years?)\b/i, label: 'senior' },
  { pattern: /\b(lead|tech lead|technical lead|staff engineer|principal)\b/i, label: 'lead' },
  { pattern: /\b(manager|head of|director|vp|vice president|cx o|cto|chief)\b/i, label: 'manager' },
];

const APPLY_CHANNEL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(email\s+(your\s+)?cv|send\s+(us\s+)?(your\s+)?(cv|resume)|apply\s+via\s+email|mailto|careers?\s*@\w)/i, label: 'email' },
  { pattern: /\b(applicant ?tracking|ats|greenhouse|lever|workable|recruitee|smartrecruiters|icims|talentlyft|navigos|join ?push ?office)/i, label: 'careers-page-form' },
  { pattern: /\b(document(?:ed)?\s+(apply|application|process|procedure|instructions)|application\s+process|application\s+procedure|how\s+to\s+apply|apply\s+process)/i, label: 'documented-process' },
];

function extractEmploymentType(title: string, desc: string): string | null {
  const hay = `${title} ${desc}`.toLowerCase();
  for (const r of EMPLOYMENT_TYPE_PATTERNS) {
    if (r.pattern.test(hay)) return r.label;
  }
  return null;
}

function extractOpeningType(title: string, desc: string): string | null {
  const hay = `${title} ${desc}`.toLowerCase();
  for (const r of OPENING_TYPE_PATTERNS) {
    if (r.pattern.test(hay)) return r.label;
  }
  return null;
}

function extractApplyChannel(title: string, desc: string): string | null {
  const hay = `${title} ${desc}`.toLowerCase();
  for (const r of APPLY_CHANNEL_PATTERNS) {
    if (r.pattern.test(hay)) return r.label;
  }
  return null;
}

function extractLocation(desc: string | null, existingLocation: string | null): string | null {
  if (existingLocation && existingLocation.trim().length > 0) return existingLocation.trim();
  if (!desc) return null;
  // try a few common location phrases already in use by scout adapter heuristics
  const m = desc.match(/(?:location|based in|work from|remote from|posted from|situated in|operating from|we are located|office in|based at)[\s:]+([A-Z][\w\s\-,']+?(?:city|state|country|region|headquarters|hub|office|branch|pune|mumbai|delhi|noida|bangalore|blr|hyd|gurgaon|gurugram|chennai|kolkata|jaipur|ahmedabad|coimbatore|bengaluru|navi mumbai|ghaziabad|faridabad|meerut|indore|lucknow|kanpur|chennai|mysore|kochi|trivandrum|bhubaneswar|raipur|visakhapatnam|thane|kalyan|vasai|virar|pimpri|pune|nashik|aurangabad|solapur|amravati|vit|goa|dehradun|shimla|dharamshala|udaipur|jodhpur|jaipur|ludhiana|chandigarh|surat|baroda|rajkot|ahmadabad|vadodara|nagpur|bangalore|chennai|mumbai|delhi|noida|gurgaon|hreetech|chennai|mumbai|delhi|noida|gurgaon|pune|hyderabad|bangalore|chandigarh|jaipur|kolkata|chennai|mumbai|delhi|noida|gurgaon|pune|hyderabad|bangalore))/i);
  if (m && m[1].trim().length > 0 && m[1].trim().length < 120) return m[1].trim();
  return null;
}

function extractSalaryRange(desc: string | null): string | null {
  if (!desc) return null;
  const m = desc.match(/\$?\s*\d{3,}\s*(?:k|K)?\s*(?:[\u2013\-]?\s*\$?\s*\d{3,}\s*(?:k|K)?)?/);
  if (m) return m[0].trim();
  return null;
}

function extractTechStack(desc: string | null, title: string): string[] {
  if (!desc) return [];
  const hay = desc.toLowerCase();
  const found = new Set<string>();
  // technology tokens — mirrors qualification.service.ts KNOWN_TECH set plus common commercial
  // synonyms so the structured extraction is consistent with downstream qualification/evidence scoring.
  const techTokens = [
    'java', 'kotlin', 'scala', 'groovy', 'jvm',
    'javascript', 'typescript', 'node', 'nodejs', 'node.js', 'deno',
    'react', 'next.js', 'nextjs', 'nextjs', 'vue', 'nuxt', 'angular', 'svelte', 'solid.js', 'solidstart', 'qwik',
    'html', 'css', 'sass', 'scss', 'less', 'tailwind', 'bootstrap', 'material-ui', 'mui', 'chakra ui',
    'python', 'django', 'flask', 'fastapi', 'fast api', 'tornado', 'numpy', 'pandas', 'matplotlib', 'scikit-learn', 'pytorch', 'tensorflow', 'keras',
    'go', 'golang', 'rust', 'c++', 'c#', 'csharp', '.net', 'dotnet', 'dot net', 'silverlight',
    'php', 'laravel', 'symfony', 'wordpress', 'woocommerce', 'magento', 'drupal', 'joomla', 'codeigniter', 'cakephp', 'yii',
    'ruby', 'rails', 'ruby on rails', 'sinatra', 'merb',
    'swift', 'kotlin multiplatform', 'kotlin/android', 'android', 'ios',
    'kotlin/js', 'kotlin/native', 'compose multiplatform',
    'sql', 'mysql', 'postgresql', 'postgres', 'oracle', 'mssql', 'mariadb', 'cassandra', 'mongodb', 'redis', 'elasticsearch', 'opensearch', 'clickhouse', 'influxdb', 'dynamodb', 'rds', 'aurora',
    'docker', 'kubernetes', 'k8s', 'helm', 'terraform', 'ansible', 'jenkins', 'gitlab ci', 'github actions', 'ci/cd', 'agile', 'scrum', 'kanban', 'cicd', 'devops', 'sre',
    'aws', 'amazon web services', 'gcp', 'google cloud', 'azure', 'oracle cloud', 'oci', 'ibm cloud',
    'rest', 'graphql', 'grpc', 'soap', 'websockets', 'websocket', 'json', 'xml', 'yaml', 'protobuf',
    'spring', 'spring boot', 'springboot', 'hibernate', 'jpa', 'jakarta ee', 'java ee', 'microprofile',
    'express', 'nestjs', 'express.js', 'expressjs', 'fastify', 'hapi', 'koa',
    'next.js', 'nuxt.js', 'nuxtjs',
    'linux', 'unix', 'bash', 'shell', 'zsh', 'powershell', 'terraform', 'chef', 'puppet', 'salt',
    'git', 'svn', 'mercurial', 'bitbucket', 'github', 'gitlab', 'jira', 'confluence', 'slack', 'teams',
    'salesforce', 'tableau', 'power bi', 'powerbi', 'looker', 'qlik', 'sas', 'spss', 'excel', 'vba',
    'machine learning', 'ml', 'deep learning', 'data science', 'nlp', 'natural language processing', 'computer vision', 'predictive analytics', 'llm', 'large language model',
    'postgresql', 'mysql', 'mssql', 'oracle', 'mongodb', 'cassandra', 'redis', 'elasticsearch',
    'kafka', 'rabbitmq', 'zeromq', 'mqtt', 'activemq', 'celery', 'redis queues',
    'react native', 'flutter', 'xamarin', 'ionic', 'capacitor', 'cordova',
    'blockchain', 'web3', 'ethereum', 'solidity', 'nft', 'defi', 'smart contract',
    'unity', 'unreal engine', 'cocos', 'godot', 'game development',
    'adobe', 'photoshop', 'illustrator', 'figma', 'sketch', ' XD', 'invision', 'zeplin',
    'uml', 'system design', 'architecture', 'microservices', 'microservices', 'event-driven', 'event sourcing', 'cqrs', 'ddd',
    'ci/cd', 'testing', 'unit testing', 'integration testing', 'e2e', 'end-to-end', 'selenium', 'cypress', 'playwright', 'jest', 'mocha', 'pytest', 'rspec', 'junit', 'testng',
  ];
  for (const t of techTokens) {
    if (hay.includes(t)) found.add(t);
  }
  // also collect title tokens as tech hints when they look like tech
  const titleTokens = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of titleTokens) {
    if (techTokens.includes(t)) found.add(t);
  }
  return Array.from(found);
}

function extractResponsibilities(desc: string | null): string[] {
  if (!desc) return [];
  const out: string[] = [];
  // capture bullet lines — lines starting with a bullet marker or a number
  const lines = desc.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(\d+[\.\)]\s*|\*\s*|\-\s*|\•\s*|\u2022\s*)/.test(line)) {
      const cleaned = line.replace(/^(\d+[\.\)]\s*|\*\s*|\-\s*|\•\s*|\u2022\s*)/, '').trim();
      if (cleaned.length > 6 && cleaned.length < 400) out.push(cleaned);
    }
  }
  // cap — too many bullets is noise
  if (out.length > 15) out.length = 15;
  return out;
}

function extractKeyRequirements(desc: string | null, title: string): string[] {
  if (!desc) return [];
  const out: string[] = [];
  const hay = desc.toLowerCase();
  // "required"/"must-have"/"you will" sections
  const requiredSections = [
    /(?:required|must[- ]?have|you will|you'll|we are looking for|we're looking for|candidates should|the ideal candidate|what you'll do|what you will do|your profile|your skills|you should have|you must have|minimum qualifications|qualifications|prerequisites|pre-requisites)/i,
  ];
  const candidates: string[] = [];
  for (const re of requiredSections) {
    const m = desc.match(new RegExp(`(${re.source}[\\s\\S]{0,600})`, 'i'));
    if (m) candidates.push(m[0]);
  }
  // also capture lines that look like requirement bullets
  const lines = desc.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(required|must|minimum|prerequisite|qualification|you will|you'll|you should|you must|the ideal)/i.test(line)) {
      const cleaned = line.replace(/^(required|must|minimum|prerequisite|qualification|you will|you'll|you should|you must|the ideal)[:\s]*/i, '').trim();
      if (cleaned.length > 6 && cleaned.length < 400) out.push(cleaned);
    }
  }
  // merge section snippets
  for (const s of candidates) {
    const snippet = s.replace(/^(required|must|minimum|prerequisite|qualification|you will|you'll|you should|you must|the ideal)[:\s]*/i, '').trim();
    if (snippet.length > 6 && snippet.length < 400) out.push(snippet);
  }
  // dedupe roughly
  const seen = new Set<string>();
  const result: string[] = [];
  for (const r of out) {
    const key = r.slice(0, 60).toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(r); }
  }
  if (result.length > 12) result.length = 12;
  return result;
}

function extractDaysAgo(desc: string | null): number | null {
  if (!desc) return null;
  const m = desc.match(/(\d+)\s*(?:days?|day|hours?|hour|minutes?|minute|seconds?|second|seconds?|minute)s?\s*(?:ago|old|since)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > 0 && n < 3650) return n;
  }
  return null;
}

function extractSourceHint(title: string, desc: string | null, url: string | null): string | null {
  // best-effort: if url contains a known hostname, surface it
  const hosts = [
    'remotive.com', 'remoteok.com', 'we-work-remotely', 'weworkremotely', 'weworkremotely.com',
    'monsterindia.com', 'naukri.com', 'finn.no', 'a1group.no', 'workable.com', 'micro1.io',
    'foundever.com', 'bicsom.com', 'linkedin.com', 'indeed', 'glassdoor', 'angel', 'wellfound',
  ];
  if (url) {
    for (const h of hosts) {
      if (url.toLowerCase().includes(h)) return h;
    }
  }
  // fallback: title-based hint
  const hay = `${title} ${desc ?? ''}`.toLowerCase();
  if (hay.includes('naukri') || hay.includes('naukri.com')) return 'naukri.com';
  if (hay.includes('monster') || hay.includes('monsterindia')) return 'monsterindia.com';
  if (hay.includes('linkedin') || hay.includes('linkedin.com')) return 'linkedin.com';
  if (hay.includes('indeed')) return 'indeed.com';
  if (hay.includes('angel') || hay.includes('wellfound')) return 'wellfound.com';
  if (hay.includes('remoteok') || hay.includes('remote ok')) return 'remoteok.com';
  if (hay.includes('remotive')) return 'remotive.com';
  if (hay.includes('a1 group') || hay.includes('a1group') || hay.includes('a1 group as')) return 'a1group.no';
  if (hay.includes('finn') || hay.includes('finn.no')) return 'finn.no';
  if (hay.includes('workable')) return 'workable.com';
  if (hay.includes('micro1')) return 'micro1.io';
  if (hay.includes('foundever')) return 'foundever.com';
  if (hay.includes('bicsom')) return 'bicsom.com';
  return null;
}

@Injectable()
export class JobDescriptionExtractorService {
  extract(from: { title: string; company: string; url: string | null; description: string | null }): ExtractedJob {
    const title = from.title.trim();
    const company = from.company.trim();
    const url = from.url?.trim() ?? null;
    const description = from.description?.trim() ?? null;

    const techStack = extractTechStack(description, title);
    // extractedSkills = techStack deduped, plus a few obvious role tokens from the title
    const extractedSkills = Array.from(new Set([...techStack]));
    // de-duplicate with title (no point listing 'react' twice when it's in techStack already)
    const titleSkills: string[] = [];
    const titleLower = title.toLowerCase();
    const knownTitleSkills = ['react', 'next.js', 'nextjs', 'vue', 'angular', 'node', 'nodejs', 'python', 'java', 'go', 'golang', 'rust', 'php', 'laravel', 'ruby', 'rails', 'swift', 'kotlin', 'android', 'ios', 'devops', 'sre', 'ml', 'data science', 'postgres', 'mysql', 'mongodb', 'redis', 'docker', 'kubernetes', 'terraform', 'aws', 'azure', 'gcp', 'oci'];
    for (const s of knownTitleSkills) {
      if (titleLower.includes(s) && !extractedSkills.includes(s)) titleSkills.push(s);
    }
    extractedSkills.push(...titleSkills);
    // stable order
    extractedSkills.sort();

    return {
      title,
      company,
      url,
      description,
      extractedSkills,
      responsibilities: extractResponsibilities(description),
      keyRequirements: extractKeyRequirements(description, title),
      techStack,
      location: extractLocation(description, null),
      employmentType: extractEmploymentType(title, description ?? ''),
      salaryRange: extractSalaryRange(description),
      applyChannel: extractApplyChannel(title, description ?? ''),
      openingType: extractOpeningType(title, description ?? ''),
      daysAgo: extractDaysAgo(description),
      sourceHint: extractSourceHint(title, description, url),
    };
  }
}
