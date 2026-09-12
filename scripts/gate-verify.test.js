#!/usr/bin/env node
/**
 * Control-plane hardening tests (2026-09-12 operator-directed):
 *
 *   [A] the render verifier asserts the row's ACTIVE status button — and the exact regression
 *       that motivated it (a row whose NOTE says "done by agent" while its status is pending)
 *       MUST fail a `done` check. Substring matching passed that case; this verifier must not.
 *   [B] markup drift fails LOUDLY instead of passing silently.
 *   [C] the evidence marker check is scoped to the row.
 *   [D] the page still emits the markup the verifier parses, and still sends Cache-Control: no-store.
 *   [E] gate-auth refuses to run without MYSQL_HOST / MYSQL_PORT (no silent localhost:3306).
 *   [F] gate-status.js no longer decides a status by substring.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const V = require(path.join(REPO, 'scripts/lib/gate-render-verify.js'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

// The page's real labels (STATUS_META, emoji stripped by the controller): every row therefore
// contains the literal text ">done<" no matter what its status is — which is exactly why a
// substring status check could never fail.
const LABEL = { pending: 'pending', in_progress: 'in progress', done: 'done', blocked: 'blocked' };
const KEYS = ['pending', 'in_progress', 'done', 'blocked'];

/** A checklist row rendered EXACTLY the way ProjectStatusPageController emits it. */
function row(queryId, current, note) {
  const buttons = KEYS
    .map((s) => `<form class="inline" method="post" action="/project-status/item/${queryId}/status"><input type="hidden" name="status" value="${s}"/><button class="mini${s === current ? ' active' : ''}" ${s === current ? 'disabled' : ''}>${LABEL[s].replace(/^[^ ]+ /, '')}</button></form>`)
    .join('');
  return `<tr id="item-${queryId}" class="row-${current}">\n<td>#1</td><td>${buttons}\n<form class="noteform" method="post" action="/project-status/item/${queryId}/note"><input type="text" name="note" value="${note}" placeholder="note…" maxlength="500"/><button type="submit">save</button></form></td>\n</tr>`;
}
const page = (rows) => `<!doctype html><html><body><table>${rows.join('\n')}</table></body></html>`;

// -------------------------------------------------------------------- [A]
console.log('\n[A] the active status button is what gets asserted');
{
  const html = page([row(38, 'done', '[2026-09-12 10:24 IST done by agent] verified: test 80/80 (gate-sync 20260912045405)')]);
  const good = V.verifyRenderedStatus(html, 38, 'done');
  ok('a done row verifies for done', good.ok, good.reason);
  eq('and reports the active status', good.activeStatus, 'done');
  eq('all four status buttons were parsed', good.buttons.length, 4);
  ok('exactly one is active', good.buttons.filter((b) => b.active).length === 1);

  // THE REGRESSION: note text says "done", status is pending
  const sneaky = page([row(38, 'pending', '[2026-09-12 10:24 IST done by agent] verified: test 80/80 (gate-sync 20260912045405)')]);
  const bad = V.verifyRenderedStatus(sneaky, 38, 'done');
  ok('a pending row whose NOTE says "done" FAILS a done check', bad.ok === false, 'verifier wrongly accepted it');
  ok('...and the reason names the real active status', /shows status "pending" as active/.test(bad.reason || ''), bad.reason);
  eq('...while a pending check on the same row passes', V.verifyRenderedStatus(sneaky, 38, 'pending').ok, true);
  // the old substring logic would have passed it — prove the difference explicitly
  const chunk = V.rowChunk(sneaky, 38);
  const oldCheckWouldPass =
    chunk.includes('value="done" selected') ||
    chunk.includes('>done<') ||
    chunk.replace(/<[^>]+>/g, ' ').includes('done');
  ok('the old substring test WOULD have passed that pending row (why this change was needed)', oldCheckWouldPass);
  ok('...because every row renders the done button label ">done<" whatever its status', chunk.includes('>done<'));
  ok('...and the evidence text itself contains the word done', chunk.replace(/<[^>]+>/g, ' ').includes('done'));

  const inprog = page([row(877, 'in_progress', 'lane noted')]);
  ok('in_progress verifies for in_progress', V.verifyRenderedStatus(inprog, 877, 'in_progress').ok);
  ok('...and NOT for done', V.verifyRenderedStatus(inprog, 877, 'done').ok === false);
}

// -------------------------------------------------------------------- [B]
console.log('\n[B] markup drift fails loudly');
{
  ok('a missing row fails', V.verifyRenderedStatus(page([row(1, 'done', 'x')]), 999, 'done').ok === false);
  ok('...saying the row is absent', /not present/.test(V.verifyRenderedStatus(page([row(1, 'done', 'x')]), 999, 'done').reason || ''));

  const noButtons = page(['<tr id="item-5" class="row-done"><td>status form gone: /project-status/item/5/status</td></tr>']);
  const drift = V.verifyRenderedStatus(noButtons, 5, 'done');
  ok('a row with no parseable status buttons fails', drift.ok === false);
  ok('...naming the drift', /markup drifted/.test(drift.reason || ''), drift.reason);

  const twoActive = page([`<tr id="item-7" class="row-done"><td><form class="inline" method="post" action="/project-status/item/7/status"><input type="hidden" name="status" value="pending"/><button class="mini active">pending</button></form><form class="inline" method="post" action="/project-status/item/7/status"><input type="hidden" name="status" value="done"/><button class="mini active" disabled>done</button></form></td></tr>`]);
  const dbl = V.verifyRenderedStatus(twoActive, 7, 'done');
  ok('two active buttons fail', dbl.ok === false, dbl.reason);
  ok('...saying how many were active', /rendered 2 active status buttons/.test(dbl.reason || ''), dbl.reason);

  const notDisabled = page([`<tr id="item-9" class="row-done"><td><form class="inline" method="post" action="/project-status/item/9/status"><input type="hidden" name="status" value="done"/><button class="mini active">done</button></form></td></tr>`]);
  const nd = V.verifyRenderedStatus(notDisabled, 9, 'done');
  ok('an active-but-not-disabled button fails', nd.ok === false);
  ok('...naming the drift', /does not disable/.test(nd.reason || ''), nd.reason);
}

