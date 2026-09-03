const assert = require('node:assert/strict');
const { classifyCompanyUrl, isPortalHost, bareHost } = require('../dist/applications/direct-channel.detector');

// ---- pure classification ------------------------------------------------
const cases = [
  // [url, expected class]
  ['https://stripe.com/jobs/listing/software-engineer/5644613', 'company-specific'],
  ['https://www.bihartechnogroup.com/jobs/php-web-developer', 'company-specific'],
  ['https://www.anthropic.com/careers/member-of-technical-staff', 'company-specific'],
  ['https://boards.greenhouse.io/methakon/jobs/12345', 'board'],
  ['https://jobs.lever.co/methakon/abc123', 'board'],
  ['https://jobs.workable.com/methakon/jobs/999', 'board'],
  ['https://a1group.wd3.myworkdayjobs.com/A1_Jobs_bg/job/Sofia/JS-Full-Stack-Developer_REQ-8297/apply', 'board'],
  ['https://www.airbnb.com/careers', 'company-index'],
  ['https://www.coinbase.com/careers/jobs', 'company-index'],
  ['https://www.naukri.com/job/xyz', 'portal'],
  ['https://remoteok.com/remote-jobs/123', 'portal'],
  ['https://www.linkedin.com/jobs/view/123', 'portal'],
  ['https://press.lyft.com/news-characteristics-of-lyfts-remote-work-policy', 'other'],
  ['https://www.klaviyo.com/', 'other'],
  ['https://example.com/not-a-job-page', 'other'],
];
for (const [url, expected] of cases) {
  assert.equal(classifyCompanyUrl(url), expected, `${url} should classify as ${expected}`);
}

// ---- host helpers --------------------------------------------------------
assert.equal(isPortalHost('www.naukri.com'), true, 'naukri is a portal host');
assert.equal(isPortalHost(bareHost('https://jobs.lever.co/x/y')), false, 'lever is not a portal host');
assert.equal(bareHost('https://WWW.Stripe.COM/jobs'), 'stripe.com', 'host normalized');

console.log(`Company-apply-link classifier tests passed (${cases.length} cases)`);
