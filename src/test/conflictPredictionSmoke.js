// Conflict prediction is checked against Git itself: each scenario is predicted first, then run for
// real, and the prediction must name the same conflicted files (or none) as the real operation.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
// Prediction must work for a user with no Git identity set (as on a CI runner): the service runs Git
// with this process's environment, so it gets none here.
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { ConflictPredictionService, parseMergeTree } = require('../../out/services/conflictPredictionService.js');

const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-predict-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true' };
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitMayFail = (...args) => { try { git(...args); return true; } catch { return false; } };
const write = (file, text) => writeFileSync(path.join(root, file), text);
const commit = (file, text, message) => { write(file, text); git('add', file); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
const unmerged = () => [...new Set(git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean))];
const state = () => [git('status', '--porcelain'), git('for-each-ref', '--format=%(refname) %(objectname)'), git('rev-parse', 'HEAD')];

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    commit('fee.py', 'def fee(a):\n    return a * 0.02\n', 'base');
    commit('other.txt', 'one\n', 'other');
    git('checkout', '-qb', 'feature');
    const a = commit('notes.txt', 'notes\n', 'A: notes');
    const b = commit('fee.py', 'def fee(a):\n    return round(a * 0.02, 2)\n', 'B: round the fee');
    commit('new.txt', 'new\n', 'C: new file');
    git('checkout', '-q', 'main');
    const m = commit('fee.py', 'def fee(a):\n    return max(a * 0.02, 1.0)\n', 'M: minimum fee');
    git('checkout', '-q', 'feature');
    const tip = git('rev-parse', 'HEAD');
    const service = new ConflictPredictionService(new GitCommandService(root));

    const check = async (name, operation, target, run, expected) => {
      const before = state();
      const prediction = await service.predict('.', operation, target);
      assert.deepEqual(state(), before, `${name}: predicting changed the repository`);
      assert.equal(prediction.supported, true, `${name}: ${prediction.reason}`);
      const predicted = prediction.conflicts.flatMap(conflict => conflict.paths);
      const ok = run();
      const actual = ok ? [] : unmerged();
      assert.deepEqual(predicted, actual, `${name}: predicted ${JSON.stringify(predicted)}, Git stopped on ${JSON.stringify(actual)}`);
      assert.deepEqual(predicted, expected, `${name}: the scenario itself changed`);
      // Back to the tip for the next scenario.
      for (const op of ['rebase', 'cherry-pick', 'revert', 'merge']) gitMayFail(op, '--abort');
      git('reset', '-q', '--hard', tip);
      return prediction;
    };

    // Rebase stops at B, the second of three commits: later ones are not predicted.
    const rebase = await check('rebase', 'rebase', 'main', () => gitMayFail('rebase', '-q', 'main'), ['fee.py']);
    assert.deepEqual([rebase.conflicts[0].commit, rebase.conflicts[0].subject], [b, 'B: round the fee']);
    assert.deepEqual([rebase.replayed, rebase.steps, rebase.stoppedEarly], [1, 3, true]);
    await check('cherry-pick', 'cherry-pick', m, () => gitMayFail('cherry-pick', m), ['fee.py']);
    await check('merge', 'merge', 'main', () => gitMayFail('merge', '--no-edit', 'main'), ['fee.py']);
    await check('revert clean', 'revert', a, () => gitMayFail('revert', '--no-edit', a), []);
    const drop = await check('drop clean', 'drop', a, () => gitMayFail('rebase', '-q', '--onto', `${a}^`, a), []);
    assert.deepEqual([drop.replayed, drop.steps, drop.stoppedEarly], [2, 2, false]);
    // Reverting B with only C after it is clean: C does not touch fee.py.
    await check('revert older', 'revert', b, () => gitMayFail('revert', '--no-edit', b), []);
    // A real revert conflict: fee.py changed again after B.
    const d = commit('fee.py', 'def fee(a):\n    return round(a * 0.03, 2)\n', 'D: raise the fee');
    const before = state();
    const revert = await service.predict('.', 'revert', b);
    assert.deepEqual(state(), before);
    assert.deepEqual(revert.conflicts.flatMap(conflict => conflict.paths), ['fee.py']);
    assert.equal(gitMayFail('revert', '--no-edit', b), false, 'Git reverted B cleanly; the scenario is wrong');
    assert.deepEqual(unmerged(), ['fee.py']);
    git('revert', '--abort');
    git('reset', '-q', '--hard', d);

    // A root commit cannot be picked or reverted this way: said, not guessed.
    const rootCommit = git('rev-list', '--max-parents=0', 'HEAD');
    const unsupported = await service.predict('.', 'revert', rootCommit);
    assert.deepEqual([unsupported.supported, unsupported.conflicts], [false, []]);
    assert.match(unsupported.reason, /root commit/);
    // The exit code decides, not the list: Git says some conflicts (a directory rename) list no file.
    const noFile = parseMergeTree(['tree1', '', '2', 'new/c.txt', 'old/c.txt', 'CONFLICT (file location)', 'moved', ''].join('\0'), true);
    assert.deepEqual([noFile.conflicted, noFile.paths, noFile.kinds['old/c.txt']], [true, ['new/c.txt', 'old/c.txt'], ['file location']]);
    assert.deepEqual(parseMergeTree(['tree2', '', ''].join('\0'), true), { tree: 'tree2', conflicted: true, paths: [], kinds: {} });
    assert.equal(parseMergeTree(['tree3', '', '1', 'a.txt', 'Auto-merging', 'Auto-merging a.txt', ''].join('\0'), false).conflicted, false);
    console.log('Conflict prediction smoke passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
