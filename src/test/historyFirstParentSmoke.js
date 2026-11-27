// HistoryService with firstParent: the Git arguments, the merge counts, and unchanged arguments when it is off.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { HistoryService } = require('../../out/services/historyService.js');
const { SNAPSHOT_REF_PREFIX } = require('../../out/services/localChangesSnapshot.js');
const { DISCARD_REF_PREFIX } = require('../../out/services/discardService.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'history-first-parent-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
const commit = message => { git('commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };

const historyLog = args => args[0] === 'log' && args.includes('--topo-order');

// A service whose Git calls are recorded.
function recorded() {
  const gitCmd = new GitCommandService(repo);
  const calls = [];
  const raw = gitCmd.execGitRaw.bind(gitCmd);
  gitCmd.execGitRaw = (args, ...rest) => { calls.push(args); return raw(args, ...rest); };
  return { history: new HistoryService(gitCmd), calls };
}

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    commit('base');
    git('checkout', '-q', '-b', 'topic');
    commit('topic 1'); commit('topic 2'); commit('topic 3');
    git('checkout', '-q', 'main');
    commit('main work');
    git('merge', '-q', '--no-ff', '-m', 'Merge topic', 'topic');
    const mergeHash = git('rev-parse', 'HEAD');

    // Off: the arguments are what they were before the option existed, and no merge is counted.
    {
      const { history, calls } = recorded();
      const page = await history.getHistory({ repositoryPath: '.', includeRemotes: true });
      const log = calls.find(historyLog);
      assert.deepEqual(log.slice(0, 5), ['log', '--max-count=101', '--topo-order', '--date=iso-strict', '--decorate=full']);
      assert.match(log[5], /^--format=/);
      assert.deepEqual(log.slice(6), [`--exclude=${SNAPSHOT_REF_PREFIX}*`, `--exclude=${DISCARD_REF_PREFIX}*`, '--all']);
      assert.ok(page.commits.every(item => item.mergeCount === undefined), 'a merge was counted with the option off');
      assert.ok(calls.every(args => args[0] !== 'rev-list'), 'rev-list ran with the option off');
      assert.equal(page.commits.length, 6, 'the whole graph is listed');
      // Also off when the field is false.
      const explicit = recorded();
      await explicit.history.getHistory({ repositoryPath: '.', includeRemotes: true, firstParent: false });
      assert.deepEqual(explicit.calls.find(historyLog), log);
    }

    // On: --first-parent is passed, the topic commits are not listed, and the merge says it brought in 3.
    {
      const { history, calls } = recorded();
      const page = await history.getHistory({ repositoryPath: '.', firstParent: true });
      const log = calls.find(historyLog);
      assert.ok(log.includes('--first-parent'), 'no --first-parent');
      assert.deepEqual(page.commits.map(item => item.subject), ['Merge topic', 'main work', 'base']);
      const merge = page.commits[0];
      assert.equal(merge.hash, mergeHash);
      assert.equal(merge.mergeCount, 3, 'the merge of 3 commits has another count');
      assert.equal(page.commits[1].mergeCount, undefined);
      assert.deepEqual(calls.filter(args => args[0] === 'rev-list').map(args => args.join(' ')),
        [`rev-list --count ${mergeHash}^1..${mergeHash}^2`]);
      // A search takes the option too.
      const found = await history.getHistory({ repositoryPath: '.', firstParent: true, search: 'merge' });
      assert.deepEqual(found.commits.map(item => item.subject), ['Merge topic']);
      assert.equal(found.commits[0].mergeCount, 3);
    }

    // At most 50 merges per page are counted; the rest show no number.
    {
      const tree = git('rev-parse', 'HEAD^{tree}');
      const side = git('rev-parse', 'topic');
      let tip = git('rev-parse', 'HEAD');
      for (let index = 0; index < 55; index += 1) {
        tip = git('commit-tree', tree, '-p', tip, '-p', side, '-m', `merge ${index}`);
      }
      git('update-ref', 'refs/heads/main', tip);
      const { history, calls } = recorded();
      const page = await history.getHistory({ repositoryPath: '.', firstParent: true, limit: 60 });
      assert.equal(calls.filter(args => args[0] === 'rev-list').length, 50, 'more than 50 merges were counted');
      const merges = page.commits.filter(item => item.parentHashes.length > 1);
      assert.equal(merges.length, 56);
      assert.equal(merges.filter(item => item.mergeCount !== undefined).length, 50);
      assert.equal(merges[0].mergeCount, 0, 'a count of 0 is still a count');
      assert.equal(merges[merges.length - 1].mergeCount, undefined, 'a merge past the limit has a count');
    }
    console.log('History first-parent smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
