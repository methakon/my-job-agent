/**
 * gate-exemptions.js — the committed, auditable source for the drift guard's
 * EXISTING --allow mechanism.
 *
 * Why this exists: `/project-status`'s drift guard (scripts/gate-close-check.js)
 * accepts `--allow <sha,...>` / `GATE_CLOSE_ALLOW=<sha,...>` — but only for ONE
 * invocation. A push runs the guard from the pre-push hook, where there is no
 * operator-supplied flag, so a legitimate commit that belongs to a DIFFERENT
 * workstream (tracked in its own control plane, not in project_checklist_items)
 * could never be exempted and would block every push forever.
 *
 * This module is that persistent source, and it is deliberately NARROW:
 *   • exact SHAs only — full 40-char or >=7-char short form. No globs, no
 *     ranges, no paths, no "everything from <date>". One entry exempts one
 *     commit and nothing else.
 *   • every entry MUST carry a non-empty reason, workstream and authority.
 *     An entry missing any of them is IGNORED (a blank reason cannot exempt).
 *   • it only ADDS to the guard's allow set. Classification is unchanged for
 *     every other commit: classifyCommit() still returns 'drift' for anything
 *     unlisted, so detection is not weakened globally.
 *
 * The file lives at docs/gate-close-allow.json (tracked, reviewable in the diff).
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'docs', 'gate-close-allow.json');
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Read + validate the exemption file. Never throws: a broken file yields no exemptions and a problem line. */
function loadExemptions(filePath) {
	const file = filePath || process.env.GATE_CLOSE_ALLOW_FILE || DEFAULT_FILE;
	const problems = [];
	const entries = new Map();
	let raw = null;
	try {
		raw = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		if (e && e.code !== 'ENOENT') problems.push(`${file}: unreadable/!JSON (${e.message}) — no exemptions applied`);
		return { entries, problems, file, exists: e && e.code !== 'ENOENT' };
	}
	const list = raw && typeof raw === 'object' ? raw.exemptions || {} : {};
	const pairs = Array.isArray(list) ? list.map((e) => [e && e.sha, e]) : Object.entries(list);
	for (const [sha, entry] of pairs) {
		const key = String(sha || '').trim().toLowerCase();
		if (!SHA_RE.test(key)) {
			problems.push(`ignored entry with non-SHA key "${sha}" — only exact 7-40 char SHAs may be exempted`);
			continue;
		}
		if (!entry || typeof entry !== 'object') {
			problems.push(`ignored ${key}: entry must be an object carrying reason/workstream/authority`);
			continue;
		}
		const reason = String(entry.reason || '').trim();
		const workstream = String(entry.workstream || '').trim();
		const authority = String(entry.authority || '').trim();
		const missing = [!reason && 'reason', !workstream && 'workstream', !authority && 'authority'].filter(Boolean);
		if (missing.length) {
			problems.push(`ignored ${key}: missing ${missing.join('/')} — an exemption without a reason and an approver is not auditable`);
			continue;
		}
		entries.set(key, { sha: key, reason, workstream, authority, recorded: String(entry.recorded || '').trim() });
	}
	return { entries, problems, file, exists: true };
}

/** Exact-match lookup: full SHA or the commit's 7-char short form. Nothing fuzzy. */
function findExemption(entries, commit) {
	if (!entries || !commit) return null;
	const full = String(commit.sha || '').toLowerCase();
	const short = String(commit.short || full.slice(0, 7)).toLowerCase();
	return entries.get(full) || entries.get(short) || null;
}

/**
 * The guard's decision for one commit, factored out so the exemption branch is
 * testable in isolation. Precedence is unchanged from the original inline chain:
 * recorded evidence > legacy baseline > control-plane tooling > exemption > DRIFT.
 */
function classifyCommit({ hasOwner, isControlPlane, legacyReason, exemption }) {
	if (hasOwner) return 'synced';
	if (legacyReason) return 'legacy';
	if (isControlPlane) return 'cp';
	if (exemption) return 'allowed';
	return 'drift';
}

module.exports = { DEFAULT_FILE, SHA_RE, loadExemptions, findExemption, classifyCommit };
