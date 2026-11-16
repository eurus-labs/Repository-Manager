const assert = require('node:assert/strict');
const { createWorkingTreeState, workingTreeCountText, workingChangeStatus } = require('../../resources/dashboardWorkingTree.js');

const A = '/repo/a';
const B = '/repo/b';
const file = (p, extra = {}) => ({ path: p, ...extra });
const loaded = (repo, paths) => {
  const state = createWorkingTreeState();
  state.setStatus(repo, paths.map(p => file(p)));
  return state;
};

// a) changes(): other repository -> []; files in an active discard are left out; another repository's finish is ignored.
{
  const state = loaded(A, ['x', 'y', 'z']);
  assert.deepEqual(state.changes(B), []);
  assert.equal(state.isKnown(A), true);
  assert.equal(state.isKnown(B), false);
  assert.equal(state.startDiscard({ repositoryPath: B, paths: ['x'] }, A), false);
  assert.equal(state.startDiscard({ repositoryPath: A, paths: 'x' }, A), false);
  assert.equal(state.startDiscard({ repositoryPath: A, paths: ['x', 'y'] }, A), true);
  assert.deepEqual(state.changes(A).map(c => c.path), ['z']);
  assert.equal(state.count(A), 3, 'the badge count is the raw list, not the discard-filtered one');
  assert.deepEqual(state.finishDiscard({ repositoryPath: B, success: true }), { handled: false, success: false });
  assert.deepEqual(state.changes(A).map(c => c.path), ['z'], 'a finish for another repository does not clear');
  assert.deepEqual(state.finishDiscard({ repositoryPath: A, success: false }), { handled: true, success: false });
  assert.deepEqual(state.changes(A).map(c => c.path), ['x', 'y', 'z']);
  assert.deepEqual(state.finishDiscard(null), { handled: false, success: false });
  state.startDiscard({ repositoryPath: A, paths: ['x'] }, A);
  assert.deepEqual(state.finishDiscard({ repositoryPath: A, success: true }), { handled: true, success: true });
  assert.equal(state.count(B), 0);
  state.reset();
  assert.equal(state.isKnown(A), false);
  assert.deepEqual(state.changes(A), []);
}

// b) isLatestStatus.
{
  const state = createWorkingTreeState();
  assert.equal(state.isLatestStatus({ repositoryPath: A, sequence: 5 }, 'dashboard'), true);
  assert.equal(state.isLatestStatus({ repositoryPath: A, sequence: 4 }, 'dashboard'), false, 'older, same purpose and repository');
  assert.equal(state.isLatestStatus({ repositoryPath: A, sequence: 5 }, 'dashboard'), true, 'the same sequence is accepted');
  assert.equal(state.isLatestStatus({ repositoryPath: A, sequence: 4 }, 'dialog'), true, 'other purpose');
  assert.equal(state.isLatestStatus({ repositoryPath: B, sequence: 4 }, 'dashboard'), true, 'other repository');
  assert.equal(state.isLatestStatus({ repositoryPath: A }, 'dashboard'), true, 'no sequence');
  assert.equal(state.isLatestStatus({ repositoryPath: A, sequence: 1 }, 'dashboard'), false, 'an unnumbered reply did not reset the mark');
  assert.equal(state.isLatestStatus(null, 'dashboard'), true);
}

// c) selection.
{
  const state = loaded(A, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(state.toggle('b', false, A), true);
  assert.equal(state.has('b'), true);
  assert.equal(state.toggle('b', false, A), true);
  assert.equal(state.has('b'), false);
  assert.equal(state.toggle('missing', false, A), false);
  assert.equal(state.toggle('d', false, A), true);
  assert.equal(state.toggle('b', true, A), true, 'Shift extends from the anchor d back to b');
  assert.deepEqual(state.selectedPaths(A), ['b', 'c', 'd'], 'list order');
  state.clearSelection();
  state.toggle('e', false, A);
  state.toggle('a', true, A);
  assert.deepEqual(state.selectedPaths(A), ['a', 'b', 'c', 'd', 'e']);
  state.setStatus(A, [file('b'), file('e')]);
  state.prune(A);
  assert.deepEqual(state.selectedPaths(A), ['b', 'e']);
  assert.equal(state.has('a'), false, 'a path no longer changed leaves the selection');
  state.clearSelection();
  state.toggle('b', false, A);
  state.setStatus(A, [file('e')]);
  state.prune(A);
  state.setStatus(A, [file('b'), file('e')]);
  state.toggle('e', true, A);
  assert.deepEqual(state.selectedPaths(A), ['e'], 'the anchor that left no longer extends');
  state.selectAllOrClear(A);
  assert.deepEqual(state.selectedPaths(A), ['b', 'e']);
  state.selectAllOrClear(A);
  assert.deepEqual(state.selectedPaths(A), []);
  state.toggle('b', false, A);
  state.reset();
  assert.equal(state.has('b'), false, 'reset clears the selection');
}

// d) summary coalescing.
{
  const state = createWorkingTreeState();
  assert.equal(state.requestSummary(null), false);
  assert.equal(state.requestSummary(A), true);
  assert.equal(state.requestSummary(A), false);
  assert.equal(state.requestSummary(A), false);
  assert.equal(state.summaryAnswered(B), false, 'an answer for another repository is ignored');
  assert.equal(state.summaryAnswered(A), true, 'asked again once');
  assert.equal(state.summaryAnswered(A), false, 'nothing in flight any more');
  assert.equal(state.requestSummary(A), true);
  assert.equal(state.summaryAnswered(A), false, 'no second ask came in');
}

// e) two states share nothing.
{
  const one = loaded(A, ['x']);
  const two = createWorkingTreeState();
  one.toggle('x', false, A);
  one.isLatestStatus({ repositoryPath: A, sequence: 9 }, 'dashboard');
  one.requestSummary(A);
  assert.equal(two.isKnown(A), false);
  assert.equal(two.has('x'), false);
  assert.equal(two.isLatestStatus({ repositoryPath: A, sequence: 1 }, 'dashboard'), true);
  assert.equal(two.requestSummary(A), true);
}

// f) status and count text.
{
  const cases = [
    [{ staged: true, indexStatus: 'M' }, { status: 'modified', state: 'staged' }],
    [{ unstaged: true, workTreeStatus: 'M' }, { status: 'modified', state: 'modified' }],
    [{ staged: true, unstaged: true }, { status: 'modified', state: 'staged + modified' }],
    [{ untracked: true }, { status: 'added', state: 'new' }],
    [{ conflicted: true }, { status: 'unmerged', state: 'conflict' }],
    [{ staged: true, originalPath: 'old', indexStatus: 'R' }, { status: 'renamed', state: 'staged' }],
    [{ unstaged: true, workTreeStatus: 'D' }, { status: 'deleted', state: 'modified' }],
    [{ staged: true, indexStatus: 'A' }, { status: 'added', state: 'staged' }]
  ];
  for (const [change, expected] of cases) assert.deepEqual(workingChangeStatus(change), expected);
  assert.equal(workingTreeCountText([]), '');
  assert.equal(workingTreeCountText([
    { staged: true }, { staged: true, unstaged: true }, { unstaged: true }, { untracked: true }, { conflicted: true, staged: true }
  ]), '2 staged · 2 modified · 1 new · 1 conflicted');
  assert.equal(Object.isFrozen(require('../../resources/dashboardWorkingTree.js')), true);
}

console.log('dashboardWorkingTreeSmoke ok');
