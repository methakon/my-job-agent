/**
 * J-14 — write-path unicode sanitizer for CV/application text.
 *
 * PDFKit (and other ATS writers) throw or render garbage on control characters
 * (U+0000–U+001F, U+007F–U+009F) and unpaired surrogates. Stored data was
 * repaired earlier; this guards the WRITE path so any future dirty input is
 * stripped before it reaches the PDF/JSON writer.
 */

/** Replace control chars (except tab/newline/CR which PDFKit handles) with a
 *  space, collapse, and drop unpaired surrogates + zero-width junk. */
export function sanitizeText(input: unknown): string {
	if (input === null || input === undefined) return '';
	let s = String(input);
	// eslint-disable-next-line no-control-regex
	s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ');
	// zero-width / bidi-override / object-replacement junk
	s = s.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF\uFFFC]/g, '');
	// unpaired surrogates → space
	s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, ' ').replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ' ');
	// collapse repeated spaces
	s = s.replace(/[ \t]{2,}/g, ' ').trim();
	return s;
}

/** Deep-sanitize every string leaf of a structure (profile, workHistory…). */
export function sanitizeDeep<T>(value: T): T {
	if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v)) as unknown as T;
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = sanitizeDeep(v);
		}
		return out as T;
	}
	if (typeof value === 'string') return sanitizeText(value) as unknown as T;
	return value;
}
