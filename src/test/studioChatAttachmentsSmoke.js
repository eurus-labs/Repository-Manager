// Files and folders attached to a Studio Chat (plan 7): the host's checks of every entry and the budget.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = name => require(path.join(__dirname, '../../out/studio', name));
const { acceptEntry, recheck, budgetFor, fitFiles, attachedLine, MAX_ATTACHMENTS } = out('chatAttachments.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-attachments-'));
const root = path.join(base, 'ws');
const outside = path.join(base, 'outside');
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.mkdirSync(path.join(root, '.repository-manager/maps'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, 'docs/small.md'), '# Small\n'.repeat(250));
fs.writeFileSync(path.join(root, 'docs/medium.txt'), 'x'.repeat(300 * 1024));
fs.writeFileSync(path.join(root, 'notes.pdf'), Buffer.from([37, 80, 68, 70, 0, 1]));
fs.writeFileSync(path.join(root, 'six.txt'), Buffer.alloc(6 * 1024 * 1024, 97));
fs.writeFileSync(path.join(root, '.repository-manager/maps/docs.md'), '# map');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
fs.symlinkSync(outside, path.join(root, 'linkdir'));
fs.symlinkSync(path.join(root, 'docs/small.md'), path.join(root, 'inlink.md'));
fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'inlinkdir'));
const uri = fsPath => ({ scheme: 'file', fsPath });
const accept = (target, existing = [], scheme = 'file') => acceptEntry(root, { scheme, fsPath: target }, existing);

// ---- Accept: each refusal with its reason.
const refused = (result, pattern) => { assert.equal(result.ok, false); assert.match(result.reason, pattern); };
refused(accept(path.join(outside, 'secret.txt')), /outside the workspace/);
refused(accept(path.join(root, 'link.txt')), /resolves outside the workspace/);
refused(accept(path.join(root, 'linkdir')), /resolves outside the workspace/);
refused(accept(path.join(root, 'inlink.md')), /symbolic link/);
refused(accept(path.join(root, 'inlinkdir')), /symbolic link/);
refused(accept(path.join(root, 'inlinkdir/small.md')), /symbolic link/);
refused(accept(path.join(root, 'notes.pdf')), /binary file/);
refused(accept(path.join(root, 'six.txt')), /larger than 5 MB/);
refused(accept(root), /workspace root/);
refused(accept(path.join(root, '.repository-manager/maps/docs.md')), /maps/);
refused(accept(path.join(root, '.repository-manager/maps')), /maps/);
refused(accept(path.join(root, 'nope.md')), /does not exist/);
refused(accept(path.join(root, 'docs/small.md'), [], 'https'), /not a file on this machine/);
refused(acceptEntry(undefined, uri(path.join(root, 'docs/small.md')), []), /open a folder/);
const twelve = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({ path: `f${i}.md`, kind: 'file' }));
refused(accept(path.join(root, 'docs/small.md'), twelve), /at most 10/);

// A folder, a 2 KB file and a 300 KB text file are accepted; a duplicate is ignored.
assert.deepEqual(accept(path.join(root, 'docs')), { ok: true, attachment: { path: 'docs', kind: 'folder' } });
assert.deepEqual(accept(path.join(root, 'docs/small.md')), { ok: true, attachment: { path: 'docs/small.md', kind: 'file' } });
assert.deepEqual(accept(path.join(root, 'docs/medium.txt')), { ok: true, attachment: { path: 'docs/medium.txt', kind: 'file' } });
const dup = accept(path.join(root, 'docs/small.md'), [{ path: 'docs/small.md', kind: 'file' }]);
assert.equal(dup.ok, false); assert.equal(dup.duplicate, true);

// ---- The checks run again at send time.
assert.equal(recheck(root, { path: 'docs/small.md', kind: 'file' }), undefined);
assert.match(recheck(root, { path: 'gone.md', kind: 'file' }), /does not exist/);
assert.match(recheck(root, { path: 'notes.pdf', kind: 'file' }), /binary/);
assert.match(recheck(root, { path: 'link.txt', kind: 'file' }), /resolves outside/);
assert.match(recheck(root, { path: 'inlink.md', kind: 'file' }), /symbolic link/);
assert.match(recheck(root, { path: 'docs', kind: 'file' }), /is now a folder/);

// ---- Budget.
assert.equal(budgetFor(200_000), 240_000);
assert.equal(budgetFor(undefined), 60_000);
assert.equal(budgetFor(10_000), 60_000);
assert.equal(budgetFor(1_000_000), 300_000);
{
  const a = 'a'.repeat(30_000), b = 'b'.repeat(40_000), c = 'c'.repeat(10_000);
  const fits = fitFiles([
    { path: 'a.md', text: a, bytes: a.length },
    { path: 'b.md', text: b, bytes: b.length, summary: 'SUMMARY OF B' },
    { path: 'c.md', text: c, bytes: c.length }
  ], 60_000);
  assert.deepEqual(fits.map(fit => fit.form), ['full', 'summary', 'full']);
  assert.equal(fits[0].content, a, 'nothing is cut mid-text');
  assert.equal(fits[1].content, 'SUMMARY OF B');
  // The third does not fit once the first two are in: an outline instead.
  const tight = fitFiles([
    { path: 'a.md', text: a, bytes: a.length },
    { path: 'b.md', text: b, bytes: b.length, summary: 'S'.repeat(29_000) },
    { path: 'c.md', text: '# C\n\nShort.\n\n' + c, bytes: c.length + 20 }
  ], 60_000);
  assert.deepEqual(tight.map(fit => fit.form), ['full', 'summary', 'outline']);
  // No summary for the second: an outline, and it asks for one.
  const missing = fitFiles([{ path: 'b.md', text: b, bytes: b.length }, { path: 'c.md', text: c, bytes: c.length }], 30_000);
  assert.deepEqual(missing.map(fit => fit.form), ['outline', 'full']);
  assert.equal(missing[0].needsSummary, true);
  // A 300 KB file always goes as an outline.
  const huge = 'x '.repeat(150 * 1024);
  const [one] = fitFiles([{ path: 'h.txt', text: huge, bytes: huge.length, summary: 'ignored' }], 300_000);
  assert.equal(one.form, 'outline');
  assert.ok(one.content.length < 3_001);
  // A budget with no room left: not sent, with the reason.
  const [none] = fitFiles([{ path: 'a.md', text: a, bytes: a.length }], 100);
  assert.deepEqual([none.form, none.reason], ['not sent', 'over the budget']);
}

// ---- The bubble's line.
assert.equal(attachedLine([
  { path: 'a.md', kind: 'file', sent: { full: 1, summary: 0, outline: 0, notSent: 0 } },
  { path: 'docs/req', kind: 'folder', sent: { full: 9, summary: 2, outline: 1, notSent: 0 } }
]), 'with a.md, docs/req (12 files: 9 full, 2 summary, 1 outline)');

fs.rmSync(base, { recursive: true, force: true });
console.log('Studio chat attachments smoke test passed');
