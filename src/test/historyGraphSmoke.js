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
  // HEAD's chain keeps column 0 and takes its branch's name tone (plan 22), not tone 0.
  assert.deepEqual(graph.buildGraphModel(base).rows.filter(row => row.lane === 0).map(row => row.color), [graph.toneForName('main'), graph.toneForName('main')]);
}

// A branch keeps its colour when it is checked out (plan 22): the same commits modelled with HEAD on main
// and with HEAD on feature/x give both lines the same tones; a detached HEAD's line is tone 0.
{
  const build = (mainRefs, featureRefs) => [
    { hash: 'x2', parentHashes: ['x1'], refs: featureRefs },
    { hash: 'm2', parentHashes: ['m1'], refs: mainRefs },
    { hash: 'x1', parentHashes: ['m1'] },
    { hash: 'm1', parentHashes: [] }
  ];
  const onMain = build([{ name: 'main', kind: 'head', isCurrent: true }], [local('feature/x')]);
  const onFeature = build([local('main')], [{ name: 'feature/x', kind: 'head', isCurrent: true }]);
  const tones = (commits, mainHash, featureHash) => {
    const model = graph.buildGraphModel(commits);
    return { main: rowOf(model, commits, mainHash).color, feature: rowOf(model, commits, featureHash).color };
  };
  const before = tones(onMain, 'm2', 'x2');
  const after = tones(onFeature, 'm2', 'x2');
  assert.deepEqual(before, { main: graph.toneForName('main'), feature: graph.toneForName('feature/x') });
  assert.deepEqual(after, before, 'a branch changed colour when it was checked out');
  assert.ok(before.main !== 0 && before.feature !== 0, 'a named line took tone 0');
  assert.equal(graph.buildGraphModel(onFeature).rows[0].lane, 0, 'the checked-out line left column 0');
  // A detached HEAD has no name: its line is tone 0.
  const detached = build([{ name: 'HEAD', kind: 'head', isCurrent: true }], [local('feature/x')]);
  assert.equal(rowOf(graph.buildGraphModel(detached), detached, 'm2').color, 0, 'a detached HEAD is not tone 0');
}

// A branch made from main (plan 22, amended): a lane's tone is the nearest branch label at or above a commit on its
// line, so it does not depend on which branch is checked out. feature/x is two commits ahead of main, main did not move,
// and fix/y diverges below main.
{
  const headRef = name => ({ name, kind: 'head', isCurrent: true });
  const build = (headOn, detached) => [
    { hash: 'x2', parentHashes: ['x1'], refs: detached ? [headRef('HEAD')] : [headOn === 'feature/x' ? headRef('feature/x') : local('feature/x')] },
    { hash: 'x1', parentHashes: ['a'] },
    { hash: 'a', parentHashes: ['z'], refs: [headOn === 'main' ? headRef('main') : local('main')] },
    { hash: 'y1', parentHashes: ['z'], refs: [local('fix/y')] },
    { hash: 'z', parentHashes: [] }
  ];
  const expected = { x2: graph.toneForName('feature/x'), x1: graph.toneForName('feature/x'), a: graph.toneForName('main'), y1: graph.toneForName('fix/y'), z: graph.toneForName('main') };
  const tonesOf = (commits, options) => {
    const model = graph.buildGraphModel(commits, options);
    return Object.fromEntries(commits.map((commit, index) => [commit.hash, model.rows[index].color]));
  };
  assert.deepEqual(tonesOf(build('main')), expected, 'with HEAD on main');
  assert.deepEqual(tonesOf(build('feature/x')), expected, 'with HEAD on feature/x main\'s history changed colour');
  // The edges below a labelled commit are in its tone (the lane's colours follow the switch).
  const checked = graph.buildGraphModel(build('feature/x'));
  assert.equal(checked.rows[2].color, graph.toneForName('main'));
  assert.equal(checked.rows[2].parentColors[0], graph.toneForName('main'), 'the edge below main is not main\'s tone');
  assert.equal(checked.rows[2].beforeColors[0], graph.toneForName('feature/x'), 'the edge above main is not the child\'s tone');
  assert.equal(checked.rows[3].afterColors[0], graph.toneForName('main'));
  // A detached HEAD above main is tone 0 down to main, then main's.
  const detached = tonesOf(build('', true));
  assert.deepEqual([detached.x2, detached.x1, detached.a, detached.z], [0, 0, graph.toneForName('main'), graph.toneForName('main')]);
  assert.equal(detached.x2, 0);
  // First-parent mode follows the same rule.
  const firstParent = commits => tonesOf(commits.filter(commit => commit.hash !== 'y1'), { firstParent: true });
  assert.deepEqual(firstParent(build('main')), { x2: expected.x2, x1: expected.x1, a: expected.a, z: expected.z });
  assert.deepEqual(firstParent(build('feature/x')), { x2: expected.x2, x1: expected.x1, a: expected.a, z: expected.z });
  // A commit labelled with two branches: the checked-out one counts, else the first local one.
  const two = headNamed => [{ hash: 'c2', parentHashes: ['c1'], refs: [local('alpha'), headNamed ? headRef('zeta') : local('zeta')] }, { hash: 'c1', parentHashes: [] }];
  assert.equal(tonesOf(two(true)).c2, graph.toneForName('zeta'), 'the head ref does not win');
  assert.equal(tonesOf(two(false)).c2, graph.toneForName('alpha'));
  // A remote label counts after the local ones.
  assert.equal(tonesOf([{ hash: 'r1', parentHashes: [], refs: [remote('origin/beta')] }]).r1, graph.toneForName('beta'));
}

