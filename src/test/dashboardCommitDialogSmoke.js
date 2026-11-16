const assert = require('node:assert/strict');
const { createCommitDialogState, editRatio, fileShown } = require('../../resources/dashboardCommitDialog.js');
const usageLog = require('../../out/services/usageLog.js');

const A = '/repo/a';
const B = '/repo/b';
const file = (p, extra = {}) => ({ path: p, ...extra });
const paths = list => list.map(change => change.path);

// a) editRatio stays equal to the host's (src/services/usageLog.ts).
{
  const pairs = [
    ['', ''], ['', 'x'], ['x', ''], ['same text', 'same text'], ['feat: add login', 'feat: add logins'],
    ['a'.repeat(2500), 'a'.repeat(2400) + 'b'.repeat(300)], ['héllo wörld ✓', 'hello world'], ['👍🏽 ok 😀', '😀 ok 👍🏽'],
    ['fix(ui): align the buttons', 'refactor: something else entirely']
  ];
  for (const [before, after] of pairs) {
    assert.equal(editRatio(before, after), usageLog.editRatio(before, after), JSON.stringify([before.slice(0, 20), after.slice(0, 20)]));
  }
  assert.equal(editRatio('', ''), 0);
  assert.equal(editRatio('', 'x'), 1);
}

// b) open(): scope, the draft rule, preview request id, previous message.
{
  const state = createCommitDialogState({});
  assert.deepEqual(state.open(A, ['x', 'y'], 1000), { clearDraft: true }, 'no draft yet: the field is cleared');
  state.setChanges([file('x'), file('y'), file('z')]);
  assert.deepEqual(paths(state.changes()), ['x', 'y'], 'picked files are the scope');
  state.open(A, [], 2000);
  assert.deepEqual(state.setChanges([file('x'), file('z')]).scopeNote, { scoped: false, shown: 2, rest: 0 }, 'nothing picked: every file');
  state.open(A, undefined, 2500);
  assert.deepEqual(state.changes(), [], 'open() forgets the list');

  // The draft rule.
  state.messageWritten('feat: x', '');
  assert.deepEqual(state.open(A, [], 3000), { clearDraft: false }, 'same repository keeps the draft');
  assert.equal(state.metrics('feat: x', 3500).copilot, true, 'a kept draft stays Copilot\'s');
  assert.deepEqual(state.open(B, [], 4000), { clearDraft: true }, 'another repository clears it');
  assert.equal(state.metrics('feat: x', 4500).copilot, false, 'a cleared draft is no longer Copilot\'s');
  assert.deepEqual(state.open(B, [], 5000), { clearDraft: false });

  // Preview request id increases, and the previewed file is forgotten.
  state.open(A, [], 6000);
  state.setChanges([file('x', { unstaged: true })]);
  state.previewFile('x');
  const first = state.nextPreview('unstaged').requestId;
  state.open(A, [], 7000);
  assert.equal(state.previewedFile(), null);
  state.setChanges([file('x', { unstaged: true })]);
  state.previewFile('x');
  assert.ok(state.nextPreview('unstaged').requestId > first + 1, 'open() moved the id on');

  // The previous message is cleared by open().
  state.messageWritten('feat: y', 'my own draft');
  state.open(A, [], 8000);
  assert.equal(state.undoMessage(), null);
}

// c) setChanges with a scope.
{
  const state = createCommitDialogState();
  state.open(A, ['b', 'gone'], 1);
  const all = [file('a'), file('b'), file('c')];
  const result = state.setChanges(all);
  assert.deepEqual(paths(result.changes), ['b']);
  assert.deepEqual(result.scopeNote, { scoped: true, shown: 1, rest: 2 });
  assert.equal(result.changes, state.changes());
  state.showAll();
  assert.deepEqual(state.setChanges(all).scopeNote, { scoped: false, shown: 3, rest: 0 });
  state.open(A, ['gone'], 2);
  const none = state.setChanges(all);
  assert.deepEqual(paths(none.changes), ['a', 'b', 'c'], 'a scope with no file left shows every file');
  assert.deepEqual(none.scopeNote, { scoped: false, shown: 3, rest: 0 });
  assert.deepEqual(paths(state.setChanges(all).changes), ['a', 'b', 'c'], 'and the scope stays gone');
}