// -------------------------------------------------------------------- [C]
console.log('\n[C] the marker check is scoped to the row');
{
  const html = page([row(38, 'done', 'evidence (gate-sync 20260912045405)'), row(39, 'done', 'other row note')]);
  ok('the marker is found on its own row', V.verifyMarkerRendered(html, 38, 'gate-sync 20260912045405'));
  ok('...and not on a row that does not carry it', V.verifyMarkerRendered(html, 39, 'gate-sync 20260912045405') === false);
  ok('a missing row reports no marker', V.verifyMarkerRendered(html, 404, 'gate-sync 20260912045405') === false);
}

// -------------------------------------------------------------------- [D]
console.log('\n[D] the page still emits what the verifier parses, and still sends no-store');
{
  const ctrl = fs.readFileSync(path.join(REPO, 'src/project-status/project-status-page.controller.ts'), 'utf8');
  ok('the status-form template is unchanged in shape', /<form class="inline" method="post" action="\/project-status\/item\/\$\{id\}\/status"><input type="hidden" name="status" value="\$\{s\}"\/><button class="mini\$\{s === it\.status \? ' active' : ''\}"/.test(ctrl));
  ok('the active button is still disabled when current', /\$\{s === it\.status \? 'disabled' : ''\}/.test(ctrl));
  ok('the page sends Cache-Control: no-store', /res\.set\('Cache-Control', 'no-store'\)/.test(ctrl));
  ok('no-store is set before the html is sent', ctrl.indexOf("res.set('Cache-Control', 'no-store')") < ctrl.indexOf("res.type('html').send(html)"));
  eq('the verifier knows the page\'s four statuses', V.STATUS_KEYS, ['pending', 'in_progress', 'done', 'blocked']);
}

// -------------------------------------------------------------------- [E]
console.log('\n[E] gate-auth refuses a missing DB target (no silent localhost:3306)');
{
  const auth = require(path.join(REPO, 'scripts/lib/gate-auth.js'));
  const saved = { MYSQL_HOST: process.env.MYSQL_HOST, MYSQL_PORT: process.env.MYSQL_PORT };
  try {
    delete process.env.MYSQL_HOST; delete process.env.MYSQL_PORT;
    let e1 = null; try { auth.dbTarget(); } catch (e) { e1 = e; }
    ok('missing MYSQL_HOST throws', !!e1);
    ok('...and the message refuses localhost/3306 explicitly', /Refusing to let mysql2 default to localhost/.test(e1 ? e1.message : '') && /3306/.test(e1 ? e1.message : ''));

    process.env.MYSQL_HOST = '127.0.0.1';
    let e2 = null; try { auth.dbTarget(); } catch (e) { e2 = e; }
    ok('missing MYSQL_PORT throws', !!e2);
    ok('...naming the 3306 default it refuses', /Refusing to let mysql2 default to 3306/.test(e2 ? e2.message : ''));

    process.env.MYSQL_PORT = 'not-a-port';
    let e3 = null; try { auth.dbTarget(); } catch (e) { e3 = e; }
    ok('a non-numeric port throws', !!e3);

    process.env.MYSQL_HOST = '127.0.0.1'; process.env.MYSQL_PORT = '3307';
    eq('the tunnel target is returned when set', auth.dbTarget(), { host: '127.0.0.1', port: 3307 });
    ok('no default port is invented when one is given', auth.dbTarget().port !== 3306);
  } finally {
    if (saved.MYSQL_HOST === undefined) delete process.env.MYSQL_HOST; else process.env.MYSQL_HOST = saved.MYSQL_HOST;
    if (saved.MYSQL_PORT === undefined) delete process.env.MYSQL_PORT; else process.env.MYSQL_PORT = saved.MYSQL_PORT;
  }
}

// -------------------------------------------------------------------- [F]
console.log('\n[F] the writer no longer decides a status by substring');
{
  const w = fs.readFileSync(path.join(REPO, 'scripts/gate-status.js'), 'utf8');
  ok('it requires the shared render verifier', /require\('\.\/lib\/gate-render-verify'\)/.test(w));
  ok('it calls verifyRenderedStatus for the status check', /statusCheck = verifyRenderedStatus\(html, row\.id, target\)/.test(w));
  ok('it no longer uses the old substring status test', !/chunk\.includes\(`value="\$\{target\}" selected`\)/.test(w) && !/rendered\.includes\(target\)/.test(w));
  ok('it no longer tests the note-stripped chunk for the status', !/stripTags\(chunk\)\.includes\(target\)/.test(w));
  ok('the marker check is the shared row-scoped one', /verifyMarkerRendered\(html, row\.id, tag\)/.test(w));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
