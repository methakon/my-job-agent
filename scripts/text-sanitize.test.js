const assert = require('node:assert/strict');
const { sanitizeText, sanitizeDeep } = require('../dist/applications/text-sanitize');

// control chars stripped
assert.equal(sanitizeText('a\u0000b\u0007c'), 'a b c');
// null byte alone → empty
assert.equal(sanitizeText('\u0000'), '');
// tab/newline preserved (PDF handles them)
assert.equal(sanitizeText('x\ty\nz'), 'x\ty\nz');
// zero-width junk removed
assert.equal(sanitizeText('a\u200Bb\uFEFFc'), 'abc');
// unpaired surrogate → space (not a crash)
assert.ok(!/[\uD800-\uDFFF]/.test(sanitizeText('bad\uD800surrogate')));
// deep sanitize arrays/objects
const out = sanitizeDeep({ a: 'x\u0000y', list: ['p\u0001q', { z: 'ok\u200B' }] });
assert.equal(out.a, 'x y');
assert.equal(out.list[0], 'p q');
assert.equal(out.list[1].z, 'ok');
// non-string passthrough
assert.equal(sanitizeDeep(42), 42);
assert.equal(sanitizeDeep(null), null);
console.log('text-sanitize: ALL PASS');