// d) filter, counts, shown.
{
  assert.equal(createCommitDialogState({ fileFilter: 'bogus' }).filter(), 'all');
  assert.equal(createCommitDialogState({ fileFilter: 7 }).filter(), 'all');
  assert.equal(createCommitDialogState().filter(), 'all');
  const state = createCommitDialogState({ fileFilter: 'untracked' });
  assert.equal(state.filter(), 'untracked');
  assert.equal(state.setFilter('nope'), false);
  assert.equal(state.filter(), 'untracked', 'an unknown value changes nothing');
  assert.equal(state.setFilter('tracked'), true);
  assert.equal(state.filter(), 'tracked');
  state.open(A, [], 1);
  state.setChanges([file('t1', { unstaged: true }), file('t2', { staged: true }), file('u', { untracked: true })]);
  assert.deepEqual(state.counts(), { all: 3, tracked: 2, untracked: 1 });
  assert.deepEqual(state.changes().filter(state.shown).map(c => c.path), ['t1', 't2']);
  assert.equal(state.firstShownFile().path, 't1');
  state.setFilter('untracked');
  assert.deepEqual(state.changes().filter(state.shown).map(c => c.path), ['u']);
  assert.equal(state.firstShownFile().path, 'u');
  state.setFilter('all');
  assert.equal(state.changes().filter(state.shown).length, 3);
  assert.equal(fileShown('all', true) && fileShown('all', false), true);
  assert.equal(fileShown('tracked', false), true);
  assert.equal(fileShown('tracked', true), false);
  assert.equal(fileShown('untracked', true), true);
  assert.equal(fileShown('untracked', false), false);
  state.setChanges([file('t1')]);
  state.setFilter('untracked');
  assert.equal(state.firstShownFile(), null, 'nothing shown');
}

// e) partlyStaged.
{
  const state = createCommitDialogState();
  state.open(A, [], 1);
  state.setChanges([
    file('both', { staged: true, unstaged: true }),
    file('stagedOnly', { staged: true }),
    file('untracked', { staged: true, unstaged: true, untracked: true }),
    file('conflict', { staged: true, unstaged: true, conflicted: true }),
    file('unticked', { staged: true, unstaged: true })
  ]);
  assert.deepEqual(paths(state.partlyStaged(['both', 'stagedOnly', 'untracked', 'conflict'])), ['both']);
  assert.deepEqual(state.partlyStaged([]), []);
  assert.deepEqual(paths(state.partlyStaged(['unticked', 'missing'])), ['unticked']);
}

// f) preview.
{
  const state = createCommitDialogState();
  state.open(A, [], 1);
  state.setChanges([file('s', { staged: true }), file('w', { unstaged: true }), file('n', { untracked: true })]);
  assert.equal(state.previewFile('missing'), null);
  assert.equal(state.previewedFile(), null);
  assert.equal(state.nextPreview('staged'), null, 'nothing previewed yet');
  assert.equal(state.previewFile('s').path, 's');
  assert.equal(state.previewedFile(), 's');
  assert.equal(state.previewedChange().path, 's');
  assert.equal(state.nextPreview('unstaged'), null, 'a staged-only file has no unstaged side');
  state.previewFile('w');
  assert.equal(state.nextPreview('staged'), null, 'an unstaged-only file has no staged side');
  state.previewFile('n');
  assert.ok(state.nextPreview('unstaged'), 'an untracked file shows as unstaged');
  assert.equal(state.nextPreview('staged'), null);

  state.previewFile('w');
  const { requestId } = state.nextPreview('unstaged');
  const payload = { repositoryPath: A, path: 'w', mode: 'unstaged', requestId };
  const open = { open: true, repositoryPath: A };
  assert.equal(state.isCurrentPreview(payload, open), true);
  assert.equal(state.isCurrentPreview(payload, { open: false, repositoryPath: A }), false, 'dialog closed');
  assert.equal(state.isCurrentPreview(payload, { open: true, repositoryPath: null }), false, 'no repository field');
  assert.equal(state.isCurrentPreview(payload, { open: true, repositoryPath: B }), false, 'another repository');
  assert.equal(state.isCurrentPreview({ ...payload, path: 's' }, open), false, 'another file');
  assert.equal(state.isCurrentPreview({ ...payload, mode: 'staged' }, open), false, 'another mode');
  assert.equal(state.isCurrentPreview({ ...payload, requestId: requestId - 1 }, open), false, 'an older id');
  const later = state.nextPreview('unstaged').requestId;
  assert.equal(later, requestId + 1);
  assert.equal(state.isCurrentPreview(payload, open), false, 'the old reply after a new request');
  assert.equal(state.isCurrentPreview({ ...payload, requestId: later }, open), true, 'the latest');
}

