import * as assert from 'assert/strict';
import * as path from 'path';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { BranchService } from '../services/branchService';
import { countChanges } from '../services/submoduleService';
import { buildCommitMessagePrompt, cleanCommitMessage, collectCommitDiff, COMMIT_BODY_WIDTH, commitSections, DEFAULT_CONVENTION, findCommitConvention, MAX_COMMIT_DIFF_BYTES } from '../services/commitMessage';
import { snapshotLocalChanges } from '../services/localChangesSnapshot';
import { CommitService, parseWorkingTreeStatus } from '../services/commitService';
import { DiffService, parseChangedFilesOutput } from '../services/diffService';
import { GitCommandService } from '../services/gitCommandService';
import { ChangeContextService, EMPTY_TREE } from '../services/changeContextService';
import { validateSummary } from '../services/changeSummaryValidation';
import { buildSummaryBatches, combineBatchSummaries, splitPatch, SUMMARY_BATCH_BYTES } from '../services/changeSummaryBatches';
import { HistoryService, parseDecorations, parseHistoryOutput } from '../services/historyService';
import { HistoryActionService } from '../services/historyActionService';
import { HistoryRewriteService } from '../services/historyRewriteService';
import { parseStashesOutput, parseTagsOutput, ReferenceService } from '../services/referenceService';
import { renderDashboardToolbar } from '../webview/toolbar';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const historyGraph = require('../../resources/historyGraph.js') as {
  buildGraphModel: (commits: Array<{ hash: string; parentHashes: string[]; refs?: Array<{ name: string; isCurrent?: boolean; kind?: string }> }>,
    options?: { upstream?: string | null }) => {
    rows: Array<{ lane: number; color: number; parentLanes: number[]; incomingLanes: number[]; isMerge: boolean; isHead: boolean;
      before: Array<string | null>; after: Array<string | null> }>;
    laneCount: number;
    width: number;
  };
  laneX: (lane: number) => number;
  toggleCompareSelection: (selection: string[], commitHash: string) => string[];
  transitionCompareSelection: (
    selection: string[], commitHash: string, comparisonActive: boolean
  ) => { selection: string[]; action: 'compare' | 'parent' | 'none' };
  normalizeHistoryFilters: (saved: unknown) => { branch: string; includeRemotes: boolean; search: string };
};

function testParsers(): void {
  const history = parseHistoryOutput(
    'abcdef\x1fabc1234\x1fparent1 parent2\x1fJane Doe\x1fjane@example.com\x1f2026-09-21T10:00:00Z\x1fSubject with | delimiter\x1fHEAD -> refs/heads/main, tag: refs/tags/v1.1.0\x1e'
  );
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].parentHashes, ['parent1', 'parent2']);
  assert.equal(history[0].subject, 'Subject with | delimiter');
  assert.deepEqual(parseDecorations('HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.1.0'), [
    { name: 'main', kind: 'head', isCurrent: true },
    { name: 'origin/main', kind: 'remote-branch' },
    { name: 'v1.1.0', kind: 'tag' }
  ]);

  assert.deepEqual(parseChangedFilesOutput('M\0README.md\0R100\0old.ts\0new.ts\0D\0removed.ts\0'), [
    { path: 'README.md', status: 'modified' },
    { oldPath: 'old.ts', path: 'new.ts', status: 'renamed' },
    { path: 'removed.ts', status: 'deleted' }
  ]);

  assert.deepEqual(parseTagsOutput('v1.1.0\x00deadbeef\x002026-09-21T10:00:00Z\x1e\n'), [
    { name: 'v1.1.0', targetHash: 'deadbeef', createdAt: '2026-09-21T10:00:00Z' }
  ]);
  assert.deepEqual(parseStashesOutput('stash@{0}\x1fWIP on main\x1f2026-09-21T10:00:00Z\x1e'), [
    { index: 0, ref: 'stash@{0}', subject: 'WIP on main', createdAt: '2026-09-21T10:00:00Z' }
  ]);

  assert.deepEqual(parseWorkingTreeStatus(
    ' M src/modified.ts\0M  src/staged.ts\0MM src/both.ts\0?? src/new.ts\0R  src/new-name.ts\0src/old-name.ts\0UU src/conflict.ts\0'
  ), [
    {
      path: 'src/modified.ts', indexStatus: ' ', workTreeStatus: 'M',
      staged: false, unstaged: true, untracked: false, conflicted: false
    },
    {
      path: 'src/staged.ts', indexStatus: 'M', workTreeStatus: ' ',
      staged: true, unstaged: false, untracked: false, conflicted: false
    },
    {
      path: 'src/both.ts', indexStatus: 'M', workTreeStatus: 'M',
      staged: true, unstaged: true, untracked: false, conflicted: false
    },
    {
      path: 'src/new.ts', indexStatus: '?', workTreeStatus: '?',
      staged: false, unstaged: false, untracked: true, conflicted: false
    },
    {
      path: 'src/new-name.ts', originalPath: 'src/old-name.ts', indexStatus: 'R', workTreeStatus: ' ',
      staged: true, unstaged: false, untracked: false, conflicted: false
    },
    {
      path: 'src/conflict.ts', indexStatus: 'U', workTreeStatus: 'U',
      staged: true, unstaged: true, untracked: false, conflicted: true
    }
  ]);
}

function testPathBoundary(): void {
  const workspaceRoot = path.resolve('/workspace/project');
  const git = new GitCommandService(workspaceRoot);
  assert.equal(git.resolveRepositoryPath('.'), workspaceRoot);
  assert.equal(git.resolveRepositoryPath('packages/app'), path.join(workspaceRoot, 'packages', 'app'));
  assert.throws(() => git.resolveRepositoryPath('../outside'));
  assert.throws(() => git.resolveRepositoryPath('/tmp/outside'));
  assert.equal(git.resolveFilePath('src/index.ts'), 'src/index.ts');
  assert.throws(() => git.resolveFilePath('../secret'));
}

