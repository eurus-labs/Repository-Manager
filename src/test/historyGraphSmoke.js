// The history graph's colours, branch segments and first-parent layout (resources/historyGraph.js).
const assert = require('node:assert/strict');
const graph = require('../../resources/historyGraph.js');

const local = name => ({ name, kind: 'local-branch' });
const remote = name => ({ name, kind: 'remote-branch' });
const head = { name: 'main', kind: 'head', isCurrent: true };
const rowOf = (model, commits, hash) => model.rows[commits.findIndex(commit => commit.hash === hash)];

// A branch keeps its colour: whatever loads above it, on another page, or under its origin/ name.
{
  const base = [
    { hash: 'x2', parentHashes: ['x1'], refs: [local('feature/x')] },
    { hash: 'm2', parentHashes: ['m1', 'x1'], refs: [head] },
    { hash: 'x1', parentHashes: ['m1'] },
    { hash: 'm1', parentHashes: [] }
  ];
  const toneOfX = commits => rowOf(graph.buildGraphModel(commits), commits, 'x2').color;
  const tone = toneOfX(base);
  // Two branches added above it, each opening a lane before it.
  const crowded = [
    { hash: 'a2', parentHashes: ['a1'], refs: [local('feature/other')] },
    { hash: 'b2', parentHashes: ['b1'], refs: [local('hotfix')] },
    ...base,
    { hash: 'a1', parentHashes: [] },
    { hash: 'b1', parentHashes: [] }
  ];
  assert.equal(toneOfX(crowded), tone, 'feature/x changed colour when other branches were added above it');
  // A longer page: the same commits followed by older ones.
  const longer = [...base.map(commit => commit.hash === 'm1' ? { ...commit, parentHashes: ['older'] } : commit), { hash: 'older', parentHashes: [] }];
  assert.equal(toneOfX(longer), tone, 'feature/x changed colour on another page');
  // origin/feature/x names the same branch.
  const remoteTip = base.map(commit => commit.hash === 'x2' ? { ...commit, refs: [remote('origin/feature/x')] } : commit);
  assert.equal(toneOfX(remoteTip), tone, 'origin/feature/x and feature/x have different tones');
  // HEAD's chain keeps tone 0.
  assert.deepEqual(graph.buildGraphModel(base).rows.filter(row => row.lane === 0).map(row => row.color), [0, 0]);
}

// Tone helpers: stable, within 0-7; origin/HEAD and tags are not branches.
{
  assert.equal(graph.toneForName('feature/x'), graph.toneForName('feature/x'));
  for (const name of ['a', 'main', 'feature/x', 'release/1.0', 'ü']) assert.ok(graph.toneForName(name) >= 0 && graph.toneForName(name) < 8);
  // Tone 0 is HEAD's line. A branch name never takes it, or about one branch in eight (feature/x among
  // them) would look like the checked-out line.
  for (const name of ['feature/x', 'feature/dashboard', ...Array.from({ length: 200 }, (_, index) => `branch-${index}`)]) {
    assert.notEqual(graph.toneForName(name), 0, `${name} took HEAD's tone`);
  }
  assert.equal(graph.branchNameOfRef(remote('origin/feature/x')), 'feature/x');
  assert.equal(graph.branchNameOfRef(local('feature/x')), 'feature/x');
  assert.equal(graph.branchNameOfRef(remote('origin/HEAD')), '', 'origin/HEAD is a pointer');
  assert.equal(graph.branchNameOfRef({ name: 'v1', kind: 'tag' }), '');
}

