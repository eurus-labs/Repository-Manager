const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The clarification parser, save rules, requirement catalog, image rules and Git source of the
// Requirement editor. Ported from the Python dou-editor's tests (test_editor, test_v2, test_v3),
// plus what only the TypeScript port can get wrong: UTF-16 offsets and Python's line rules.
const { parse, prepareSave, timestamp, nowIso } = require('../../out/requirements/douDocument.js');
const { requirementCatalog, requirementsIn, visualAid, checkSource, webBase, RequirementSource } = require('../../out/requirements/requirementCatalog.js');
const { DouService } = require('../../out/requirements/douService.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'requirements');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dou-'));
const replaceOnce = (text, from, to) => { assert.ok(text.includes(from), `fixture lacks ${JSON.stringify(from)}`); return text.replace(from, () => to); };
const spansMatch = text => { for (const f of parse(text).fields) { assert.equal(text.slice(f.start, f.end).trim(), f.value); } };

async function schemaV1() {
  const text = read('CLR-001.md');
  spansMatch(text);
  assert.throws(() => parse(text.replace('proposed', 'agreed')));
  assert.throws(() => parse(text + text.slice(text.indexOf('### CLR-001-Q01'))));
  // v1 items are kept too: removing one is refused, as in v2 and v3.
  assert.equal(parse(text.slice(0, text.indexOf('### CLR-001-Q01'))).items.length, 0);
  assert.throws(() => prepareSave(text, text.slice(0, text.indexOf('### CLR-001-Q01'))), /traceability/);
  // Reserved labels inside a fence are text, not structure.
  assert.ok(parse(replaceOnce(text, 'Pending', 'Pending\n\n```md\n**Question**\n### CLR-001-Q99\n```')));
}