function testHistoryGraph(): void {
  const linear = historyGraph.buildGraphModel([
    { hash: 'c', parentHashes: ['b'] },
    { hash: 'b', parentHashes: ['a'] },
    { hash: 'a', parentHashes: [] }
  ]);
  assert.equal(linear.laneCount, 1);
  assert.deepEqual(linear.rows.map(row => row.lane), [0, 0, 0]);
  assert.equal(linear.width, 76);

  const merge = historyGraph.buildGraphModel([
    { hash: 'merge', parentHashes: ['left', 'right'] },
    { hash: 'left', parentHashes: ['root'] },
    { hash: 'right', parentHashes: ['root'] },
    { hash: 'root', parentHashes: [] }
  ]);
  assert.equal(merge.laneCount, 2);
  assert.equal(merge.rows[0].isMerge, true);
  assert.deepEqual(merge.rows[0].parentLanes, [0, 1]);
  assert.equal(merge.rows[2].lane, 1);

  // Git Graph style: the current branch stays in column 0 even when another branch's tip is newer,
  // and each branch keeps one colour; a branch forked from HEAD's tip curves into it.
  const head = { name: 'main', isCurrent: true };
  const branchy = historyGraph.buildGraphModel([
    { hash: 'f2', parentHashes: ['f1'], refs: [{ name: 'feature' }] },
    { hash: 'm2', parentHashes: ['m1', 'f1'], refs: [head] },
    { hash: 'f1', parentHashes: ['m1'] },
    { hash: 'm1', parentHashes: ['m0'] },
    { hash: 'm0', parentHashes: [] }
  ]);
  assert.deepEqual(branchy.rows.map(row => row.lane), [1, 0, 1, 0, 0]);
  assert.equal(branchy.rows[1].isHead, true);
  assert.deepEqual(branchy.rows.filter(row => row.lane === 0).map(row => row.color), [0, 0, 0]);
  assert.equal(branchy.rows[0].color, branchy.rows[2].color, 'feature changed colour along its path');
  assert.notEqual(branchy.rows[0].color, 0);
  // f1 is expected by both f2 (lane 1) and the merge m2: one lane, never a dangling duplicate.
  assert.equal(branchy.rows[2].after.filter(hash => hash === 'm1').length, 1);
  assert.deepEqual(branchy.rows[3].incomingLanes, [], 'm1 is reached through the merge of f1 into lane 0');
  const forked = historyGraph.buildGraphModel([
    { hash: 'x1', parentHashes: ['h'], refs: [{ name: 'topic' }] },
    { hash: 'h', parentHashes: ['r'], refs: [head] },
    { hash: 'r', parentHashes: [] }
  ]);
  assert.deepEqual(forked.rows.map(row => row.lane), [1, 0, 0]);
  assert.deepEqual(forked.rows[1].incomingLanes, [1], 'the topic branch does not curve into HEAD');
  assert.deepEqual(forked.rows[1].after.filter(Boolean), ['r'], 'a lane was left dangling');

  // An upstream ahead of HEAD continues the main column instead of opening a side lane.
  const local = { name: 'feature/x', isCurrent: true };
  const ahead = historyGraph.buildGraphModel([
    { hash: 'u2', parentHashes: ['u1'], refs: [{ name: 'origin/feature/x', kind: 'remote-branch' }] },
    { hash: 'u1', parentHashes: ['h'] },
    { hash: 'h', parentHashes: ['r'], refs: [local] },
    { hash: 'r', parentHashes: [] }
  ], { upstream: 'origin/feature/x' });
  assert.deepEqual(ahead.rows.map(row => row.lane), [0, 0, 0, 0], 'an ahead upstream left the main column');
  assert.deepEqual(ahead.rows.map(row => row.isHead), [false, false, true, false], 'the HEAD ring moved off HEAD');
  assert.equal(ahead.laneCount, 1);
  // A diverged upstream is a real fork and keeps its own column.
  const diverged = historyGraph.buildGraphModel([
    { hash: 'u1', parentHashes: ['r'], refs: [{ name: 'origin/feature/x', kind: 'remote-branch' }] },
    { hash: 'h', parentHashes: ['r'], refs: [local] },
    { hash: 'r', parentHashes: [] }
  ], { upstream: 'origin/feature/x' });
  assert.deepEqual(diverged.rows.map(row => row.lane), [1, 0, 0]);
  // Only the configured upstream counts. `work` tracking `upstream/release`: a same-named
  // `origin/work` descending from HEAD is not it, while the real upstream continues the column.
  const work = { name: 'work', isCurrent: true };
  const sameName = [
    { hash: 'o1', parentHashes: ['h'], refs: [{ name: 'origin/work', kind: 'remote-branch' }] },
    { hash: 'h', parentHashes: ['r'], refs: [work] },
    { hash: 'r', parentHashes: [] }
  ];
  assert.deepEqual(historyGraph.buildGraphModel(sameName, { upstream: 'upstream/release' }).rows.map(row => row.lane), [1, 0, 0],
    'a same-named remote branch was taken for the upstream');
  assert.deepEqual(historyGraph.buildGraphModel(sameName).rows.map(row => row.lane), [1, 0, 0], 'guessed an upstream without one');
  const tracked = historyGraph.buildGraphModel([
    { hash: 'u1', parentHashes: ['h'], refs: [{ name: 'upstream/release', kind: 'remote-branch' }] },
    { hash: 'h', parentHashes: ['r'], refs: [work] },
    { hash: 'r', parentHashes: [] }
  ], { upstream: 'upstream/release' });
  assert.deepEqual(tracked.rows.map(row => row.lane), [0, 0, 0], 'a differently named upstream was not followed');

  const octopusParents = Array.from({ length: 8 }, (_, index) => `parent-${index}`);
  const octopus = historyGraph.buildGraphModel([
    { hash: 'octopus', parentHashes: octopusParents },
    ...octopusParents.map(hash => ({ hash, parentHashes: [] }))
  ]);
  assert.equal(octopus.laneCount, 8);
  assert.ok(octopus.width > 76);
  assert.equal(new Set(octopusParents.map((_, index) => historyGraph.laneX(index))).size, 8);

  let selection: string[] = [];
  selection = historyGraph.toggleCompareSelection(selection, 'a');
  selection = historyGraph.toggleCompareSelection(selection, 'b');
  assert.deepEqual(selection, ['a', 'b']);
  selection = historyGraph.toggleCompareSelection(selection, 'c');
  assert.deepEqual(selection, ['b', 'c']);
  selection = historyGraph.toggleCompareSelection(selection, 'b');
  assert.deepEqual(selection, ['c']);

  assert.deepEqual(historyGraph.transitionCompareSelection(['a', 'b'], 'b', true), {
    selection: ['a'], action: 'parent'
  });
  assert.deepEqual(historyGraph.transitionCompareSelection(['a'], 'b', false), {
    selection: ['a', 'b'], action: 'compare'
  });
  assert.deepEqual(historyGraph.transitionCompareSelection([], 'a', false), {
    selection: ['a'], action: 'none'
  });
  assert.deepEqual(historyGraph.transitionCompareSelection(['a', 'b'], 'c', true), {
    selection: ['c'], action: 'parent'
  });
  assert.deepEqual(historyGraph.normalizeHistoryFilters(undefined), {
    branch: '', includeRemotes: true, search: ''
  });
  assert.deepEqual(historyGraph.normalizeHistoryFilters({
    branch: 'origin/main', includeRemotes: false, search: 'merge'
  }), {
    branch: 'origin/main', includeRemotes: false, search: 'merge'
  });
}

function testDashboardToolbarHierarchy(): void {
  const toolbar = renderDashboardToolbar({ ahead: 2, behind: 3 });

  assert.match(toolbar, /class="dashboard-remote-actions"[^>]*role="group"/);
  assert.match(toolbar, /class="dashboard-command dashboard-command-secondary"[^>]*data-action="openCreateBranchModal"/);
  assert.match(toolbar, /class="dashboard-command dashboard-command-commit"[^>]*data-action="openCommitChangesModal"/);
  assert.match(toolbar, /dashboard-command-commit[^>]*>[\s\S]*?<svg[\s\S]*?Commit/);
  assert.ok(toolbar.indexOf('data-action="openCreateBranchModal"') < toolbar.indexOf('data-action="openCommitChangesModal"'));
  assert.match(toolbar, /id="dashboardAheadCount"[^>]*>2<\/small>/);
  assert.match(toolbar, /id="dashboardBehindCount"[^>]*>3<\/small>/);
}

