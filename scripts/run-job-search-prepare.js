#!/usr/bin/env node
/**
 * Run the job-search/prepare loop once: fetch fresh leads from enabled
 * scout sources, register any new leads in job_leads with a match score,
 * then run the pre-apply prepare loop (tailored CV + email draft + channel
 * + astro score + muhurta window) for leads above the threshold.
 *
 * All mutations go through the running service (localhost:3010), never a
 * direct DB connection. Read-only info is fetched from GET endpoints.
 */
const BASE = process.env.AGENT_BASE_URL || 'http://localhost:3010';
const AUTH = process.env.SESSION_PASSWORD || '';

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH) h['x-operator-password'] = AUTH;
  return h;
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.warn(`[${method} ${path}] ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  console.log('=== JOB SEARCH + PREPARE RUN ===');
  console.log('base:', BASE);

  // 1) current lead inbox snapshot
  console.log('\n[1] current leads (new/ready):');
  const leads = await req('GET', '/leads');
  const leadsArr = Array.isArray(leads) ? leads : [];
  const grouped = { new: [], other: [] };
  for (const l of leadsArr) {
    if (l.status === 'new') grouped.new.push(l);
    else grouped.other.push(l);
  }
  console.log(`  total leads: ${leadsArr.length}`);
  console.log(`  new (unsent): ${grouped.new.length}`);
  console.log(`  other: ${grouped.other.length}`);
  if (grouped.new.length) {
    console.log('  new leads:');
    for (const l of grouped.new.slice(0, 20)) {
      console.log(`    - ${l.source} ${l.id} | ${l.title} @ ${l.company} | match ${l.matchScore ?? '?'}`);
    }
  }

  // 2) preparation run via auto-apply controller
  console.log('\n[2] running prepare loop (POST /auto-apply/run):');
  const prep = await req('POST', '/auto-apply/run');
  console.log('  result:', JSON.stringify(prep));

  // 3) pre-apply queue after prepare
  console.log('\n[3] pre-apply queue after prepare:');
  const queue = await req('GET', '/pre-apply');
  const qArr = Array.isArray(queue) ? queue : [];
  const byStatus = { ready: 0, approved: 0, hold: 0, sent: 0, failed: 0, other: 0 };
  for (const i of qArr) {
    if (byStatus[i.status] !== undefined) byStatus[i.status]++;
    else byStatus.other++;
  }
  console.log(`  queue size: ${qArr.length}`);
  console.log('  by status:', byStatus);
  if (qArr.length) {
    console.log('  recent items:');
    for (const i of qArr.slice(0, 15)) {
      console.log(`    - ${i.id} | ${i.source} ${i.leadId} | ${i.status} | astro ${i.astroScore} | match ${i.matchScore} | cv ${i.cvPath ? 'yes' : 'no'}`);
    }
  }

  console.log('\n=== DONE ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