async function schemaV2() {
  const text = read('CLR-002.md');
  const data = parse(text);
  assert.equal(data.version, 2);
  assert.equal(data.items.length, 2);
  spansMatch(text);
  assert.throws(() => parse(text.replace('"follows_up"', '"invalid"')));
  assert.throws(() => parse(text.replace('"item_id":"CLR-002-Q01"', '"item_id":"CLR-002-Q99"')));

  // Updated at is stamped on the changed item only; history, Created at and items are kept.
  const changed = replaceOnce(text, 'Pending\n\n**Next action**', 'Investigate API\n\n**Next action**');
  const saved = parse(prepareSave(text, changed));
  assert.notEqual(saved.items[0].values['Updated at'], '2026-10-27T09:00:00+07:00');
  assert.equal(saved.items[1].values['Updated at'], '2026-10-27T09:00:00+07:00');
  assert.throws(() => prepareSave(text, text.replace('Example PO', 'Someone else')), /append-only/);
  assert.throws(() => prepareSave(text, replaceOnce(text, '**Created at**\n\n2026-10-27', '**Created at**\n\n2026-10-26')), /immutable/);
  assert.throws(() => prepareSave(text, text.slice(0, text.indexOf('### CLR-002-Q02'))), /traceability/);

  // Resolving needs a conclusion event and a current conclusion.
  assert.throws(() => parse(text.replace('investigating', 'resolved')));
  const field = data.fields.find(f => f.inquiry === 'CLR-002-Q01' && f.label === 'History');
  const history = JSON.parse(field.value.replace(/^```json/, '').replace(/```$/, ''));
  history.push({ id: 'EV-002', at: '2026-10-28T09:00:00+07:00', author: 'Reviewer', role: 'Reviewer', type: 'conclusion', content: 'Use idempotency key.' });
  let resolved = text.slice(0, field.start) + '\n```json\n' + JSON.stringify(history) + '\n```\n\n' + text.slice(field.end);
  resolved = replaceOnce(resolved.replace('investigating', 'resolved'), '**Current conclusion**\n\nPending', '**Current conclusion**\n\nUse idempotency key.');
  assert.equal(parse(prepareSave(text, resolved)).items[0].values.Status, 'resolved');

  // Browsers emit "Z" and milliseconds.
  const event = ',{"id":"EV-002","at":"2026-10-28T02:00:00.123Z","author":"Dev","role":"Dev","type":"question","content":"Ask"}]';
  assert.ok(parse(replaceOnce(text, 'illustrative response."}]', 'illustrative response."}' + event)));
  // A new item keeps its Created at; Updated at never precedes it, even within the same second.
  const block = text.slice(text.indexOf('### CLR-002-Q02')).replaceAll('Q02', 'Q03');
  for (const created of ['2020-01-01T08:00:00.123Z', new Date().toISOString()]) {
    const added = text + '\n' + block.replace('2026-10-27T09:00:00+07:00', created).replace('2026-10-27T09:00:00+07:00', created);
    const values = parse(prepareSave(text, added)).items[2].values;
    assert.equal(values['Created at'], created);
    const [a, b] = [timestamp(values['Updated at']), timestamp(created)];
    assert.ok(a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]), `${values['Updated at']} precedes ${created}`);
  }
  const future = text + '\n' + block.replace('2026-10-27T09:00:00+07:00', '2999-01-01T00:00:00Z').replace('2026-10-27T09:00:00+07:00', '2999-01-01T00:00:00Z');
  assert.throws(() => prepareSave(text, future), /CLR-002-Q03: Created at cannot be in the future/);

  // Malformed JSON says which item and field.
  for (const [from, to] of [['[]\n```\n\n**History**', '["CLR-002-Q02"]\n```\n\n**History**'], ['"author":"Example PO",', '"author":7,'],
    ['"type":"response",', ''], ['[{"item_id"', '{"item_id"']]) {
    assert.throws(() => parse(replaceOnce(text, from, to)), /CLR-002-Q0\d (References|History)/);
  }
  assert.throws(() => parse(replaceOnce(text, '"relation":"follows_up"', '"relation":"follows_up",')), /CLR-002-Q02 References: invalid JSON \(.*line 1\)/);
  assert.throws(() => parse(text.replace('2026-10-27T09:00:00+07:00', '2026-10-27T09:00:00')), /must include a timezone/);
  assert.throws(() => parse(text.replace('2026-10-27T09:00:00+07:00', '2026-02-30T09:00:00+07:00')), /invalid ISO 8601/);
  assert.match(nowIso(new Date(2026, 9, 27, 14, 5, 9, 1)), /^2026-10-27T14:05:10[+-]\d\d:\d\d$/);
}

