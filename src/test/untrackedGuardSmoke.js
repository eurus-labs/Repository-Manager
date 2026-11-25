const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { HistoryActionService } = require('../../out/services/historyActionService.js');
const { HistoryRewriteService } = require('../../out/services/historyRewriteService.js');
const { untrackedCollisions } = require('../../out/services/untrackedGuard.js');

// Ignore the developer's global Git config, for this process and the git it spawns.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Guard Test', GIT_AUTHOR_EMAIL: 'guard@example.com',
  GIT_COMMITTER_NAME: 'Guard Test', GIT_COMMITTER_EMAIL: 'guard@example.com'
});
const bases = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function init() {
  const dir = mkdtempSync(path.join(tmpdir(), 'repository-manager-guard-'));
  bases.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, { 'a.txt': 'a\n' }, 'base');
  return dir;
}
/** Writes files (a null content deletes the file), stages everything and commits. */
function commit(dir, files, message) {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) {
      git(dir, 'rm', '-q', name);
    } else {
      writeFileSync(path.join(dir, name), content);
      git(dir, 'add', name);
    }
  }
  git(dir, 'commit', '-qm', message, '--allow-empty');
  return git(dir, 'rev-parse', 'HEAD');
}
const head = dir => git(dir, 'rev-parse', 'HEAD');

// Each scenario builds a repository where `run()` is valid and writes `clash` (a path it would write).
const scenarios = {
  rebase: {
    action: 'rebase', clash: 'clash.txt',
    build() {
      const dir = init();
      git(dir, 'switch', '-q', '-c', 'feature');
      commit(dir, { 'f.txt': 'f\n' }, 'feature work');
      git(dir, 'switch', '-q', 'main');
      const target = commit(dir, { 'clash.txt': 'tracked\n' }, 'main moves');
      git(dir, 'switch', '-q', 'feature');
      return { dir, run: () => rewrite(dir, target, 'rebase', 'feature') };
    }
  },
  'rebase-replayed': {
    action: 'rebase', clash: 'tmp.txt',
    build() {
      const dir = init();
      git(dir, 'switch', '-q', '-c', 'feature');
      commit(dir, { 'tmp.txt': 't\n' }, 'add tmp');
      commit(dir, { 'tmp.txt': null }, 'remove tmp');
      git(dir, 'switch', '-q', 'main');
      const target = commit(dir, { 'm.txt': 'm\n' }, 'main moves');
      git(dir, 'switch', '-q', 'feature');
      return { dir, run: () => rewrite(dir, target, 'rebase', 'feature') };
    }
  },
  'drop-middle': {
    action: 'drop', clash: 'q.txt',
    build() {
      const dir = init();
      commit(dir, { 'q.txt': 'q\n' }, 'add q');
      const doomed = commit(dir, { 'q.txt': null }, 'remove q');
      commit(dir, { 'r.txt': 'r\n' }, 'add r');
      return { dir, run: () => rewrite(dir, doomed, 'drop', 'main') };
    }
  },
  'drop-head': {
    action: 'drop', clash: 'q.txt',
    build() {
      const dir = init();
      commit(dir, { 'q.txt': 'q\n' }, 'add q');
      const doomed = commit(dir, { 'q.txt': null }, 'remove q');
      return { dir, run: () => rewrite(dir, doomed, 'drop', 'main') };
    }
  },
  'reset-hard': {
    action: 'reset', clash: 'q.txt',
    build() {
      const dir = init();
      const target = commit(dir, { 'q.txt': 'q\n' }, 'add q');
      commit(dir, { 'q.txt': null }, 'remove q');
      return { dir, run: () => rewrite(dir, target, 'reset', 'main', 'hard') };
    }
  },
  merge: {
    action: 'merge', clash: 's.txt',
    build() {
      const dir = init();
      git(dir, 'switch', '-q', '-c', 'side');
      const side = commit(dir, { 's.txt': 's\n' }, 'side work');
      git(dir, 'switch', '-q', 'main');
      commit(dir, { 'm.txt': 'm\n' }, 'main work');
      return { dir, run: () => apply(dir, side, 'merge') };
    }
  },
  'cherry-pick': {
    action: 'cherry-pick', clash: 's.txt',
    build() {
      const dir = init();
      git(dir, 'switch', '-q', '-c', 'side');
      const side = commit(dir, { 's.txt': 's\n' }, 'side work');
      git(dir, 'switch', '-q', 'main');
      commit(dir, { 'm.txt': 'm\n' }, 'main work');
      return { dir, run: () => apply(dir, side, 'cherry-pick') };
    }
  },
  revert: {
    action: 'revert', clash: 'd.txt',
    build() {
      const dir = init();
      commit(dir, { 'd.txt': 'd\n' }, 'add d');
      const removal = commit(dir, { 'd.txt': null }, 'remove d');
      return { dir, run: () => apply(dir, removal, 'revert') };
    }
  }
};

const rewrite = (dir, target, action, branch, mode) =>
  new HistoryRewriteService(new GitCommandService(dir)).execute('.', target, action, branch, head(dir), mode);
const apply = (dir, commitSha, operation) =>
  new HistoryActionService(new GitCommandService(dir)).apply('.', commitSha, operation, undefined, git(dir, 'symbolic-ref', '--short', 'HEAD'));
const noPending = async dir =>
  assert.equal(await new HistoryActionService(new GitCommandService(dir)).pendingOperation('.'), undefined, 'no operation in progress');