// A lane with no label takes a tone its neighbours do not use; a local label names a lane before a remote one.
{
  const commits = [
    { hash: 'u3', parentHashes: ['p3'] },
    { hash: 'u2', parentHashes: ['p2'] },
    { hash: 'u1', parentHashes: ['p1'] },
    { hash: 'm', parentHashes: ['r'], refs: [head] },
    { hash: 'p3', parentHashes: ['r'] },
    { hash: 'p2', parentHashes: ['r'] },
    { hash: 'p1', parentHashes: ['r'] },
    { hash: 'r', parentHashes: [] }
  ];
  const rows = graph.buildGraphModel(commits).rows;
  assert.deepEqual(rows.slice(0, 3).map(row => row.lane), [1, 2, 3], 'the three lines are not side by side');
  assert.notEqual(rows[0].color, rows[1].color, 'neighbouring unnamed lanes share a tone');
  assert.notEqual(rows[1].color, rows[2].color, 'neighbouring unnamed lanes share a tone');
  const named = [
    { hash: 'n', parentHashes: ['r'], refs: [remote('origin/zeta'), local('alpha')] },
    { hash: 'm', parentHashes: ['r'], refs: [head] },
    { hash: 'r', parentHashes: [] }
  ];
  assert.equal(graph.buildGraphModel(named).rows[0].color, graph.toneForName('alpha'), 'a remote label named the lane before a local one');
}

// Segments: one id along a branch line from its start to where it merges or ends; another line, another id.
{
  const commits = [
    { hash: 'm2', parentHashes: ['m1', 'f2'], refs: [head] },
    { hash: 'f2', parentHashes: ['f1'], refs: [local('feature')] },
    { hash: 'f1', parentHashes: ['m1'] },
    { hash: 'm1', parentHashes: ['m0'] },
    { hash: 'm0', parentHashes: [] }
  ];
  const model = graph.buildGraphModel(commits);
  const seg = hash => rowOf(model, commits, hash).segment;
  assert.equal(seg('f2'), seg('f1'), 'one branch line has two segment ids');
  assert.equal(seg('m2'), seg('m1'));
  assert.equal(seg('m1'), seg('m0'));
  assert.notEqual(seg('f2'), seg('m2'), 'two lines share a segment id');
  const mergeRow = rowOf(model, commits, 'm2');
  assert.equal(mergeRow.parentSegments.length, mergeRow.parentLanes.length);
  assert.equal(mergeRow.parentSegments[0], seg('m2'), 'the first-parent edge belongs to the main line');
  assert.equal(mergeRow.parentSegments[1], seg('f2'), 'the edge into the merged branch belongs to that branch');
  const f1 = rowOf(model, commits, 'f1');
  assert.equal(f1.parentSegments[0], seg('f2'), 'the edge where the branch joins the main line leaves its own line');
  assert.equal(f1.beforeSegments[f1.lane], seg('f2'));
  // Lanes that end and are reused are new segments.
  const reused = graph.buildGraphModel([
    { hash: 'a', parentHashes: ['r'], refs: [local('one')] },
    { hash: 'b', parentHashes: ['r'], refs: [local('two')] },
    { hash: 'c', parentHashes: ['r'], refs: [head] },
    { hash: 'r', parentHashes: [] }
  ]);
  assert.notEqual(reused.rows[0].segment, reused.rows[1].segment);
}

// First parent only: one column, merges stay as single commits, and nothing dangles.
{
  const commits = [
    { hash: 'm2', parentHashes: ['m1', 'f1'], refs: [head] },
    { hash: 'm1', parentHashes: ['m0'] },
    { hash: 'm0', parentHashes: [] }
  ];
  const model = graph.buildGraphModel(commits, { firstParent: true });
  assert.equal(model.laneCount, 1);
  assert.deepEqual(model.rows.map(row => row.lane), [0, 0, 0]);
  assert.equal(model.rows[0].isMerge, true, 'a merge stopped being marked');
  assert.deepEqual(model.rows[0].parentLanes, [0]);
  assert.deepEqual(model.rows[2].after.filter(Boolean), [], 'a lane was left dangling');
  assert.equal(graph.buildGraphModel(commits).laneCount, 2, 'without the option the merge still opens a second lane');
}

// The saved filter: a new field; older saved states read as off.
{
  assert.equal(graph.normalizeHistoryFilters(undefined).firstParent, false);
  assert.equal(graph.normalizeHistoryFilters({ branch: 'a', includeRemotes: false, search: '' }).firstParent, false);
  assert.equal(graph.normalizeHistoryFilters({ firstParent: true }).firstParent, true);
  assert.equal(graph.normalizeHistoryFilters({ firstParent: 'yes' }).firstParent, false);
}

console.log('History graph smoke passed');