async function schemaV3() {
  const text = read('CLR-003.md');
  const data = parse(text);
  assert.equal(data.version, 3);
  assert.ok(!data.fields.some(f => !f.inquiry && f.label === 'Context'));
  assert.ok(data.items[0].values.Scope.startsWith('Context:'));
  spansMatch(text);
  assert.throws(() => parse(text.replace('## Discussions', '## Context\n\nShared.\n\n## Discussions')), /Schema v3 requires/);
  assert.throws(() => parse(text.replace('**Scope**', '**Scope note**')), /CLR-003-Q01: require fields/);
  const v2 = read('CLR-002.md');
  assert.throws(() => parse(v2.replace('**Related requirements**', '**Scope**\n\nX\n\n**Related requirements**')));

  const values = data.items[0].values;
  assert.deepEqual(Object.keys(values), ['Created at', 'Updated at', 'Status', 'Scope', 'Desired outcome', 'Requirement', 'Questions', 'Approach',
    'Proposed acceptance criteria', 'Visual aids', 'References', 'History', 'Next action']);
  for (const removed of ['**Current understanding**\n\nX\n\n', '**Open points**\n\n- X\n\n']) {
    assert.throws(() => parse(text.replace('**Questions**', removed + '**Questions**')));
  }
  for (const value of ['REQ_012', 'R_F4722', 'Pending']) { assert.ok(parse(replaceOnce(text, '**Requirement**\n\nREQ-012', '**Requirement**\n\n' + value))); }
  for (const value of ['REQ-012, REQ-013', 'see REQ-012']) {
    assert.throws(() => parse(replaceOnce(text, '**Requirement**\n\nREQ-012', '**Requirement**\n\n' + value)), /Requirement must be one ID/);
  }
  const resolved = text.replace('investigating', 'resolved');
  assert.throws(() => parse(resolved), /CLR-003-Q01: resolved requires every question ticked .*2 still open/);
  assert.ok(parse(replaceOnce(replaceOnce(resolved, '- [ ] Should retry', '- [x] Should retry'), '- [ ] Does the API', '- [X] Does the API')));

  const scoped = parse(prepareSave(text, replaceOnce(text, 'In scope: timeouts and retry after a timeout.', 'In scope: timeouts only.'))).items;
  assert.notEqual(scoped[0].values['Updated at'], '2026-10-27T09:00:00+07:00');
  assert.equal(scoped[1].values['Updated at'], '2026-10-27T09:00:00+07:00');
  assert.throws(() => prepareSave(text, v2.replaceAll('CLR-002', 'CLR-003')), /schema version must remain unchanged/);

  for (const missing of ['**Desired outcome**', '**Proposed acceptance criteria**', '**Visual aids**']) {
    assert.throws(() => parse(text.replace(missing, '**Other**')), /CLR-003-Q01: require fields/);
  }
  const anchor = 'illustrative response."}';
  const response = extra => replaceOnce(text, anchor, anchor + `,{"id":"EV-9","at":"2026-10-29T10:00:00+07:00","author":"PO","role":"PO","content":"Demo looked right"${extra}}`);
  assert.ok(parse(response(',"source":"Sprint 12 review"')));
  assert.throws(() => parse(response(',"source":12')), /History\[1\]\.source: must be text/);
  assert.throws(() => parse(response(',"type":"conclusion"')), /History\[1\]: v3 responses have no type/);

  assert.throws(() => parse(text.replace('- AC2: Given', '- AC1: Given')), /CLR-003-Q01: duplicate acceptance criterion AC1/);
  const decision = (role = 'PO', criteria = '[{"id":"AC1","decision":"accepted","text":"x"}]') =>
    replaceOnce(text, anchor, anchor + `,{"id":"EV-7","at":"2026-10-29T10:00:00+07:00","author":"Lan","role":"${role}","content":"AC1 accepted","criteria":${criteria}}`);
  assert.ok(parse(decision()));
  for (const [role, criteria, error] of [['Dev', undefined, /recorded by role PO/], ['PO', '[]', /list at least one criterion/],
    ['PO', '[{"id":"X1","decision":"accepted","text":"x"}]', /needs an id such as AC1/], ['PO', '[{"id":"AC1","decision":"maybe","text":"x"}]', /accepted or rejected/],
    ['PO', '[{"id":"AC1","decision":"accepted"}]', /criteria\[0\]\.text/], ['PO', '[{"id":"AC1","decision":"accepted","text":"x","aids":3}]', /criteria\[0\]\.aids/]]) {
    assert.throws(() => parse(decision(role, criteria)), error);
  }
  const decided = decision();
  assert.throws(() => prepareSave(decided, decided.replace('"decision":"accepted"', '"decision":"rejected"')), /append-only/);
}

// What the port must keep from Python: code-point fields become UTF-16 offsets that the webview
// can splice, and only "\n" starts a line (JavaScript's `m` flag also breaks at "\r" and U+2028).
async function portParity() {
  const text = read('CLR-003.md');
  const emoji = replaceOnce(text, 'In scope: timeouts and retry after a timeout.', 'In scope: 😀 timeouts 👍🏽 and retry after a timeout.');
  spansMatch(emoji);
  const scope = parse(emoji).fields.find(f => f.label === 'Scope');
  const edited = emoji.slice(0, scope.start) + '\nX 😀\n\n' + emoji.slice(scope.end);
  assert.equal(parse(edited).items[0].values.Scope, 'X 😀');
  // A U+2028 before a reserved label inside a field is text, as in Python.
  const separator = replaceOnce(text, 'retry after a timeout.', 'retry after a timeout.\u2028### CLR-003-Q09\u2028**Status**');
  assert.equal(parse(separator).items.length, 2);
  // CRLF files keep working.
  const crlf = text.replace(/\n/g, '\r\n');
  spansMatch(crlf);
  assert.equal(parse(crlf).items.length, 2);
  assert.equal(parse(prepareSave(crlf, replaceOnce(crlf, 'retry after a timeout.', 'x'))).items.length, 2);
  // A BOM is kept, so the front matter is not found (Python reads it the same way).
  assert.throws(() => parse('\ufeff' + text), /Missing YAML front matter/);
}