// Branches that diverged (plan 22, Codex review): main moved after feature/x was made, so the two meet at m1, which has
// no label. The shared history below the fork takes the default branch's tone whatever is checked out; without a
// default branch, the first name in alphabetical order.
{
  const headRef = name => ({ name, kind: 'head', isCurrent: true });
  const ref = (name, headOn) => (name === headOn ? headRef(name) : local(name));
  const build = headOn => [
    { hash: 'x2', parentHashes: ['x1'], refs: [ref('feature/x', headOn)] },
    { hash: 'm2', parentHashes: ['m1'], refs: [ref('main', headOn)] },
    { hash: 'x1', parentHashes: ['m1'] },
    { hash: 'y1', parentHashes: ['m0'], refs: [ref('fix/y', headOn)] },
    { hash: 'm1', parentHashes: ['m0'] },
    { hash: 'm0', parentHashes: [] }
  ];
  const tonesOf = commits => {
    const model = graph.buildGraphModel(commits);
    return Object.fromEntries(commits.map((commit, index) => [commit.hash, model.rows[index].color]));
  };
  const main = graph.toneForName('main');
  const expected = { x2: graph.toneForName('feature/x'), m2: main, x1: graph.toneForName('feature/x'), y1: graph.toneForName('fix/y'), m1: main, m0: main };
  for (const headOn of ['main', 'feature/x', 'fix/y']) {
    assert.deepEqual(tonesOf(build(headOn)), expected, `with HEAD on ${headOn} the shared history changed colour`);
  }
  // The edges into the fork keep each child's tone; the line below it is main's.
  const checked = graph.buildGraphModel(build('feature/x'));
  assert.equal(checked.rows[4].beforeColors[0], graph.toneForName('feature/x'), 'the edge from x1 into the fork is not feature/x\'s tone');
  assert.equal(checked.rows[4].parentColors[0], main, 'the edge below the fork is not main\'s tone');
  // master is a default branch too; without one, the alphabetically first name wins, on either checkout.
  const pair = (a, b, headOn) => [
    { hash: 'a1', parentHashes: ['base'], refs: [ref(a, headOn)] },
    { hash: 'b1', parentHashes: ['base'], refs: [ref(b, headOn)] },
    { hash: 'base', parentHashes: [] }
  ];
  for (const headOn of ['master', 'feature/a']) assert.equal(tonesOf(pair('feature/a', 'master', headOn)).base, graph.toneForName('master'), `master lost with HEAD on ${headOn}`);
  for (const headOn of ['feature/b', 'feature/a']) assert.equal(tonesOf(pair('feature/b', 'feature/a', headOn)).base, graph.toneForName('feature/a'), `the shared base changed with HEAD on ${headOn}`);
}