async function testRepositoryIntegration(): Promise<void> {
  const git = new GitCommandService(process.cwd());
  assert.equal(await git.isGitRepository(), true);

  const branchService = new BranchService(git);
  const commitService = new CommitService(git);
  const historyService = new HistoryService(git);
  const diffService = new DiffService(git);
  const referenceService = new ReferenceService(git, branchService, commitService);

  const page = await historyService.getHistory({ repositoryPath: '.', limit: 2 });
  assert.equal(page.offset, 0);
  assert.ok(page.commits.length > 0);
  assert.ok(page.commits.length <= 2);

  const detail = await diffService.getCommitDetail('.', page.commits[0].hash);
  assert.equal(detail.hash, page.commits[0].hash);
  assert.ok(Array.isArray(detail.files));
  assert.equal(detail.comparisonBaseHash, page.commits[0].parentHashes[0] || null);
  assert.equal(detail.comparisonMode, page.commits[0].parentHashes.length > 0 ? 'parent' : 'root');

  if (page.commits.length > 1) {
    const rangeDetail = await diffService.getCommitDetail('.', page.commits[0].hash, page.commits[1].hash);
    assert.equal(rangeDetail.comparisonBaseHash, page.commits[1].hash);
    assert.equal(rangeDetail.comparisonMode, 'range');
    if (rangeDetail.files.length > 0) {
      const fileDiff = await diffService.getFileDiff(
        '.', page.commits[0].hash, rangeDetail.files[0].path, page.commits[1].hash
      );
      assert.equal(fileDiff.baseCommitHash, page.commits[1].hash);
      assert.equal(fileDiff.commitHash, page.commits[0].hash);
    }
  }

  const mergeHashes = (await git.execGit(['rev-list', '--merges', '--max-count=10', 'HEAD']))
    .split('\n')
    .filter(Boolean);
  if (mergeHashes.length > 0) {
    const mergeDetails = await Promise.all(mergeHashes.map(hash => diffService.getCommitDetail('.', hash)));
    assert.ok(mergeDetails.some(mergeDetail => mergeDetail.files.length > 0));
    for (const mergeDetail of mergeDetails) {
      assert.equal(mergeDetail.comparisonBaseHash, mergeDetail.parentHashes[0] || null);
    }
  }

  const refs = await referenceService.getRepositoryRefs('.');
  assert.equal(refs.repositoryPath, '.');
  const checkedOutBranch = await git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  if (checkedOutBranch) {
    assert.ok(refs.branches.some(branch => branch.name === checkedOutBranch));
  } else {
    // A tag checkout has a valid HEAD with no local branch.
    assert.ok(Array.isArray(refs.branches));
  }
}