async function requirements() {
  const markdown = '# Messaging\n\n## REQ-012: Send messages\n\nBody one.\n\n### Notes\n\nNested note.\n\n'
    + '## REQ-013 — Retry ##\n\nBody two.\n\n```md\n## REQ-099: inside a fence\n```\n\n## CLR-001-Q01 is not a requirement\n\n## FR-7\n';
  const found = Object.fromEntries(requirementsIn(markdown).map(([id, ...rest]) => [id, rest]));
  assert.deepEqual(Object.keys(found).sort(), ['FR-7', 'REQ-012', 'REQ-013']);
  assert.deepEqual(found['REQ-012'].slice(0, 2), ['Send messages', 3]);
  assert.ok(found['REQ-012'][2].includes('Nested note.'));
  assert.ok(!found['REQ-012'][2].includes('Body two'));
  assert.equal(found['REQ-013'][0], 'Retry');
  assert.deepEqual(requirementsIn('---\nid: "REQ-AUTH-3"\ntitle: Login\n---\n\nUsers log in.\n'), [['REQ-AUTH-3', 'Login', 1, 'Users log in.']]);

  const rst = 'Title\n=====\n\nREQ-012: Send messages\n----------------------\n\nBody one.\n\nNotes\n~~~~~\n\nNested.\n\n'
    + 'REQ_013 Retry\n-------------\n\nBody two.\n\n.. req:: Read receipts\n   :id: R_F4722\n   :status: open\n\n'
    + '   Users see when a message was read.\n\nAfter.\n\nNot a section\n---\n';
  const rstFound = Object.fromEntries(requirementsIn(rst, '.rst').map(([id, ...rest]) => [id, rest]));
  assert.deepEqual(Object.keys(rstFound).sort(), ['REQ-012', 'REQ_013', 'R_F4722']);
  assert.deepEqual(rstFound['REQ-012'].slice(0, 2), ['Send messages', 4]);
  assert.ok(rstFound['REQ-012'][2].includes('Nested.'));
  assert.ok(!rstFound['REQ-012'][2].includes('Body two'));
  assert.deepEqual(rstFound.R_F4722, ['Read receipts', 19, 'Users see when a message was read.']);
  assert.deepEqual(requirementsIn('REQ-013: Manual retry (updated)\n---------------------\n\nBody.\n\nNot a title\n---\n', '.rst'),
    [['REQ-013', 'Manual retry (updated)', 1, 'Body.\n\nNot a title\n---']]);
  assert.deepEqual(requirementsIn('Messaging\n=========\n\n.. _REQ-030:\n\nTyping indicator\n----------------\n\nShows when the other person types.\n\n'
    + '.. _intro:\n\nIntroduction\n------------\n\nNo ID here.\n', '.rst'), [['REQ-030', 'Typing indicator', 6, 'Shows when the other person types.']]);

  const catalog = await requirementCatalog(path.join(FIXTURES, 'requirements'));
  assert.deepEqual(catalog.requirements.map(r => [r.id, r.file]),
    [['REQ-012', 'requirements/messaging.rst'], ['REQ-013', 'requirements/messaging.rst'], ['REQ_020', 'requirements/messaging.rst']]);

  // Scan rules: no hidden folders, other extensions, invalid UTF-8, clarification files or links.
  const directory = temp();
  const root = path.join(directory, 'requirements');
  fs.mkdirSync(path.join(root, 'api'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'api', 'send.md'), '## REQ-012: Send\n');
  fs.writeFileSync(path.join(root, '.hidden', 'x.md'), '## REQ-500: Hidden\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), '## REQ-600: Not markdown\n');
  fs.writeFileSync(path.join(root, 'bad.md'), Buffer.from('## REQ-700 \xff\n', 'latin1'));
  fs.copyFileSync(path.join(FIXTURES, 'CLR-001.md'), path.join(root, 'CLR-001.md'));
  fs.writeFileSync(path.join(directory, 'outside.md'), '## REQ-800: Outside\n');
  try { fs.symlinkSync(path.join(directory, 'outside.md'), path.join(root, 'link.md')); } catch { /* no symlinks here */ }
  const scanned = await requirementCatalog(root);
  assert.deepEqual(scanned.requirements.map(r => [r.id, r.file, r.line]), [['REQ-012', 'requirements/api/send.md', 1]]);
  assert.ok(scanned.skipped.includes('requirements/bad.md'));
  assert.equal((await requirementCatalog(path.join(root, 'api', 'send.md'))).requirements[0].file, 'send.md');
}

async function visualAids() {
  const directory = temp();
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', 'wireframes'), { recursive: true });
  const document = path.join(repo, 'docs', 'CLR-003.md');
  fs.writeFileSync(document, 'x');
  const png = fs.readFileSync(path.join(FIXTURES, 'wireframes', 'retry-failed-message.png'));
  fs.writeFileSync(path.join(repo, 'docs', 'wireframes', 'a.png'), png);
  fs.writeFileSync(path.join(repo, 'assets.png'), png);
  fs.writeFileSync(path.join(repo, 'docs', 'evil.svg'), '<svg/>');
  fs.writeFileSync(path.join(directory, 'outside.png'), png);
  const image = await visualAid(document, 'wireframes/a.png');
  assert.equal(image.kind, 'image/png');
  assert.ok(image.data.equals(png));
  assert.equal((await visualAid(document, '../assets.png')).kind, 'image/png'); // elsewhere in the repository
  for (const [bad, status] of [['../../outside.png', 403], [path.join(directory, 'outside.png'), 403], ['evil.svg', 403], ['', 403], ['missing.png', 404]]) {
    await assert.rejects(visualAid(document, bad), error => error.status === status, bad);
  }
  try { fs.symlinkSync(path.join(directory, 'outside.png'), path.join(repo, 'docs', 'link.png')); } catch { return; }
  await assert.rejects(visualAid(document, 'link.png'), error => error.status === 403);
}

async function sources() {
  assert.deepEqual(checkSource({ kind: 'git', repo: 'git@github.com:org/req.git', ref: 'main', path: 'docs/source/' }),
    { kind: 'git', repo: 'git@github.com:org/req.git', ref: 'main', path: 'docs/source' });
  for (const bad of [{ kind: 'git', repo: 'https://me:token@github.com/o/r.git' }, { kind: 'git', repo: 'https://:token@github.com/o/r.git' },
    { kind: 'git', repo: '--upload-pack=x' }, { kind: 'git', repo: 'https://github.com/o/r', ref: '-c' }, { kind: 'git', repo: 'https://github.com/o/r', path: '../up' },
    { kind: 'folder', folder: '' }, { kind: 'web' }, null, []]) {
    assert.throws(() => checkSource(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(webBase('git@github.com:org/req.git', 'abc'), 'https://github.com/org/req/blob/abc/');
  assert.equal(webBase('https://ghe.example/org/req.git', 'abc'), 'https://ghe.example/org/req/blob/abc/');
  assert.equal(webBase('file:///tmp/req.git', 'abc'), null);

  // A Git source keeps a shallow, sparse copy, follows new commits, and keeps the last good copy.
  const folder = temp();
  const work = path.join(folder, 'work'), bare = path.join(folder, 'req.git');
  fs.mkdirSync(path.join(work, 'docs', 'source'), { recursive: true });
  fs.mkdirSync(path.join(work, 'other'));
  fs.copyFileSync(path.join(FIXTURES, 'requirements', 'messaging.rst'), path.join(work, 'docs', 'source', 'messaging.rst'));
  fs.writeFileSync(path.join(work, 'other', 'big.txt'), 'not needed');
  const run = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' });
  run(work, 'init', '-q'); run(work, 'checkout', '-q', '-B', 'main'); run(work, 'add', '-A'); run(work, 'commit', '-qm', 'first');
  run(folder, 'clone', '-q', '--bare', work, bare);
  const config = path.join(folder, '.dou-editor.json');
  fs.writeFileSync(config, JSON.stringify({ other: 'kept' }));
  const source = new RequirementSource(config, path.join(folder, 'cache'));
  assert.equal((await source.describe()).configured, false);
  const url = pathToFileURL(bare).href;
  await source.save({ kind: 'git', repo: url, ref: 'main', path: 'docs/source' });
  await source.sync();
  let data = await source.describe();
  assert.equal(data.sync.state, 'ok', JSON.stringify(data.sync));
  assert.equal(data.sync.subject, 'first');
  assert.deepEqual(data.requirements.map(r => r.file), Array(3).fill('docs/source/messaging.rst'));
  assert.ok(!fs.existsSync(path.join(source.cacheFolder({ repo: url, ref: 'main', path: 'docs/source' }), 'other')), 'the copy is not sparse');
  // Another repository reading the same URL at another folder keeps its own copy: syncing it
  // leaves this source's files alone.
  const otherConfig = path.join(folder, 'other.json');
  const other = new RequirementSource(otherConfig, path.join(folder, 'cache'));
  await other.save({ kind: 'git', repo: url, ref: 'main', path: 'other' });
  await other.sync();
  assert.equal((await other.describe()).sync.state, 'ok');
  assert.notEqual(other.cacheFolder({ repo: url, ref: 'main', path: 'other' }), source.cacheFolder({ repo: url, ref: 'main', path: 'docs/source' }));
  assert.equal((await source.describe()).requirements.length, 3, 'syncing another source replaced this one\'s files');
  const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(saved.requirements.path, 'docs/source');
  assert.equal(saved.other, 'kept');
  const rst = path.join(work, 'docs', 'source', 'messaging.rst');
  fs.writeFileSync(rst, replaceOnce(fs.readFileSync(rst, 'utf8'), 'Manual retry', 'Manual retry v2'));
  run(work, 'commit', '-qam', 'second'); run(work, 'push', '-q', bare, 'main');
  await source.sync();
  data = await source.describe();
  assert.deepEqual([data.sync.subject, data.requirements[1].title], ['second', 'Manual retry v2']);
  // A failing sync (the repository is unreachable) keeps the earlier copy and says why.
  fs.renameSync(bare, bare + '.away');
  await source.sync();
  data = await source.describe();
  assert.equal(data.sync.state, 'error');
  assert.deepEqual([data.sync.subject, data.requirements.length], ['second', 3]);
  fs.renameSync(bare + '.away', bare);
  // A branch that does not exist is a new copy that cannot be made: nothing to show, and why.
  await source.save({ kind: 'git', repo: url, ref: 'missing', path: 'docs/source' });
  await source.sync();
  data = await source.describe();
  assert.equal(data.sync.state, 'error');
  assert.match(data.sync.error, /missing/);
  assert.equal(data.configured, false);
  // A broken config file is reported, not thrown.
  fs.writeFileSync(config, '{"requirements": {"kind": "web"}}');
  assert.match((await new RequirementSource(config, path.join(folder, 'cache')).describe()).sync.error, /\.dou-editor\.json: Requirements source kind/);
}

// The service behind the editor: what the Python HTTP endpoints did, with the same refusals.
async function service() {
  const folder = temp();
  fs.mkdirSync(path.join(folder, '.git'));
  for (const name of ['CLR-001.md', 'CLR-003.md']) { fs.copyFileSync(path.join(FIXTURES, name), path.join(folder, name)); }
  fs.cpSync(path.join(FIXTURES, 'requirements'), path.join(folder, 'requirements'), { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'wireframes'), path.join(folder, 'wireframes'), { recursive: true });
  const file = path.join(folder, 'CLR-003.md');
  const sources = new Map();
  const dou = new DouService(file, await DouService.sourceFor(file, path.join(folder, 'cache'), sources));
  assert.equal(await DouService.sourceFor(path.join(folder, 'CLR-001.md'), 'x', sources), dou.source, 'files of one repository share a source');

  const doc = await dou.document();
  assert.equal(doc.filename, 'CLR-003.md');
  const content = replaceOnce(doc.content, 'retry after a timeout.', 'retry after a timeout 😀 ’.');
  assert.match((await dou.save(content, doc.hash)).hash, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(file, 'utf8'), prepareSave(doc.content, content, parse(fs.readFileSync(file, 'utf8')).items[0].values['Updated at']));
  await assert.rejects(dou.save(doc.content, doc.hash), error => error.status === 409, 'a stale save was written');
  const fresh = await dou.document();
  fs.writeFileSync(file, fresh.content + '\nExternal edit\n');
  await assert.rejects(dou.save(fresh.content, fresh.hash), error => error.status === 409);
  const now = await dou.document();
  await assert.rejects(dou.save(replaceOnce(now.content, 'investigating', 'invalid'), now.hash), error => error.status === 422);
  await assert.rejects(dou.save(42, now.hash), error => error.status === 422);
  assert.deepEqual(fs.readdirSync(folder).filter(name => name.endsWith('.tmp')), [], 'a temporary file was left behind');
  // Two saves at once: the second sees the first one's file and is refused.
  const results = await Promise.allSettled([dou.save(replaceOnce(now.content, 'timeouts', 'People'), now.hash), dou.save(replaceOnce(now.content, 'timeouts', 'Folks'), now.hash)]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);

  assert.equal(dou.parse(now.content).items.length, 2);
  assert.throws(() => dou.parse(now.content + '\n### CLR-003-Q03\n'), error => error.status === 422);
  fs.writeFileSync(file, replaceOnce(now.content, '[]\n```\n\n**History**', '["CLR-003-Q02"]\n```\n\n**History**'));
  await assert.rejects(dou.document(), error => error.status === 422 && /CLR-003-Q0\d References\[0\]/.test(error.message));

  assert.deepEqual([...new Set((await dou.index()).map(x => `${x.file} v${x.version}`))], ['CLR-001.md v1']);
  const asset = await dou.asset('wireframes/retry-failed-message.png');
  assert.equal(asset.kind, 'image/png');
  assert.equal(Buffer.from(asset.data, 'base64').subarray(1, 4).toString(), 'PNG');
  await assert.rejects(dou.asset('../../etc/passwd'), error => error.status === 403);
  await assert.rejects(dou.asset('CLR-003.md'), error => error.status === 403);

  assert.equal((await dou.requirements()).configured, false);
  const configured = await dou.setSource({ kind: 'folder', folder: 'requirements' });
  assert.deepEqual(configured.requirements.map(r => r.id), ['REQ-012', 'REQ-013', 'REQ_020']);
  assert.equal(configured.source.from, '.dou-editor.json');
  assert.equal(dou.source.locate('requirements/messaging.rst'), path.join(folder, 'requirements', 'messaging.rst'));
  assert.equal(dou.source.locate('../outside.rst'), undefined);
  await assert.rejects(dou.setSource({ kind: 'git', repo: 'https://me:t@x/y.git' }), error => error.status === 422);
}

(async () => {
  for (const test of [schemaV1, schemaV2, schemaV3, portParity, requirements, visualAids, sources, service]) {
    await test();
    console.log(`ok ${test.name}`);
  }
  console.log('Requirement parser smoke test passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