// A lane a merge opens keeps its tone when Load more brings the merged parent into the list.
{
  const merge = subject => ({ hash: 'm3', parentHashes: ['m2', 'x2'], subject, refs: [head] });
  const mainRest = [{ hash: 'm2', parentHashes: ['m1'] }, { hash: 'm1', parentHashes: [] }];
  const edgeTone = commits => graph.buildGraphModel(commits).rows[0].parentColors[1];
  const firstPage = subject => [merge(subject), ...mainRest];
  const bothPages = subject => [merge(subject), ...mainRest.slice(0, 1), { hash: 'x2', parentHashes: ['m1'], refs: [local('feature/x')] }, mainRest[1]];
  const named = "Merge branch 'feature/x' into main";
  assert.equal(edgeTone(firstPage(named)), graph.toneForName('feature/x'), 'a merge lane is not named by its subject');
  assert.equal(edgeTone(bothPages(named)), edgeTone(firstPage(named)), 'the merge lane changed tone after Load more');
  for (const [subject, name] of [["Merge remote-tracking branch 'origin/feature/x'", 'feature/x'], ['Merge pull request #12 from alice/feature/x', 'feature/x'], ["Merge branch 'feature/x'", 'feature/x']]) {
    assert.equal(edgeTone(firstPage(subject)), graph.toneForName(name), subject);
  }
  // A subject that names nothing: the parent's hash, the same on both pages, and never tone 0.
  const custom = 'Integrate the work';
  assert.equal(edgeTone(firstPage(custom)), graph.toneForName('x2'));
  assert.equal(edgeTone(bothPages(custom)), edgeTone(firstPage(custom)), 'a merge lane with a custom subject changed tone after Load more');
  assert.notEqual(edgeTone(firstPage(custom)), 0);
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

// First parent only: a selected branch ahead of HEAD is one lane, not a second column curving into HEAD's.
{
  const commits = [
    { hash: 'tip', parentHashes: ['head'], refs: [local('feature/tip')] },
    { hash: 'head', parentHashes: ['base'], refs: [{ name: 'main', kind: 'head', isCurrent: true }] },
    { hash: 'base', parentHashes: [] }
  ];
  const model = graph.buildGraphModel(commits, { firstParent: true });
  assert.deepEqual(model.rows.map(row => row.lane), [0, 0, 0], 'the selected branch is not in column 0');
  assert.equal(model.laneCount, 1);
  assert.equal(new Set(model.rows.map(row => row.segment)).size, 1, 'the branch has more than one segment');
  // The tip's label colours it; the line switches to main's tone at the commit labelled main (plan 22, amended).
  assert.deepEqual(model.rows.map(row => row.color), [graph.toneForName('feature/tip'), graph.toneForName('main'), graph.toneForName('main')], 'the line did not switch tone at the main label');
  // A chain without HEAD takes its tip's tone.
  const away = graph.buildGraphModel([{ hash: 't', parentHashes: ['u'], refs: [local('feature/t')] }, { hash: 'u', parentHashes: [] }], { firstParent: true });
  assert.deepEqual(away.rows.map(row => row.color), [graph.toneForName('feature/t'), graph.toneForName('feature/t')]);
  assert.equal(graph.buildGraphModel(commits).laneCount, 2, 'the normal view changed');
}

// The saved filter: a new field; older saved states read as off.
{
  assert.equal(graph.normalizeHistoryFilters(undefined).firstParent, false);
  assert.equal(graph.normalizeHistoryFilters({ branch: 'a', includeRemotes: false, search: '' }).firstParent, false);
  assert.equal(graph.normalizeHistoryFilters({ firstParent: true }).firstParent, true);
  assert.equal(graph.normalizeHistoryFilters({ firstParent: 'yes' }).firstParent, false);
}

{
  // Labels that all fit show, with no room kept for a "+N" chip that would not be needed: 88, 88 and
  // 24 px with two 3 px gaps take 206 of 209 px.
  const count = (widths, budget, limit = widths.length) => graph.visibleRefCount(widths, budget, limit, 3, 30);
  assert.equal(count([88, 88, 24], 209), 3, 'labels that fit were folded to make room for an unneeded chip');
  // When they do not all fit, room is kept for the chip: 100 + 3 + 100 + 3 + 30 > 209.
  assert.equal(count([100, 100, 100], 209), 1);
  assert.equal(count([60, 60, 60, 60], 209), 2);
  // The narrow limit and the first label, which always shows.
  assert.equal(count([88, 88, 24], 209, 1), 1);
  assert.equal(count([400], 209), 1);
  assert.equal(count([], 209), 0);
}

console.log('History graph smoke passed');
