/**
 * Render verification for the /project-status control plane.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The gate writer used to decide whether a status write had rendered with substring tests:
 *   rendered.includes(target) || chunk.includes(`value="${target}" selected`) || chunk.includes(`>${target}<`)
 * Every one of those can be satisfied WITHOUT the row actually being in that status:
 *   * the row renders one button per status (pending / in_progress / done / blocked), so the
 *     literal text "done" appears in EVERY row's HTML;
 *   * the tag-stripped chunk contains the note, and the writer's own evidence block contains the
 *     phrase "done by agent" — so a `done` check passed on the NOTE while the row was pending.
 * A control plane that can be "verified" by a word in a comment is not verified. This module
 * asserts the ONE thing that is actually true only when the row is in the target status: the
 * button inside the status form carrying that value is the one marked `active` (and `disabled`,
 * which the page only does for the current status).
 *
 * It parses the same markup the page emits (see the template in
 * src/project-status/project-status-page.controller.ts, pinned by gate-verify.test.js) and FAILS
 * LOUDLY on markup drift — a guard that silently stops matching is worse than no guard.
 */

/** The statuses the page offers, in page order. */
const STATUS_KEYS = ['pending', 'in_progress', 'done', 'blocked'];

/**
 * One status form: hidden input carrying the status value + its button.
 * Matches `<form class="inline" method="post" action="..."><input type="hidden" name="status"
 * value="X"/><button class="mini[ active]" [disabled]>Label</button>`.
 */
const STATUS_FORM_RE =
	/<form class="inline"[^>]*>\s*<input type="hidden" name="status" value="([a-z_]+)"\s*\/?>\s*<button class="mini([^"]*)"([^>]*)>([^<]*)<\/button>/g;

/** The `<tr>` block belonging to a checklist row (identified by its status-form action). */
function rowChunk(html, id) {
	return String(html || '').split('<tr ').find((c) => c.includes(`/project-status/item/${id}/status`)) ?? '';
}

/** Every parsed status form in a row chunk, in page order. */
function parseStatusButtons(chunk) {
	const out = [];
	STATUS_FORM_RE.lastIndex = 0;
	let m;
	while ((m = STATUS_FORM_RE.exec(chunk)) !== null) {
		out.push({
			status: m[1],
			className: m[2].trim(),
			attributes: m[3],
			label: m[4].trim(),
			active: /(^|\s)active(\s|$)/.test(m[2]),
			disabled: /\bdisabled\b/.test(m[3]),
		});
	}
	return out;
}

/**
 * Assert that the page shows `target` as the row's status.
 * Returns { ok, activeStatus, buttons, reason } — `reason` is null when ok.
 */
function verifyRenderedStatus(html, id, target) {
	const chunk = rowChunk(html, id);
	if (!chunk) return { ok: false, activeStatus: null, buttons: [], reason: `row [${id}] is not present in the rendered page` };

	const buttons = parseStatusButtons(chunk);
	if (!buttons.length) {
		return { ok: false, activeStatus: null, buttons, reason: `row [${id}] rendered no status buttons — the page markup drifted away from the form this verifier parses` };
	}

	const active = buttons.filter((b) => b.active);
	if (active.length !== 1) {
		return { ok: false, activeStatus: null, buttons, reason: `row [${id}] rendered ${active.length} active status buttons (expected exactly 1)` };
	}
	if (active[0].status !== target) {
		return { ok: false, activeStatus: active[0].status, buttons, reason: `row [${id}] shows status "${active[0].status}" as active, expected "${target}"` };
	}
	if (!active[0].disabled) {
		return { ok: false, activeStatus: active[0].status, buttons, reason: `row [${id}] marks "${target}" active but does not disable it — markup drifted` };
	}
	return { ok: true, activeStatus: target, buttons, reason: null };
}

/** Does the row chunk carry this exact evidence marker (proves THIS write rendered)? */
function verifyMarkerRendered(html, id, marker) {
	const chunk = rowChunk(html, id);
	if (!chunk) return false;
	return chunk.includes(marker);
}

module.exports = { STATUS_KEYS, STATUS_FORM_RE, rowChunk, parseStatusButtons, verifyRenderedStatus, verifyMarkerRendered };