async function main() {
  try {
    for (const [name, scenario] of Object.entries(scenarios)) {
      // An unrelated untracked file does not block, and stays as it is.
      let { dir, run } = scenario.build();
      writeFileSync(path.join(dir, 'notes.local'), 'mine\n');
      const before = head(dir);
      let result = await run();
      assert.equal(result.success, true, `${name} with an unrelated untracked file: ${result.message}`);
      assert.notEqual(head(dir), before, name);
      assert.equal(readFileSync(path.join(dir, 'notes.local'), 'utf8'), 'mine\n', name);
      await noPending(dir);

      // A file at a path the action writes refuses it before Git runs.
      ({ dir, run } = scenario.build());
      writeFileSync(path.join(dir, scenario.clash), 'mine\n');
      const clashBefore = head(dir);
      result = await run();
      assert.equal(result.success, false, `${name} with a colliding file must be refused`);
      assert.ok(result.message.includes(`These untracked files would be overwritten by ${scenario.action}: ${scenario.clash}. Move or commit them, then try again.`), `${name}: ${result.message}`);
      assert.equal(head(dir), clashBefore, name);
      assert.equal(readFileSync(path.join(dir, scenario.clash), 'utf8'), 'mine\n', name);
      assert.equal(existsSync(path.join(dir, '.git', 'rebase-merge')) || existsSync(path.join(dir, '.git', 'rebase-apply')), false, name);
      await noPending(dir);

      // A change to a tracked file still blocks, staged or not.
      for (const staged of [false, true]) {
        ({ dir, run } = scenario.build());
        writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
        if (staged) { git(dir, 'add', 'a.txt'); }
        writeFileSync(path.join(dir, 'notes.local'), 'mine\n');
        result = await run();
        assert.equal(result.success, false, `${name} with a ${staged ? 'staged' : 'unstaged'} change`);
        assert.match(result.message, /changes to tracked files/);
        assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'edited\n', name);
      }
    }

    // An untracked file inside a directory whose name the action writes as a file is also in the way:
    // reset --hard would delete the directory and the file with it.
    for (const [name, scenario] of Object.entries(scenarios)) {
      const { dir, run } = scenario.build();
      const inner = `${scenario.clash}/precious.txt`;
      mkdirSync(path.join(dir, scenario.clash), { recursive: true });
      writeFileSync(path.join(dir, inner), 'precious\n');
      const before = head(dir);
      const result = await run();
      assert.equal(result.success, false, `${name} with an untracked file below a written file`);
      assert.ok(result.message.includes(`overwritten by ${scenario.action}: ${inner}.`), `${name}: ${result.message}`);
      assert.equal(head(dir), before, name);
      assert.equal(readFileSync(path.join(dir, inner), 'utf8'), 'precious\n', name);
      assert.equal(existsSync(path.join(dir, '.git', 'rebase-merge')) || existsSync(path.join(dir, '.git', 'rebase-apply')), false, name);
      await noPending(dir);
    }

    // The ancestor is a directory in the target tree, not a file: an untracked sibling is fine.
    {
      const dir = init();
      mkdirSync(path.join(dir, 'src'));
      const target = commit(dir, { 'src/other.ts': '1\n' }, 'add other');
      commit(dir, { 'src/other.ts': '2\n' }, 'edit other');
      writeFileSync(path.join(dir, 'src', 'new.txt'), 'mine\n');
      const result = await rewrite(dir, target, 'reset', 'main', 'hard');
      assert.equal(result.success, true, result.message);
      assert.equal(readFileSync(path.join(dir, 'src', 'new.txt'), 'utf8'), 'mine\n');
    }

    // Soft and mixed resets do not touch the working tree, so a colliding file is no problem.
    for (const mode of ['soft', 'mixed']) {
      const { dir } = scenarios['reset-hard'].build();
      const target = git(dir, 'rev-parse', 'HEAD~1');
      writeFileSync(path.join(dir, 'q.txt'), 'mine\n');
      const result = await rewrite(dir, target, 'reset', 'main', mode);
      assert.equal(result.success, true, `${mode}: ${result.message}`);
      assert.equal(head(dir), target);
      assert.equal(readFileSync(path.join(dir, 'q.txt'), 'utf8'), 'mine\n');
    }

    // An ignored file at a written path is not a collision, as before.
    {
      const dir = init();
      commit(dir, { '.gitignore': 'ign.txt\n' }, 'ignore');
      writeFileSync(path.join(dir, 'ign.txt'), 'x\n');
      git(dir, 'add', '-f', 'ign.txt');
      const target = commit(dir, {}, 'force add');
      commit(dir, { 'ign.txt': null }, 'remove ign');
      writeFileSync(path.join(dir, 'ign.txt'), 'mine\n');
      assert.deepEqual(await untrackedCollisions(new GitCommandService(dir), dir, { trees: [target], ranges: [] }), []);
      const result = await rewrite(dir, target, 'reset', 'main', 'hard');
      assert.equal(result.success, true, result.message);
    }

    // 25 colliding files: 20 are listed, then the rest are counted.
    {
      const dir = init();
      const names = Array.from({ length: 25 }, (_, index) => `many/f${String(index).padStart(2, '0')}.txt`);
      mkdirSync(path.join(dir, 'many'));
      const target = commit(dir, Object.fromEntries(names.map(name => [name, 'x\n'])), 'add many');
      commit(dir, Object.fromEntries(names.map(name => [name, null])), 'remove many');
      mkdirSync(path.join(dir, 'many'), { recursive: true });
      names.forEach(name => writeFileSync(path.join(dir, name), 'mine\n'));
      const result = await rewrite(dir, target, 'reset', 'main', 'hard');
      assert.equal(result.success, false);
      assert.ok(result.message.includes(`${names[19]}, and 5 more.`), result.message);
      assert.ok(!result.message.includes(names[20]), 'only 20 are listed');
    }
    console.log('Untracked guard smoke passed');
  } finally {
    for (const base of bases) { rmSync(base, { recursive: true, force: true }); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
