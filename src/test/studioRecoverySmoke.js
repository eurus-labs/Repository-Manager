// Issue #140: a code step's writes are journaled before they reach the disk, so a window closed while
// the step ran is undone on the next start. Real files and a real RunStore; the "crash" is the step
// stopping without its normal end (no result saved, no journal cleared) at each point it can.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WriteJournal, recoverJournal } = require('../../out/agent/writeJournal.js');
const { StepWorkspace } = require('../../out/agent/agentTools.js');
const { RunStore, recoverInterruptedSteps, journalFile } = require('../../out/studio/engine.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-recovery-'));
const root = fs.realpathSync(fs.mkdirSync(path.join(base, 'repo'), { recursive: true }) || path.join(base, 'repo'));
const file = name => path.join(root, name);
const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : null;
const write = (name, text) => { fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), text); };
const host = journal => ({ root, isDirty: () => false, allowedScripts: () => [], runScript: async () => ({}), journal });

async function main() {
  try {
    // The journal is written before the file: a journal that cannot be written stops the write.
    write('src/a.txt', 'one\n');
    const refusing = { record() { throw new Error('disk full'); } };
    const blocked = await new StepWorkspace(host(refusing), { tools: ['edit_file'], paths: ['src/'] })
      .invoke('edit_file', { path: 'src/a.txt', oldText: 'one', newText: 'two' });
    assert.equal(blocked.ok, false);
    assert.equal(read('src/a.txt'), 'one\n', 'the file changed before its journal entry was written');

    // Crash after the writes: an edited file, a file edited twice, a new file. All go back.
    write('src/b.txt', 'b0\n');
    const journalPath = path.join(base, 'runs', 'r1', 'fix.writes.jsonl');
    let workspace = new StepWorkspace(host(new WriteJournal(journalPath, root)), { tools: ['edit_file', 'create_file'], paths: ['src/'] });
    for (const [tool, input] of [
      ['edit_file', { path: 'src/a.txt', oldText: 'one', newText: 'two' }],
      ['edit_file', { path: 'src/b.txt', oldText: 'b0', newText: 'b1' }],
      ['edit_file', { path: 'src/b.txt', oldText: 'b1', newText: 'b2' }],
      ['create_file', { path: 'src/new/c.txt', content: 'new\n' }]
    ]) { assert.equal((await workspace.invoke(tool, input)).ok, true); }
    assert.deepEqual([read('src/a.txt'), read('src/b.txt'), read('src/new/c.txt')], ['two\n', 'b2\n', 'new\n']);
    let recovery = recoverJournal(journalPath);
    assert.deepEqual(recovery, { restored: ['src/a.txt', 'src/b.txt', 'src/new/c.txt'], kept: [] });
    assert.deepEqual([read('src/a.txt'), read('src/b.txt'), read('src/new/c.txt')], ['one\n', 'b0\n', null]);
    assert.equal(fs.existsSync(journalPath), false);
    // Again: nothing more happens.
    assert.deepEqual(recoverJournal(journalPath), { restored: [], kept: [] });

    // Crash between the journal entry and the write: the second edit never reached the disk
    // (b holds b1, the first edit's result) and a torn last line was being written.
    const journal = new WriteJournal(journalPath, root);
    journal.record({ path: 'src/b.txt', before: 'b0\n', after: 'b1\n' });
    write('src/b.txt', 'b1\n');
    journal.record({ path: 'src/b.txt', before: 'b1\n', after: 'b2\n' });
    fs.appendFileSync(journalPath, '{"root":"' + root + '","path":"src/a.txt","bef');
    recovery = recoverJournal(journalPath);
    assert.deepEqual(recovery, { restored: ['src/b.txt'], kept: [] });
    assert.equal(read('src/b.txt'), 'b0\n');
    assert.equal(read('src/a.txt'), 'one\n', 'the torn entry was acted on');

    // Crash before any write: the file is as before, nothing to do.
    journal.record({ path: 'src/a.txt', before: 'one\n', after: 'three\n' });
    assert.deepEqual(recoverJournal(journalPath), { restored: [], kept: [] });

    // Changed by the person after the crash, or unsaved in an editor: left alone and named.
    journal.record({ path: 'src/a.txt', before: 'one\n', after: 'four\n' });
    write('src/a.txt', 'mine\n');
    journal.record({ path: 'src/b.txt', before: 'b0\n', after: 'b5\n' });
    write('src/b.txt', 'b5\n');
    recovery = recoverJournal(journalPath, absolute => absolute === file('src/b.txt'));
    assert.deepEqual(recovery, { restored: [], kept: ['src/a.txt', 'src/b.txt'] });
    assert.deepEqual([read('src/a.txt'), read('src/b.txt')], ['mine\n', 'b5\n']);
    // A journal entry pointing outside its root is never followed.
    write('src/a.txt', 'one\n');
    const outside = path.join(base, 'outside.txt');
    fs.writeFileSync(outside, 'keep\n');
    journal.record({ path: '../outside.txt', before: 'gone\n', after: 'keep\n' });
    assert.deepEqual(recoverJournal(journalPath), { restored: [], kept: [] });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep\n');

    // On the next start, per run: a running run with a journal is undone and marked; a run waiting
    // for the review of that node keeps its changes (its result was saved); a running run without a
    // journal is marked as cut short; a finished run is not touched.
    const store = new RunStore(path.join(base, 'store'));
    const state = (id, status, extra = {}) => ({ id, workflow: { id: 'w', version: '1', title: `Run ${id}`, hash: 'h' }, startedAt: `2026-11-15T0${id.length}:00:00Z`,
      updatedAt: '', status, inputs: {}, nodes: { fix: { status: 'pending' } }, approvals: {}, ...extra });
    await store.save(state('cut', 'running'));
    await store.save(state('review', 'waiting', { waiting: { node: 'fix', kind: 'review', title: 'Review', effect: 'write', preview: '' } }));
    await store.save(state('idle', 'running'));
    await store.save(state('done', 'done', { nodes: { fix: { status: 'done' } } }));
    write('src/a.txt', 'cut\n');
    new WriteJournal(journalFile(store, 'cut', 'fix'), root).record({ path: 'src/a.txt', before: 'one\n', after: 'cut\n' });
    write('src/b.txt', 'reviewed\n');
    new WriteJournal(journalFile(store, 'review', 'fix'), root).record({ path: 'src/b.txt', before: 'b0\n', after: 'reviewed\n' });
    const found = await recoverInterruptedSteps(store);
    assert.deepEqual(found.map(item => [item.runId, item.restored]), [['cut', ['src/a.txt']], ['idle', []]]);
    assert.equal(read('src/a.txt'), 'one\n');
    assert.equal(read('src/b.txt'), 'reviewed\n', 'changes waiting for review were undone');
    const cut = await store.load('cut');
    assert.equal(cut.status, 'failed');
    assert.deepEqual([cut.interrupted.node, cut.interrupted.restored], ['fix', ['src/a.txt']]);
    assert.match(cut.error, /^fix: VS Code closed while this step ran; its changes were undone \(src\/a\.txt\)\.$/);
    assert.deepEqual((await store.readLog('cut')).map(entry => entry.type), ['recovered']);
    assert.equal((await store.load('review')).status, 'waiting');
    assert.equal(fs.existsSync(journalFile(store, 'review', 'fix')), false);
    assert.equal((await store.load('idle')).status, 'failed');
    assert.equal((await store.load('idle')).interrupted.node, 'fix');
    assert.equal((await store.load('done')).status, 'done');
    // A second start finds nothing.
    assert.deepEqual(await recoverInterruptedSteps(store), []);
    console.log('Studio recovery smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