// g) Copilot's message.
{
  const state = createCommitDialogState();
  state.open(A, [], 1);
  assert.equal(state.messageRequest(), 0);
  const first = state.startMessage('staged');
  assert.equal(state.messageRequest(), first);
  assert.equal(state.isMessage(first), true);
  const second = state.startMessage(null);
  assert.ok(second > first);
  assert.equal(state.isMessage(first), false, 'an old id is not current after a new start');
  assert.equal(state.isMessage(second), true);
  state.endMessage();
  assert.equal(state.messageRequest(), 0);
  assert.equal(state.isMessage(second), false);

  // A non-blank draft is kept for Undo; the written partial comes from the pending one.
  state.startMessage('whole');
  assert.equal(state.messageWritten('feat: one', 'my draft'), 'my draft');
  assert.equal(state.writtenPartial(), 'whole');
  assert.equal(state.undoMessage(), 'my draft');
  assert.equal(state.metrics('x', 10).copilot, false, 'Undo forgets the Copilot message');
  assert.equal(state.undoMessage(), null, 'and the previous message');
  state.startMessage(undefined);
  assert.equal(state.messageWritten('feat: two', '   \n'), null, 'a blank draft is not kept');
  assert.equal(state.messageWritten('feat: two', null), null);
  assert.equal(state.writtenPartial(), null, 'no choice was pending');
  assert.equal(state.metrics('feat: two', 10).copilot, true);
  state.committed();
  assert.equal(state.writtenPartial(), null);
  assert.equal(state.metrics('feat: two', 10).copilot, false, 'committed() forgets the Copilot message');
  state.startMessage('staged');
  state.messageWritten('feat: three', '');
  state.committed();
  assert.equal(state.writtenPartial(), null);
}

// h) metrics.
{
  const state = createCommitDialogState();
  assert.deepEqual(state.metrics('msg', 5000), { durationMs: 0, copilot: false, editRatio: undefined }, 'never opened');
  state.open(A, [], 1000);
  assert.deepEqual(state.metrics('msg', 4500), { durationMs: 3500, copilot: false, editRatio: undefined });
  state.messageWritten('  feat: add login  ', '');
  const metrics = state.metrics('feat: add logins', 5000);
  assert.equal(metrics.durationMs, 4000);
  assert.equal(metrics.copilot, true);
  assert.equal(metrics.editRatio, editRatio('feat: add login', 'feat: add logins'), 'Copilot\'s message is trimmed');
}

// i) two states share nothing.
{
  const one = createCommitDialogState({ fileFilter: 'tracked' });
  const two = createCommitDialogState();
  one.open(A, ['x'], 1);
  one.setChanges([file('x')]);
  one.startMessage('staged');
  one.messageWritten('feat: x', 'draft');
  one.previewFile('x');
  assert.deepEqual(two.changes(), []);
  assert.equal(two.filter(), 'all');
  assert.equal(two.messageRequest(), 0);
  assert.equal(two.previewedFile(), null);
  assert.equal(two.writtenPartial(), null);
  assert.equal(two.undoMessage(), null);
  assert.equal(two.metrics('x', 5).copilot, false);
  assert.deepEqual(two.open(A, [], 1), { clearDraft: true });
  assert.equal(Object.isFrozen(require('../../resources/dashboardCommitDialog.js')), true);
}

console.log('dashboardCommitDialogSmoke ok');
