// Folder maps of the Studio Chat's attached files (plan 7): building a map in a real Git repository,
// the incremental update, the person's edits, failure cases, summaries and outlines. Scripted models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const out = name => require(path.join(__dirname, '../../out/studio', name));
const { prepareAttachments } = out('chatAttachments.js');
const { outline, parseMap, gitIgnored, mapPathOf, describeFromFile } = out('folderMap.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-folder-map-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
let counter = 0;
function repo(useGit = true) {
  const root = fs.mkdtempSync(path.join(base, 'r'));
  if (useGit) { git(root, 'init', '-q'); write(root, '.gitignore', '.env\n'); }
  return root;
}
function proj(root) {
  write(root, 'proj/README.md', '# Proj\n\nA project about things.\n');
  write(root, 'proj/a.ts', '// Helper for a.\nexport function a() {}\n');
  write(root, 'proj/b.ts', 'export const b = 1;\nfunction x() {}\n');
  write(root, 'proj/.env', 'SECRET=1\n');
  fs.writeFileSync(path.join(root, 'proj/img.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
}
/** A scripted model: counts description and summary calls. */
function model(handlers = {}) {
  const m = { describe: 0, summary: 0, prompts: [], fail: false };
  m.complete = async prompt => {
    m.prompts.push(prompt);
    if (m.fail) { throw new Error('model down'); }
    if (/^You describe files/.test(prompt)) {
      m.describe++;
      const paths = [...prompt.matchAll(/^=== (.+) ===$/gm)].map(match => match[1]);
      return JSON.stringify(Object.fromEntries(paths.map(p => [p, handlers.describe ? handlers.describe(p) : `Described ${p}`])));
    }
    m.summary++;
    return handlers.summary ? handlers.summary(prompt) : 'SUMMARY: keeps REQ-1 and REQ-2.';
  };
  return m;
}
const deps = (root, m, extra = {}) => ({
  root, openText: () => undefined, isDirty: () => false, ignored: rel => gitIgnored(root, rel),
  complete: m ? m.complete : undefined, signal: { cancelled: false }, today: '2026-11-20', ...extra
});
const mapText = (root, folder) => fs.readFileSync(path.join(root, mapPathOf(folder)), 'utf8');
const entryOf = (root, folder, file) => parseMap(mapText(root, folder)).find(entry => entry.path === file);
const folderChip = p => ({ path: p, kind: 'folder' });
const fileChip = p => ({ path: p, kind: 'file' });

async function main() {
  // ---- Build: entries, sources, one description call, no entry for the ignored file.
  {
    const root = repo(); proj(root);
    const m = model({ describe: () => 'The constant b' });
    const result = await prepareAttachments([folderChip('proj')], deps(root, m));
    assert.equal(m.describe, 1, 'exactly one description call');
    const entries = parseMap(mapText(root, 'proj'));
    assert.deepEqual(entries.map(entry => entry.path), ['proj/README.md', 'proj/a.ts', 'proj/b.ts', 'proj/img.png']);
    const by = Object.fromEntries(entries.map(entry => [entry.path, entry]));
    assert.equal(by['proj/README.md'].source, 'from the file');
    assert.match(by['proj/README.md'].description, /^Proj: A project about things\./);
    assert.equal(by['proj/a.ts'].source, 'from the file');
    assert.equal(by['proj/a.ts'].description, 'Helper for a.');
    assert.equal(by['proj/b.ts'].source, 'by the model');
    assert.equal(by['proj/img.png'].source, 'binary');
    assert.ok(entries.every(entry => !entry.edited), 'what the Studio wrote is not read back as edited');
    assert.ok(!mapText(root, 'proj').includes('.env'));
    assert.match(mapText(root, 'proj'), /Edit any description or summary; your edit is kept\./);
    assert.match(result.text, /Map \(a file in the repository; a code step can read it\): \.repository-manager\/maps\/proj\.md/);
    assert.match(result.text, /- proj\/b\.ts: The constant b/);
    assert.match(result.text, /^=== proj\/README\.md \(full\) ===$/m);
    assert.doesNotMatch(result.text, /SECRET=1/);
    assert.deepEqual(result.items[0].sent, { full: 3, summary: 0, outline: 0, notSent: 1 });
    assert.equal(result.items[0].map, '.repository-manager/maps/proj.md');

    // ---- Incremental: nothing changed, no call, same bytes.
    const before = fs.readFileSync(path.join(root, mapPathOf('proj')));
    const mtime = fs.statSync(path.join(root, mapPathOf('proj'))).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 20));
    await prepareAttachments([folderChip('proj')], deps(root, m));
    assert.equal(m.describe, 1, 'nothing changed: no model call');
    assert.ok(before.equals(fs.readFileSync(path.join(root, mapPathOf('proj')))), 'the map is byte-identical');
    assert.equal(fs.statSync(path.join(root, mapPathOf('proj'))).mtimeMs, mtime, 'and was not written');

    // b.ts changes: one call, only b.ts's entry changes.
    const beforeEntries = parseMap(mapText(root, 'proj'));
    write(root, 'proj/b.ts', 'export const b = 2;\nfunction y() {}\n');
    await prepareAttachments([folderChip('proj')], deps(root, model({ describe: () => 'Constant b, changed' })));
    const m2 = model({ describe: () => 'unused' });
    const afterEntries = parseMap(mapText(root, 'proj'));
    for (const entry of afterEntries) {
      const old = beforeEntries.find(item => item.path === entry.path);
      if (entry.path === 'proj/b.ts') { assert.notDeepEqual(entry, old); assert.equal(entry.description, 'Constant b, changed'); }
      else { assert.deepEqual(entry, old, `${entry.path} is unchanged`); }
    }
    assert.equal(m2.describe, 0);

    // A removed file drops its entry.
    fs.rmSync(path.join(root, 'proj/a.ts'));
    await prepareAttachments([folderChip('proj')], deps(root, m));
    assert.ok(!parseMap(mapText(root, 'proj')).some(entry => entry.path === 'proj/a.ts'));

    // The person's description is kept after the file changes, marked, and kept again at a second change.
    fs.writeFileSync(path.join(root, mapPathOf('proj')), mapText(root, 'proj').replace(/^description \(from the file\): Proj: .*$/m, 'description (from the file): My own words about the README'));
    assert.equal(entryOf(root, 'proj', 'proj/README.md').edited, true);
    write(root, 'proj/README.md', '# Proj\n\nA changed paragraph.\n');
    const m3 = model();
    await prepareAttachments([folderChip('proj')], deps(root, m3));
    let readme = entryOf(root, 'proj', 'proj/README.md');
    assert.equal(readme.description, 'My own words about the README');
    assert.equal(readme.source, 'edited, the file changed since');
    assert.equal(m3.describe, 0);
    write(root, 'proj/README.md', '# Proj\n\nChanged a second time.\n');
    await prepareAttachments([folderChip('proj')], deps(root, m3));
    readme = entryOf(root, 'proj', 'proj/README.md');
    assert.equal(readme.description, 'My own words about the README', 'kept again at the next change');
    assert.equal(readme.source, 'edited, the file changed since');
  }

  // ---- Failure: the model fails: outline, the send still goes, the next send asks again.
  {
    const root = repo(); proj(root);
    const m = model(); m.fail = true;
    const result = await prepareAttachments([folderChip('proj')], deps(root, m));
    assert.equal(entryOf(root, 'proj', 'proj/b.ts').source, 'outline');
    assert.match(result.text, /proj\/b\.ts/);
    const callsBefore = m.prompts.length;
    m.fail = false;
    await prepareAttachments([folderChip('proj')], deps(root, m));
    assert.equal(m.describe, 1, 'asked again at the next send');
    assert.equal(entryOf(root, 'proj', 'proj/b.ts').source, 'by the model');
    assert.ok(m.prompts.length > callsBefore);
    // Stop is not a failure: it stops the send.
    const root2 = repo(); proj(root2);
    const signal = { cancelled: false };
    const stopping = { complete: async () => { signal.cancelled = true; throw new Error('Cancelled'); } };
    await assert.rejects(prepareAttachments([folderChip('proj')], deps(root2, stopping, { signal })), /Cancelled/);
  }

  // ---- Failure: a map open with unsaved changes is not written, and the chat says so.
  {
    const root = repo(); proj(root);
    const m = model();
    const result = await prepareAttachments([folderChip('proj')], deps(root, m, { isDirty: absolute => absolute.endsWith('proj.md') }));
    assert.ok(!fs.existsSync(path.join(root, mapPathOf('proj'))), 'not written while dirty');
    assert.ok(result.notes.some(note => /unsaved changes/.test(note)));
    assert.equal(result.items[0].mapNotSaved, true);
    assert.match(result.text, /proj\/b\.ts: Described proj\/b\.ts/, 'the send uses the updated entries');
  }

  // ---- Outside Git the walk skips .git and node_modules; past 500 files the index says how many more.
  {
    const root = repo(false);
    write(root, 'f/keep.md', '# Keep\n\nKept.\n');
    write(root, 'f/node_modules/dep/index.js', '// dep\n');
    write(root, 'f/.git/config', 'x\n');
    write(root, 'f/sub/inner.md', '# Inner\n\nInner.\n');
    await prepareAttachments([folderChip('f')], deps(root, undefined));
    assert.deepEqual(parseMap(mapText(root, 'f')).map(entry => entry.path), ['f/keep.md', 'f/sub/inner.md']);
    const big = repo(false);
    for (let i = 0; i < 520; i++) { write(big, `many/f${String(i).padStart(3, '0')}.ts`, `// File ${i}\n`); }
    const result = await prepareAttachments([folderChip('many')], deps(big, undefined));
    assert.match(result.text, /^… and 20 more$/m);
    assert.equal((result.text.match(/^- many\//gm) || []).length, 500);
  }

  // ---- Summaries: one call, stored in the map, reused; again when the file changes.
  {
    const root = repo(); proj(root);
    const long = '// Requirements.\n' + 'REQ-1 the system shall do the thing. '.repeat(2500); // about 92,000 characters, under 200 KB
    write(root, 'proj/long.ts', long);
    const m = model();
    let result = await prepareAttachments([folderChip('proj')], deps(root, m));
    assert.equal(m.summary, 1, 'summarized once');
    assert.equal(entryOf(root, 'proj', 'proj/long.ts').summary, 'SUMMARY: keeps REQ-1 and REQ-2.');
    assert.match(entryOf(root, 'proj', 'proj/long.ts').summarySource, /^by the model, 2026-11-20$/);
    assert.match(result.text, /^=== proj\/long\.ts \(summary\) ===$/m);
    assert.deepEqual([result.items[0].sent.summary, result.items[0].sent.outline], [1, 0]);
    await prepareAttachments([folderChip('proj')], deps(root, m));
    assert.equal(m.summary, 1, 'reused at the next send with no call');
    write(root, 'proj/long.ts', long + '\n// changed\n');
    await prepareAttachments([folderChip('proj')], deps(root, m));
    assert.equal(m.summary, 2, 'summarized again when it changes');
  }
  {
    // Five files wait: three are summarized, two go as outlines, and those two are summarized at the next send.
    const root = repo();
    for (let i = 0; i < 5; i++) { write(root, `big/f${i}.ts`, `// File ${i}.\n` + `export const x${i} = 1; `.repeat(3500)); }
    const m = model();
    let result = await prepareAttachments([folderChip('big')], deps(root, m));
    assert.equal(m.summary, 3);
    assert.deepEqual([result.items[0].sent.summary, result.items[0].sent.outline], [3, 2]);
    result = await prepareAttachments([folderChip('big')], deps(root, m));
    assert.equal(m.summary, 5);
    assert.deepEqual([result.items[0].sent.summary, result.items[0].sent.outline], [5, 0]);
  }
  {
    // A Git-ignored file chip is summarized in memory: no map entry, and a warning flag.
    const root = repo(); proj(root);
    write(root, 'proj/.env', 'KEY=1 '.repeat(15000));
    const m = model();
    const result = await prepareAttachments([fileChip('proj/.env')], deps(root, m));
    assert.equal(m.summary, 1);
    assert.equal(result.items[0].ignored, true);
    assert.match(result.text, /\(summary\)/);
    assert.ok(!fs.existsSync(path.join(root, mapPathOf('proj'))), 'no map entry, ever, for a Git-ignored file');
    // A tracked file chip that needs a summary gets its entry in the map of its parent folder.
    write(root, 'proj/doc.md', '# Doc\n\n' + 'Text REQ-9. '.repeat(8000));
    const second = await prepareAttachments([fileChip('proj/doc.md')], deps(root, model()));
    assert.match(second.text, /\(summary\)/);
    assert.equal(entryOf(root, 'proj', 'proj/doc.md').summary, 'SUMMARY: keeps REQ-1 and REQ-2.');
    assert.deepEqual(parseMap(mapText(root, 'proj')).map(entry => entry.path), ['proj/doc.md']);
  }

  // ---- Outline.
  {
    const md = outline('docs/r.md', '# Requirements\n\nThe intro paragraph.\n\n## REQ-12 Login\n\ntext\n\n```\n# not a heading\n```\n## 2. Other\n');
    assert.match(md, /The intro paragraph\./);
    assert.match(md, /^## REQ-12 Login$/m);
    assert.doesNotMatch(md, /not a heading/);
    const ts = outline('a.ts', '/**\n * Does the thing.\n */\nimport x from "y";\nexport function run() {}\nclass Foo {}\ninterface Bar {}\nconst skip = 1;\n');
    assert.match(ts, /Does the thing\./);
    assert.match(ts, /export function run/);
    assert.match(ts, /class Foo/);
    assert.doesNotMatch(ts, /const skip/);
    const py = outline('a.py', '"""Module doc."""\nimport os\ndef run():\n    pass\nclass K:\n    pass\n');
    assert.match(py, /Module doc\./);
    assert.match(py, /def run/);
    assert.match(py, /class K/);
    assert.match(outline('a.json', '{"name":"x","scripts":{},"version":"1"}'), /Top-level keys: name, scripts, version/);
    assert.match(outline('a.yaml', 'name: x\nsteps:\n  - a\nversion: 1\n'), /Top-level keys: name, steps, version/);
    assert.equal(outline('a.txt', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')).split('\n').length, 20);
    assert.ok(outline('big.md', '# T\n\n' + Array.from({ length: 2000 }, (_, i) => `## Heading ${i}`).join('\n')).length <= 3000);
    assert.equal(describeFromFile('a.json', '{"description":"The thing"}'), 'The thing');
    assert.equal(describeFromFile('a.yml', 'description: "Yaml thing"\n'), 'Yaml thing');
    assert.equal(describeFromFile('a.py', '#!/usr/bin/env python\n"""Does py."""\n'), 'Does py.');
  }
  console.log('Studio folder map smoke test passed');
}

main().then(() => fs.rmSync(base, { recursive: true, force: true }), error => { console.error(error); process.exit(1); });