async function testBranchFromHistoryCommit(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-history-'));
  const git = new GitCommandService(root);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'History Test']);
    await git.execGit(['config', 'user.email', 'history@example.com']);
    writeFileSync(path.join(root, 'file.txt'), 'first\n');
    await git.execGit(['add', 'file.txt']);
    await git.execGit(['commit', '-qm', 'first']);
    const first = await git.execGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(root, 'file.txt'), 'second\n');
    await git.execGit(['commit', '-qam', 'second']);
    const latest = await git.execGit(['rev-parse', 'HEAD']);
    const branch = new BranchService(git);
    assert.equal((await branch.createBranchFromCommit('.', 'topic/old', first, false)).success, true);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), latest);
    assert.equal(await git.execGit(['rev-parse', 'topic/old']), first);
    assert.equal((await branch.createBranchFromCommit('.', 'topic/old', latest, false)).success, false);
    assert.equal((await branch.createBranchFromCommit('.', '-bad', latest, false)).success, false);
    assert.equal((await branch.createBranchFromCommit('.', 'topic/current', first, true)).success, true);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), first);
    assert.equal(await git.execGit(['symbolic-ref', '--short', 'HEAD']), 'topic/current');
    const checkout = await new CommitService(git).checkoutCommit('.', latest, true);
    assert.equal(checkout.success, true);
    assert.equal(await git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testAnnotatedTagFromHistoryCommit(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-tag-'));
  const git = new GitCommandService(root);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'Tag Test']);
    await git.execGit(['config', 'user.email', 'tag@example.com']);
    writeFileSync(path.join(root, 'file.txt'), 'first\n');
    await git.execGit(['add', 'file.txt']);
    await git.execGit(['commit', '-qm', 'first']);
    const first = await git.execGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(root, 'file.txt'), 'second\n');
    await git.execGit(['commit', '-qam', 'second']);
    const latest = await git.execGit(['rev-parse', 'HEAD']);
    const service = new ReferenceService(git, new BranchService(git), new CommitService(git));
    assert.equal((await service.createAnnotatedTag('.', 'v1.4.0', 'Release candidate', first)).success, true);
    assert.equal(await git.execGit(['cat-file', '-t', 'refs/tags/v1.4.0']), 'tag');
    assert.equal(await git.execGit(['rev-parse', 'v1.4.0^{commit}']), first);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), latest);
    assert.ok((await service.getRepositoryRefs('.')).tags.some(tag => tag.name === 'v1.4.0'));
    assert.equal((await service.createAnnotatedTag('.', 'v1.4.0', 'Duplicate', latest)).success, false);
    assert.equal((await service.createAnnotatedTag('.', '-invalid', 'Message', first)).success, false);
    assert.equal((await service.createAnnotatedTag('.', 'valid', ' ', first)).success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testHistoryApplyActions(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-actions-'));
  const git = new GitCommandService(root);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'History Actions Test']);
    await git.execGit(['config', 'user.email', 'history-actions@example.com']);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    await git.execGit(['add', 'base.txt']);
    await git.execGit(['commit', '-qm', 'base']);
    const base = await git.execGit(['rev-parse', 'HEAD']);
    await git.execGit(['switch', '-c', 'source']);
    writeFileSync(path.join(root, 'new.txt'), 'source\n');
    await git.execGit(['add', 'new.txt']);
    await git.execGit(['commit', '-qm', 'add source']);
    const source = await git.execGit(['rev-parse', 'HEAD']);
    await git.execGit(['switch', '-c', 'target', base]);
    writeFileSync(path.join(root, 'target.txt'), 'target only\n');
    await git.execGit(['add', 'target.txt']);
    await git.execGit(['commit', '-qm', 'target only']);
    const actions = new HistoryActionService(git);
    assert.equal((await actions.describe('.', source)).branch, 'target');
    assert.equal((await actions.apply('.', source, 'cherry-pick')).success, true);
    assert.equal(await git.execGit(['show', '-s', '--format=%s', 'HEAD']), 'add source');
    assert.equal((await actions.apply('.', 'HEAD', 'revert')).success, true);
    assert.equal(await git.execGit(['show', '-s', '--format=%s', 'HEAD']), 'Revert "add source"');
    assert.equal((await actions.apply('.', source, 'merge')).success, true);
    const merged = await git.execGit(['rev-parse', 'HEAD']);
    assert.equal((await actions.describe('.', merged)).parents.length, 2);
    assert.equal((await actions.apply('.', merged, 'revert')).success, false);
    assert.equal((await actions.apply('.', merged, 'revert', 1)).success, true);
    await git.execGit(['switch', '-c', 'pick-merge', base]);
    assert.equal((await actions.apply('.', merged, 'cherry-pick')).success, false);
    assert.equal((await actions.apply('.', merged, 'cherry-pick', 1)).success, true);
    const beforeEmpty = await git.execGit(['rev-parse', 'HEAD']);
    const empty = await actions.apply('.', beforeEmpty, 'cherry-pick', undefined, 'pick-merge');
    assert.equal(empty.success, false);
    assert.match(empty.message, /cherry-pick --skip/);
    assert.doesNotMatch(empty.message, /cherry-pick --continue/);
    assert.equal((await actions.abort('.', 'cherry-pick')).success, true);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), beforeEmpty);
    await git.execGit(['switch', '-c', 'changed-branch']);
    const changedBranch = await actions.apply('.', source, 'cherry-pick', undefined, 'pick-merge');
    assert.equal(changedBranch.success, false);
    assert.match(changedBranch.message, /Current branch changed/);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), beforeEmpty);
    const applyPath = path.join(root, '.git', 'rebase-apply');
    mkdirSync(applyPath);
    writeFileSync(path.join(applyPath, 'applying'), '');
    assert.equal(await actions.pendingOperation('.'), 'am');
    const blocked = await actions.apply('.', source, 'cherry-pick', undefined, 'changed-branch');
    assert.equal(blocked.success, false);
    assert.match(blocked.message, /Finish or abort the current Git operation/);
    rmSync(applyPath, { recursive: true, force: true });
    writeFileSync(path.join(root, 'dirty.txt'), 'untracked\n');
    const current = await git.execGit(['rev-parse', 'HEAD']);
    assert.equal((await actions.apply('.', source, 'merge')).success, false);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), current);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testHistoryApplyConflict(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-conflict-'));
  const git = new GitCommandService(root);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'Conflict Test']);
    await git.execGit(['config', 'user.email', 'conflict@example.com']);
    writeFileSync(path.join(root, 'shared.txt'), 'base\n');
    await git.execGit(['add', 'shared.txt']);
    await git.execGit(['commit', '-qm', 'base']);
    const base = await git.execGit(['rev-parse', 'HEAD']);
    await git.execGit(['switch', '-c', 'source']);
    writeFileSync(path.join(root, 'shared.txt'), 'source\n');
    await git.execGit(['commit', '-qam', 'source edit']);
    const source = await git.execGit(['rev-parse', 'HEAD']);
    await git.execGit(['switch', '-c', 'target', base]);
    writeFileSync(path.join(root, 'shared.txt'), 'target\n');
    await git.execGit(['commit', '-qam', 'target edit']);
    const actions = new HistoryActionService(git);
    const cherry = await actions.apply('.', source, 'cherry-pick');
    assert.equal(cherry.success, false);
    assert.equal((cherry.data as { pending?: string }).pending, 'cherry-pick');
    assert.equal((await actions.abort('.', 'cherry-pick')).success, true);
    assert.equal(await actions.pendingOperation('.'), undefined);
    const merge = await actions.apply('.', source, 'merge');
    assert.equal(merge.success, false);
    assert.equal((merge.data as { pending?: string }).pending, 'merge');
    assert.equal((await actions.abort('.', 'merge')).success, true);
    assert.equal(await git.execGit(['status', '--porcelain']), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testHistoryRewrite(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-rewrite-'));
  const git = new GitCommandService(root);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'Rewrite Test']);
    await git.execGit(['config', 'user.email', 'rewrite@example.com']);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'base']);
    const base = await git.execGit(['rev-parse', 'HEAD']);
    const rewrite = new HistoryRewriteService(git);
    await git.execGit(['switch', '-c', 'source']);
    writeFileSync(path.join(root, 'source.txt'), 'source\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'source']);
    const source = await git.execGit(['rev-parse', 'HEAD']);
    await git.execGit(['switch', '-c', 'target', base]);
    writeFileSync(path.join(root, 'target.txt'), 'target\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'target']);
    const oldHead = await git.execGit(['rev-parse', 'HEAD']);
    const preview = await rewrite.preview('.', source, 'rebase');
    assert.equal(preview.branch, 'target');
    assert.equal(preview.affectedCount, 1);
    assert.equal(preview.affected[0].subject, 'target');
    assert.equal((await rewrite.execute('.', source, 'rebase', 'wrong', oldHead)).success, false);
    assert.equal((await rewrite.execute('.', source, 'rebase', 'target', base)).success, false);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), oldHead);
    const rebased = await rewrite.execute('.', source, 'rebase', 'target', oldHead);
    assert.equal(rebased.success, true, rebased.message);
    assert.equal(await git.execGit(['rev-parse', 'HEAD^']), source);
    assert.notEqual(await git.execGit(['rev-parse', 'HEAD']), oldHead);
    const afterRebase = await git.execGit(['rev-parse', 'HEAD']);
    assert.equal((await rewrite.execute('.', base, 'reset', 'target', afterRebase, 'soft')).success, true);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), base);
    assert.equal(await git.execGit(['write-tree']), await git.execGit(['rev-parse', `${afterRebase}^{tree}`]));
    // Soft reset leaves the index intact, so mixed reset requires committing first.
    assert.equal((await rewrite.execute('.', afterRebase, 'reset', 'target', base, 'mixed')).success, false);
    await git.execGit(['reset', '--hard', afterRebase]);
    const hard = await rewrite.execute('.', base, 'reset', 'target', afterRebase, 'hard');
    assert.equal(hard.success, true, hard.message);
    const backup = (hard.data as { backup: string }).backup;
    assert.equal(await git.execGit(['rev-parse', backup]), afterRebase);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), base);
    assert.equal(await git.execGit(['status', '--porcelain']), '');
    const applyPath = path.join(root, '.git', 'rebase-apply');
    mkdirSync(applyPath);
    writeFileSync(path.join(applyPath, 'applying'), '');
    assert.equal((await rewrite.execute('.', afterRebase, 'reset', 'target', base, 'mixed')).success, false);
    rmSync(applyPath, { recursive: true, force: true });
    assert.equal((await rewrite.execute('.', afterRebase, 'reset', 'target', base, 'mixed')).success, true);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), afterRebase);
    writeFileSync(path.join(root, 'untracked.txt'), 'dirty\n');
    assert.equal((await rewrite.execute('.', base, 'reset', 'target', afterRebase, 'hard')).success, false);
    rmSync(path.join(root, 'untracked.txt'));
    assert.equal((await rewrite.execute('.', '0'.repeat(40), 'reset', 'target', afterRebase, 'hard')).success, false);
    await assert.rejects(rewrite.preview('.', base, 'drop'), /root or merge commit/);

    await git.execGit(['switch', '-c', 'drop-branch', base]);
    writeFileSync(path.join(root, 'one.txt'), 'one\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'drop this']);
    const dropped = await git.execGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(root, 'two.txt'), 'two\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'keep this']);
    const beforeDrop = await git.execGit(['rev-parse', 'HEAD']);
    const dropPreview = await rewrite.preview('.', dropped, 'drop');
    assert.equal(dropPreview.affectedCount, 1);
    assert.equal(dropPreview.targetSubject, 'drop this');
    await git.execGit(['update-ref', 'refs/remotes/origin/published', dropped]);
    await assert.rejects(rewrite.preview('.', dropped, 'drop'), /published commit/);
    await git.execGit(['update-ref', '-d', 'refs/remotes/origin/published']);
    assert.equal((await rewrite.execute('.', source, 'drop', 'drop-branch', beforeDrop)).success, false);
    const dropResult = await rewrite.execute('.', dropped, 'drop', 'drop-branch', beforeDrop);
    assert.equal(dropResult.success, true, dropResult.message);
    assert.equal(await git.execGit(['rev-parse', (dropResult.data as { backup: string }).backup]), beforeDrop);
    assert.equal(await git.execGit(['show', '-s', '--format=%s', 'HEAD']), 'keep this');
    assert.equal(await git.execGit(['rev-parse', 'HEAD^']), base);
    assert.equal(await git.execGit(['ls-files', 'one.txt']), '');
    const last = await git.execGit(['rev-parse', 'HEAD']);
    assert.equal((await rewrite.preview('.', last, 'drop')).affectedCount, 0);
    assert.equal((await rewrite.execute('.', last, 'drop', 'drop-branch', last)).success, true);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), base);

    const linked = path.join(root, 'linked');
    await git.execGit(['worktree', 'add', '-qb', 'linked-branch', linked, base]);
    const linkedPreview = await rewrite.preview('linked', source, 'reset');
    assert.equal(linkedPreview.branch, 'linked-branch');
    assert.equal(linkedPreview.head, base);
    assert.equal((await rewrite.execute('linked', source, 'reset', 'linked-branch', base, 'hard')).success, true);
    assert.equal(await git.execGit(['rev-parse', 'HEAD'], linked), source);
    assert.equal(await git.execGit(['symbolic-ref', '--short', 'HEAD']), 'drop-branch');

    await git.execGit(['switch', '-c', 'merge-branch', base]);
    writeFileSync(path.join(root, 'start.txt'), 'start\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'start']);
    const start = await git.execGit(['rev-parse', 'HEAD']);
    await git.execGit(['switch', '-c', 'side']);
    writeFileSync(path.join(root, 'side.txt'), 'side\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'side']);
    await git.execGit(['switch', 'merge-branch']);
    writeFileSync(path.join(root, 'main.txt'), 'main\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'main']);
    await git.execGit(['merge', '--no-ff', '--no-edit', 'side']);
    await assert.rejects(rewrite.preview('.', start, 'drop'), /merge commits/);
    await assert.rejects(rewrite.preview('.', source, 'rebase'), /merge commits/);
    const resetMergePreview = await rewrite.preview('.', base, 'reset');
    assert.equal(resetMergePreview.affectedCount, 4);
    assert.ok(resetMergePreview.affected.some(item => item.subject === 'side'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testHistoryRewriteConflict(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-rebase-'));
  const git = new GitCommandService(root);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'Rebase Test']);
    await git.execGit(['config', 'user.email', 'rebase@example.com']);
    writeFileSync(path.join(root, 'shared.txt'), 'base\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'base']);
    const base = await git.execGit(['rev-parse', 'HEAD']);
    await git.execGit(['switch', '-c', 'source']);
    writeFileSync(path.join(root, 'shared.txt'), 'source\n');
    await git.execGit(['commit', '-qam', 'source']);
    const source = await git.execGit(['rev-parse', 'HEAD']);
    await git.execGit(['switch', '-c', 'target', base]);
    writeFileSync(path.join(root, 'shared.txt'), 'target\n');
    await git.execGit(['commit', '-qam', 'target']);
    const head = await git.execGit(['rev-parse', 'HEAD']);
    const rewrite = new HistoryRewriteService(git);
    const conflict = await rewrite.execute('.', source, 'rebase', 'target', head);
    assert.equal(conflict.success, false);
    assert.equal((conflict.data as { pending: string }).pending, 'rebase');
    assert.equal((await rewrite.resolveRebase('.', 'abort')).success, true);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), head);
    assert.equal(await new HistoryActionService(git).pendingOperation('.'), undefined);
    assert.equal((await rewrite.execute('.', source, 'rebase', 'target', head)).success, false);
    writeFileSync(path.join(root, 'shared.txt'), 'resolved\n');
    await git.execGit(['add', 'shared.txt']);
    const continued = await rewrite.resolveRebase('.', 'continue');
    assert.equal(continued.success, true, continued.message);
    assert.equal(await git.execGit(['rev-parse', 'HEAD^']), source);
    assert.equal(await new HistoryActionService(git).pendingOperation('.'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testHistoryRewriteSha256(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-sha256-'));
  const git = new GitCommandService(root);
  try {
    await git.execGit(['init', '-q', '--object-format=sha256']);
    await git.execGit(['config', 'user.name', 'SHA256 Test']);
    await git.execGit(['config', 'user.email', 'sha256@example.com']);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'base']);
    const base = await git.execGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(root, 'next.txt'), 'next\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-qm', 'next']);
    const head = await git.execGit(['rev-parse', 'HEAD']);
    assert.equal(head.length, 64);
    const branch = await git.execGit(['symbolic-ref', '--short', 'HEAD']);
    const result = await new HistoryRewriteService(git).execute('.', base, 'reset', branch, head, 'hard');
    assert.equal(result.success, true, result.message);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testCountChanges(): void {
  const lines = [
    '# branch.oid abc', '# branch.head main',
    '1 M. N... 100644 100644 100644 a a staged.txt',
    '1 .M N... 100644 100644 100644 a a modified.txt',
    '1 MM N... 100644 100644 100644 a a both.txt',
    '2 R. N... 100644 100644 100644 a a R100 new.txt\told.txt',
    'u UU N... 100644 100644 100644 100644 a a a conflict.txt',
    '? new file.txt', '? other.txt', '! ignored.txt', ''
  ];
  assert.deepEqual(countChanges(lines), { staged: 3, modified: 2, untracked: 2, conflicted: 1 });
  assert.deepEqual(countChanges(['# branch.oid abc']), { staged: 0, modified: 0, untracked: 0, conflicted: 0 });
}

async function testCommitSelectedFiles(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-commit-'));
  const git = new GitCommandService(root);
  const write = (file: string, content: string) => writeFileSync(path.join(root, file), content);
  const status = () => git.execGitRaw(['status', '--porcelain=v1'], root);
  const show = (spec: string) => git.execGit(['show', spec], root);
  try {
    await git.execGit(['init', '-q', '-b', 'main']);
    await git.execGit(['config', 'user.name', 'Commit Test']);
    await git.execGit(['config', 'user.email', 'commit@example.com']);
    const service = new CommitService(git);

    // A first commit, in a repository with no HEAD yet.
    write('a.txt', 'a1\n');
    write('b.txt', 'b1\n');
    write('old.txt', 'moved\n');
    let result = await service.commitFiles('.', ['a.txt', 'b.txt', 'old.txt'], 'initial');
    assert.equal(result.success, true, result.message);
    assert.equal(await status(), '');

    // a.txt is staged, then changed again; b.txt is staged and not selected.
    write('a.txt', 'a2 staged\n');
    await git.execGit(['add', 'a.txt']);
    write('a.txt', 'a3 later\n');
    write('b.txt', 'b2 staged\n');
    await git.execGit(['add', 'b.txt']);
    const head = await git.execGit(['rev-parse', 'HEAD']);

    // A partly staged file needs a choice; nothing is committed or restaged without one.
    result = await service.commitFiles('.', ['a.txt'], 'no choice');
    assert.equal(result.success, false);
    assert.match(result.message, /partly staged/);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), head);
    assert.equal(await status(), 'MM a.txt\nM  b.txt\n');

    // A rejecting hook: the commit fails and the index is exactly as it was (no leftover git add).
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    result = await service.commitFiles('.', ['a.txt'], 'rejected', 'whole');
    assert.equal(result.success, false);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), head);
    assert.equal(await status(), 'MM a.txt\nM  b.txt\n', 'a failed commit changed the index');
    assert.equal(await show(':a.txt'), 'a2 staged');
    rmSync(hook);

    // Only the staged part: the commit has the staged version, the later change stays unstaged,
    // and b.txt (staged, not selected) is neither committed nor unstaged.
    result = await service.commitFiles('.', ['a.txt'], 'staged part', 'staged');
    assert.equal(result.success, true, result.message);
    assert.equal(await show('HEAD:a.txt'), 'a2 staged');
    assert.equal(await show('HEAD:b.txt'), 'b1');
    assert.equal(await status(), ' M a.txt\nM  b.txt\n');

    // The whole file: the commit has the working tree version, and the file is clean.
    await git.execGit(['add', 'a.txt']);
    write('a.txt', 'a4 whole\n');
    result = await service.commitFiles('.', ['a.txt'], 'whole file', 'whole');
    assert.equal(result.success, true, result.message);
    assert.equal(await show('HEAD:a.txt'), 'a4 whole');
    assert.equal(await status(), 'M  b.txt\n');

    // A staged rename, partly staged: the staged part keeps the rename and drops the old path.
    await git.execGit(['mv', 'old.txt', 'new.txt']);
    write('new.txt', 'moved\nlater\n');
    write('fresh.txt', 'untracked\n');
    result = await service.commitFiles('.', ['new.txt', 'fresh.txt'], 'rename', 'staged');
    assert.equal(result.success, true, result.message);
    assert.equal(await show('HEAD:new.txt'), 'moved');
    assert.equal(await show('HEAD:fresh.txt'), 'untracked');
    await assert.rejects(show('HEAD:old.txt'));
    assert.equal(await status(), 'M  b.txt\n M new.txt\n');

    // Another Git process holds the real index once the commit exists (here a hook takes the lock):
    // the commit is reported as created, with what is left to do, not as a failure to retry.
    writeFileSync(hook, '#!/bin/sh\ntouch .git/index.lock\n', { mode: 0o755 });
    write('fresh.txt', 'locked\n');
    const beforeLock = await git.execGit(['rev-parse', 'HEAD']);
    result = await service.commitFiles('.', ['fresh.txt'], 'while locked');
    rmSync(hook);
    rmSync(path.join(root, '.git', 'index.lock'));
    assert.equal(result.success, true, result.message);
    assert.notEqual(await git.execGit(['rev-parse', 'HEAD']), beforeLock);
    assert.match(result.message, /^Created commit [0-9a-f]+, but the staged files could not be updated/);
    await git.execGit(['reset', '-q', '--', 'fresh.txt']);

    // A paused merge: committing only some of its files would record an incomplete merge, so it is refused.
    await git.execGit(['checkout', '-q', '-b', 'side']);
    write('a.txt', 'side\n');
    write('fresh.txt', 'side\n');
    await git.execGit(['commit', '-qam', 'side']);
    await git.execGit(['checkout', '-q', 'main']);
    await git.execGit(['merge', '-q', '--no-ff', '--no-commit', 'side']);
    const merging = await git.execGit(['rev-parse', 'HEAD']);
    result = await service.commitFiles('.', ['a.txt'], 'part of a merge', 'whole');
    assert.equal(result.success, false);
    assert.match(result.message, /A merge is in progress/);
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), merging);
    await git.execGit(['rev-parse', '--verify', 'MERGE_HEAD']);
    await git.execGit(['merge', '--abort']);

    // Push: a branch's own remote is used; a detached HEAD gets a clear message instead of a git error.
    const remote = mkdtempSync(path.join(tmpdir(), 'repository-manager-commit-remote-'));
    try {
      await git.execGit(['init', '-q', '--bare', remote]);
      await git.execGit(['remote', 'add', 'upstream', remote], root);
      await git.execGit(['config', 'branch.main.remote', 'upstream'], root);
      const branches = new BranchService(git);
      const pushed = await branches.pushChanges('.');
      assert.equal(pushed.success, true, pushed.message);
      assert.equal(await git.execGit(['rev-parse', 'main'], remote), await git.execGit(['rev-parse', 'HEAD'], root));
      await git.execGit(['checkout', '-q', '--detach'], root);
      const detached = await branches.pushChanges('.');
      assert.equal(detached.success, false);
      assert.match(detached.message, /HEAD is detached\. Check out a branch to push/);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testLocalChangesSnapshot(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-snapshot-'));
  const git = new GitCommandService(root);
  const write = (file: string, content: string) => writeFileSync(path.join(root, file), content);
  try {
    await git.execGit(['init', '-q', '-b', 'main']);
    await git.execGit(['config', 'user.name', 'Snapshot Test']);
    await git.execGit(['config', 'user.email', 'snapshot@example.com']);
    write('a.txt', 'a\n');
    await assert.rejects(snapshotLocalChanges(git, root), /no commit yet/);
    write('.gitignore', 'secret.env\n');
    write('gone.txt', 'gone\n');
    await git.execGit(['add', '-A']);
    await git.execGit(['commit', '-qm', 'base']);
    assert.equal(await snapshotLocalChanges(git, root), undefined, 'a clean tree has nothing to review');

    // Staged, then changed again; a new file; a deleted file; an ignored file.
    write('a.txt', 'staged\n');
    await git.execGit(['add', 'a.txt']);
    write('a.txt', 'staged\nunstaged\n');
    write('new.txt', 'new\n');
    rmSync(path.join(root, 'gone.txt'));
    write('secret.env', 'TOKEN=x\n');
    const head = await git.execGit(['rev-parse', 'HEAD']);
    const status = await git.execGitRaw(['status', '--porcelain=v1']);
    const index = await git.execGitRaw(['ls-files', '-s']);
    const snapshot = await snapshotLocalChanges(git, root);
    assert.ok(snapshot);
    assert.equal(snapshot.headSha, head);
    assert.equal(await git.execGit(['show', `${snapshot.snapshotSha}:a.txt`]), 'staged\nunstaged', 'staged + unstaged');
    assert.equal(await git.execGit(['show', `${snapshot.snapshotSha}:new.txt`]), 'new');
    await assert.rejects(git.execGit(['show', `${snapshot.snapshotSha}:gone.txt`]));
    await assert.rejects(git.execGit(['show', `${snapshot.snapshotSha}:secret.env`]), /does not exist|exists on disk/, 'an ignored file was snapshotted');
    assert.equal(await git.execGit(['rev-parse', `${snapshot.snapshotSha}^`]), head);
    // HEAD, the branch, the index and the working tree are untouched; no ref points to the snapshot.
    assert.equal(await git.execGit(['rev-parse', 'HEAD']), head);
    assert.equal(await git.execGitRaw(['status', '--porcelain=v1']), status);
    assert.equal(await git.execGitRaw(['ls-files', '-s']), index);
    assert.equal(await git.execGit(['for-each-ref', '--contains', snapshot.snapshotSha]), '');
    // Same changes, same snapshot.
    assert.equal((await snapshotLocalChanges(git, root))?.snapshotSha, snapshot.snapshotSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testCommitMessageInputs(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-message-'));
  const git = new GitCommandService(root);
  const write = (file: string, content: string) => writeFileSync(path.join(root, file), content);
  try {
    // No convention anywhere: Conventional Commits.
    assert.deepEqual(findCommitConvention(root), { sources: [], text: DEFAULT_CONVENTION });
    // Only the parts of AGENTS.md about commits, with their headings.
    write('AGENTS.md', '# Agents\n\nBe nice.\n\n## Style\n\nUse tabs.\n\n## Branches and Commits\n\n- Use gitmoji in every commit subject.\n- Sign nothing.\n');
    const fromAgents = findCommitConvention(root);
    assert.deepEqual(fromAgents.sources, ['AGENTS.md']);
    assert.match(fromAgents.text, /## Branches and Commits\n- Use gitmoji in every commit subject\.\n- Sign nothing\./);
    assert.doesNotMatch(fromAgents.text, /Use tabs|Be nice/);
    // A commitlint config is passed as it is, alongside.
    write('.commitlintrc.json', '{ "extends": ["@commitlint/config-conventional"] }\n');
    assert.deepEqual(findCommitConvention(root).sources, ['AGENTS.md', '.commitlintrc.json']);
    assert.equal(commitSections('# Readme\n\nNothing here.\n'), '');
    // A commit section keeps its subsections (the format and examples), not the next sibling section.
    assert.equal(commitSections('## Commit messages\n\nRead this.\n\n### Format\n\n`type: subject`\n\n### Examples\n\nfix: x\n\n## Testing\n\nRun npm test.\n'),
      '## Commit messages\nRead this.\n### Format\n`type: subject`\n### Examples\nfix: x');
    // A convention file that is a symlink out of the repository is never read.
    const outside = mkdtempSync(path.join(tmpdir(), 'repository-manager-outside-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'TOKEN=abc\n');
    rmSync(path.join(root, '.commitlintrc.json'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'commitlint.config.js'));
    assert.deepEqual(findCommitConvention(root).sources, ['AGENTS.md']);
    assert.doesNotMatch(findCommitConvention(root).text, /TOKEN/);
    rmSync(path.join(root, 'commitlint.config.js'));
    rmSync(outside, { recursive: true, force: true });
    write('.commitlintrc.json', '{ "extends": ["@commitlint/config-conventional"] }\n');

    // The model's reply becomes a plain message: no fence, no attribution lines.
    assert.equal(cleanCommitMessage('```\nfeat: add x\n\nWhy it matters.\nCo-authored-by: Bot <b@x>\n```'), 'feat: add x\n\nWhy it matters.');
    assert.equal(cleanCommitMessage('"fix: quote"'), 'fix: quote');
    assert.equal(cleanCommitMessage('  \n '), '');
    // One shape whatever the model sends: summary, blank line, why, bullets; wrapped at 72.
    const sprawling = [
      '**Subject:** feat(cart): keep the basket when signing in.',
      '## Why',
      'Signing in replaced the guest basket with the saved one, so every item a shopper added before signing in was lost.',
      '## Changes',
      '* Merge the guest basket into the saved basket on sign-in, keeping the larger quantity when both hold the same item',
      '* Drop the guest basket once merged',
      '',
      'Refs: #42',
      'Reviewed-by: Someone <someone@example.org>'
    ].join('\n');
    assert.equal(cleanCommitMessage(sprawling), [
      'feat(cart): keep the basket when signing in',
      '',
      'Signing in replaced the guest basket with the saved one, so every item a',
      'shopper added before signing in was lost.',
      '',
      '- Merge the guest basket into the saved basket on sign-in, keeping the',
      '  larger quantity when both hold the same item',
      '- Drop the guest basket once merged',
      '',
      'Refs: #42',
      'Reviewed-by: Someone <someone@example.org>'
    ].join('\n'));
    for (const line of cleanCommitMessage(sprawling).split('\n')) { assert.ok(line.length <= COMMIT_BODY_WIDTH, `too long: ${line}`); }
    // A missing blank line after the summary is added; hard-wrapped lines are joined before wrapping again;
    // numbered and + lists become "- " bullets; one list stays together.
    assert.equal(cleanCommitMessage('fix: stop the crash\nThe parser read past\nthe end.\n1. Check the length\n+ Add a test'),
      'fix: stop the crash\n\nThe parser read past the end.\n\n- Check the length\n- Add a test');
    // A subject alone stays alone; an ellipsis is not a trailing period.
    assert.equal(cleanCommitMessage('chore: bump deps'), 'chore: bump deps');
    assert.equal(cleanCommitMessage('wip: try this...'), 'wip: try this...');
    // A prose line that looks like "Key: value" is wrapped as prose, not kept as a trailer.
    const why = `fix: keep sessions\n\nNote: ${'the session expired too early because the clock was read twice. '.repeat(2).trim()}`;
    assert.ok(cleanCommitMessage(why).split('\n').every(line => line.length <= COMMIT_BODY_WIDTH), 'a Note: paragraph was not wrapped');
    // A label alone on the first line is dropped; the line after it is the summary.
    assert.equal(cleanCommitMessage('**Commit Message:**\nfeat: add x\n\nWhy it matters.'), 'feat: add x\n\nWhy it matters.');
    assert.equal(cleanCommitMessage('Subject:\n\nfix: y'), 'fix: y');
    // Dunder names and **kwargs keep their marks, in code spans or not; only bold that hugs its text goes.
    assert.equal(cleanCommitMessage('fix: call __init__ once\n\nPass **kwargs and `**opts` to `__enter__`, **always**.'),
      'fix: call __init__ once\n\nPass **kwargs and `**opts` to `__enter__`, always.');
    // A trailer continued on an indented line stays one trailer, and the next trailer stays its own line.
    assert.equal(cleanCommitMessage('fix: z\n\nWhy.\n\nReviewed-by: A Long Name\n  <a@example.org>\nRefs: #42'),
      'fix: z\n\nWhy.\n\nReviewed-by: A Long Name\n  <a@example.org>\nRefs: #42');
    // A BREAKING CHANGE footer and indented code are kept as written; a word longer than a line is not split.
    const url = `https://example.org/${'x'.repeat(80)}`;
    assert.equal(cleanCommitMessage(`feat!: drop v1\n\nOld clients break. See ${url} for the plan.\n\n    npm run migrate\n\nBREAKING CHANGE: the v1 endpoints are gone`),
      `feat!: drop v1\n\nOld clients break. See\n${url}\nfor the plan.\n\n    npm run migrate\n\nBREAKING CHANGE: the v1 endpoints are gone`);

    // The diff is what the commit would record: the staged part when that is the choice.
    await git.execGit(['init', '-q', '-b', 'main']);
    await git.execGit(['config', 'user.name', 'Message Test']);
    await git.execGit(['config', 'user.email', 'message@example.com']);
    write('a.txt', 'one\n');
    await git.execGit(['add', 'a.txt']);
    await git.execGit(['commit', '-qm', 'base']);
    write('a.txt', 'staged line\n');
    await git.execGit(['add', 'a.txt']);
    write('a.txt', 'staged line\nlater line\n');
    write('new.txt', 'brand new\n');
    const whole = await collectCommitDiff(git, '.', ['a.txt', 'new.txt'], 'whole');
    assert.deepEqual(whole.files, ['a.txt', 'new.txt']);
    assert.match(whole.diff, /\+later line/);
    assert.match(whole.diff, /\+brand new/);
    const stagedPart = await collectCommitDiff(git, '.', ['a.txt'], 'staged');
    assert.match(stagedPart.diff, /\+staged line/);
    assert.doesNotMatch(stagedPart.diff, /later line/);
    // A file that does not fit is named, not cut; the limit is in bytes (é is two).
    write('big.txt', 'é'.repeat(Math.ceil(MAX_COMMIT_DIFF_BYTES * 0.6)) + '\n');
    assert.ok('é'.repeat(Math.ceil(MAX_COMMIT_DIFF_BYTES * 0.6)).length < MAX_COMMIT_DIFF_BYTES);
    const big = await collectCommitDiff(git, '.', ['a.txt', 'big.txt', 'missing.txt'], 'whole');
    assert.deepEqual([big.files, big.omitted, big.tooLarge], [['a.txt'], ['big.txt', 'missing.txt'], ['big.txt']]);
    assert.ok(Buffer.byteLength(big.diff, 'utf8') <= MAX_COMMIT_DIFF_BYTES);
    // An untracked nested repository is described as the gitlink the commit adds.
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    const nestedGit = new GitCommandService(nested);
    await nestedGit.execGit(['init', '-q']);
    await nestedGit.execGit(['-c', 'user.name=N', '-c', 'user.email=n@x', 'commit', '-q', '--allow-empty', '-m', 'n']);
    const nestedDiff = await collectCommitDiff(git, '.', ['nested/'], 'whole');
    assert.deepEqual(nestedDiff.files, ['nested/']);
    assert.match(nestedDiff.diff, /\+Subproject commit [0-9a-f]{40}/);
    rmSync(nested, { recursive: true, force: true });
    // Cancelled: no file is read.
    assert.deepEqual((await collectCommitDiff(git, '.', ['a.txt'], 'whole', () => true)).files, []);
    const prompt = buildCommitMessagePrompt(fromAgents, big);
    assert.match(prompt, /Follow this repository's commit convention, taken from AGENTS\.md/);
    assert.match(prompt, /their diff is not shown: big\.txt, missing\.txt/);
    assert.match(prompt, /Do not add co-author/);
    // The prompt asks for the shape the reply is formatted into, with an example of it.
    assert.match(prompt, /one "- " bullet per change/);
    assert.match(prompt, /Example of the shape \(not of the content\):\nfeat\(cart\)/);
    assert.match(buildCommitMessagePrompt({ sources: [], text: DEFAULT_CONVENTION }, whole), /states no commit convention\. Use:\n\nConventional Commits 1\.0\.0/);
    // Before the first commit, the staged part is what the index holds, not the working tree.
    const fresh = mkdtempSync(path.join(tmpdir(), 'repository-manager-message-fresh-'));
    const freshGit = new GitCommandService(fresh);
    await freshGit.execGit(['init', '-q']);
    writeFileSync(path.join(fresh, 'f.txt'), 'staged\n');
    await freshGit.execGit(['add', 'f.txt']);
    writeFileSync(path.join(fresh, 'f.txt'), 'staged\nlater\n');
    const freshStaged = await collectCommitDiff(freshGit, '.', ['f.txt'], 'staged');
    assert.match(freshStaged.diff, /\+staged/);
    assert.doesNotMatch(freshStaged.diff, /later/);
    assert.match((await collectCommitDiff(freshGit, '.', ['f.txt'], 'whole')).diff, /\+later/);
    rmSync(fresh, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testWorkingTreePreview(): Promise<void> {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), 'repository-manager-preview-'));
  const git = new GitCommandService(repositoryRoot);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'Preview Test']);
    await git.execGit(['config', 'user.email', 'preview@example.com']);
    writeFileSync(path.join(repositoryRoot, 'example file.txt'), 'original\n');
    await git.execGit(['add', '--', 'example file.txt']);
    await git.execGit(['commit', '-m', 'initial']);

    writeFileSync(path.join(repositoryRoot, 'example file.txt'), 'staged change\n');
    await git.execGit(['add', '--', 'example file.txt']);
    writeFileSync(path.join(repositoryRoot, 'example file.txt'), 'unstaged change\n');
    writeFileSync(path.join(repositoryRoot, 'new file.txt'), 'untracked content\n');

    const service = new CommitService(git);
    const staged = await service.getWorkingTreePreview('.', 'example file.txt', 'staged', 1);
    assert.equal(staged.mode, 'staged');
    assert.equal(staged.requestId, 1);
    assert.match(staged.patch, /\+staged change/);
    assert.doesNotMatch(staged.patch, /unstaged change/);

    const unstaged = await service.getWorkingTreePreview('.', 'example file.txt', 'unstaged', 2);
    assert.match(unstaged.patch, /\+unstaged change/);
    assert.match(unstaged.patch, /-staged change/);

    const untracked = await service.getWorkingTreePreview('.', 'new file.txt', 'unstaged', 3);
    assert.match(untracked.patch, /\+untracked content/);

    const nestedRoot = path.join(repositoryRoot, 'nested');
    mkdirSync(nestedRoot);
    const nestedGit = new GitCommandService(nestedRoot);
    await nestedGit.execGit(['init', '-q']);
    await nestedGit.execGit(['config', 'user.name', 'Nested Preview Test']);
    await nestedGit.execGit(['config', 'user.email', 'nested@example.com']);
    writeFileSync(path.join(nestedRoot, 'inner.txt'), 'committed content\n');
    await nestedGit.execGit(['add', '--', 'inner.txt']);
    await nestedGit.execGit(['commit', '-m', 'nested initial']);
    const nestedHead = await nestedGit.execGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(nestedRoot, 'inner.txt'), 'uncommitted nested change\n');

    const nestedStatus = await service.getWorkingTreeChanges('.');
    assert.ok(nestedStatus.some(change => change.path === 'nested/' && change.untracked));
    const nested = await service.getWorkingTreePreview('.', 'nested/', 'unstaged', 6);
    assert.match(nested.patch, new RegExp('Subproject commit ' + nestedHead));
    assert.match(nested.patch, /Only the HEAD commit is included/);
    assert.doesNotMatch(nested.patch, /uncommitted nested change/);
    assert.notEqual(nested.patch, '');
    await assert.rejects(service.getWorkingTreePreview('.', 'nested/', 'staged', 7));
    await assert.rejects(service.getWorkingTreePreview('.', 'new file.txt', 'staged', 4));
    await assert.rejects(service.getWorkingTreePreview('.', '../outside', 'unstaged', 5));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
}

async function testChangeSummaryContext(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-summary-'));
  const git = new GitCommandService(root);
  try {
    await git.execGit(['init', '-q']);
    await git.execGit(['config', 'user.name', 'Summary Test']);
    await git.execGit(['config', 'user.email', 'summary@example.com']);
    writeFileSync(path.join(root, 'old.txt'), 'first\nsecond\nthird\nfourth\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-m', 'root']);
    const first = await git.execGit(['rev-parse', 'HEAD']);
    const service = new ChangeContextService(git);
    const initial = await service.collect('.', first);
    assert.equal(initial.baseSha, EMPTY_TREE);
    assert.equal(initial.root, true);
    assert.deepEqual(initial.files.map(file => file.path), ['old.txt']);
    assert.match(initial.patches[0].patch, /\+first/);

    await git.execGit(['mv', 'old.txt', 'new.txt']);
    writeFileSync(path.join(root, 'new.txt'), 'first\nsecond\nthird\nfourth\nfifth\n');
    await git.execGit(['add', '.']);
    await git.execGit(['commit', '-m', 'rename and edit']);
    const second = await git.execGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(root, 'new.txt'), 'uncommitted secret\n');
    const packet = await service.collect('.', second, first);
    assert.equal(packet.baseSha, first);
    assert.equal(packet.targetSha, second);
    assert.deepEqual(packet.files, [{ oldPath: 'old.txt', path: 'new.txt', status: 'renamed' }]);
    assert.doesNotMatch(JSON.stringify(packet), /uncommitted secret/);
    const reply = {
      schemaVersion: 1, baseSha: first, targetSha: second,
      intent: { text: 'Rename', evidence: ['new.txt'] },
      behaviorChanges: [], affectedAreas: [], dependencyConfigChanges: [],
      possibleBreakingChanges: [], riskHints: [], suggestedTests: [], limitations: []
    };
    assert.equal(validateSummary(JSON.stringify(reply), packet).intent.text, 'Rename');
    assert.throws(() => validateSummary(JSON.stringify({ ...reply, targetSha: first }), packet));
    const partial = validateSummary(JSON.stringify({ ...reply,
      intent: { text: 'Wrong', evidence: ['outside.txt'] },
      behaviorChanges: [{ text: 'New path', evidence: ['b/new.txt:3'] },
        { text: 'Unsupported', evidence: ['missing.txt'] }]
    }), packet);
    assert.match(partial.intent.text, /AI intent could not be verified/);
    assert.deepEqual(partial.behaviorChanges, [{ text: 'New path', evidence: ['new.txt'] }]);
    assert.equal(partial.limitations.length, 1);
    const shortCommit = validateSummary(JSON.stringify({ ...reply,
      intent: { text: 'Rename', evidence: [second.slice(0, 10)] }
    }), packet);
    assert.deepEqual(shortCommit.intent.evidence, [second]);
    writeFileSync(path.join(root, 'large.txt'), Array.from({ length: 1000 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n'));
    await git.execGit(['add', 'large.txt']);
    await git.execGit(['commit', '-m', 'large file']);
    const large = await service.collect('.', 'HEAD', second);
    assert.ok(large.patches.some(item => item.path === 'large.txt'));
    assert.ok(!large.coverage.omitted.some(item => item.startsWith('large.txt: patch exceeds budget')));
    const batches = buildSummaryBatches(large);
    assert.ok(batches.length > 1);
    assert.equal(batches.flatMap(batch => batch.patches).map(part => part.patch).join(''), large.patches[0].patch);
    assert.ok(batches.every(batch => batch.patches.reduce((size, part) => size + Buffer.byteLength(part.patch), 0) <= SUMMARY_BATCH_BYTES));
    const validated = batches.map(batch => validateSummary(JSON.stringify({ ...reply,
      baseSha: large.baseSha, targetSha: large.targetSha,
      intent: { text: 'Add large file', evidence: ['large.txt'] }
    }), batch));
    const combined = combineBatchSummaries(large, validated);
    assert.deepEqual(combined.intent.evidence, ['large.txt']);
    assert.equal(combined.coverage.includedFiles, 1);
    const unsupported = validateSummary(JSON.stringify({ ...reply,
      baseSha: large.baseSha, targetSha: large.targetSha,
      intent: { text: 'Claim another file', evidence: ['new.txt'] }
    }), batches[0]);
    assert.match(unsupported.intent.text, /AI intent could not be verified/);
    const multibyte = 'a😀\n'.repeat(60);
    const pieces = splitPatch(multibyte, 9);
    assert.equal(pieces.join(''), multibyte);
    assert.ok(pieces.every(piece => Buffer.byteLength(piece) <= 9));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  testParsers();
  testPathBoundary();
  testHistoryGraph();
  testDashboardToolbarHierarchy();
  await testWorkingTreePreview();
  await testCommitMessageInputs();
  await testCommitSelectedFiles();
  testCountChanges();
  await testLocalChangesSnapshot();
  await testChangeSummaryContext();
  await testRepositoryIntegration();
  await testBranchFromHistoryCommit();
  await testAnnotatedTagFromHistoryCommit();
  await testHistoryApplyActions();
  await testHistoryApplyConflict();
  await testHistoryRewrite();
  await testHistoryRewriteConflict();
  await testHistoryRewriteSha256();
  console.log('Repository Manager backend tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
