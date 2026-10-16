const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitCommandService, SupersededError } = require('../../out/services/gitCommandService.js');
const { HistoryService } = require('../../out/services/historyService.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'history-search-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    // 2600 commits through fast-import: the oldest ones lie beyond the 2000 a search used to read.
    let stream = '';
    for (let i = 0; i < 2600; i++) {
      const message = i === 3 ? 'feat: Needle in an old commit' : `fix: change ${i}`;
      stream += `commit refs/heads/main\nauthor ${i === 7 ? 'Old Author' : 'Dev'} <dev${i}@example.org> ${1600000000 + i * 60} +0000\n` +
        `committer Dev <dev@example.org> ${1600000000 + i * 60} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n` +
        `M 644 inline file.txt\ndata ${String(i).length + 1}\n${i}\n\n`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, env, input: stream });
    git('checkout', '-q', 'main');
    git('tag', 'release-old', 'HEAD~2590');
    const history = new HistoryService(new GitCommandService(repo));
    const search = (text, extra = {}) => history.getHistory({ repositoryPath: '.', limit: 100, search: text, ...extra });

    // Old commits are found: by subject (any case), by author, by a ref name and by hash.
    assert.deepEqual((await search('needle')).commits.map(commit => commit.subject), ['feat: Needle in an old commit']);
    assert.equal((await search('old author')).commits.length, 1);
    const tagged = git('rev-parse', 'release-old');
    assert.deepEqual((await search('release-old')).commits.map(commit => commit.hash), [tagged]);
    assert.deepEqual((await search(tagged.slice(0, 10))).commits.map(commit => commit.hash), [tagged]);
    assert.deepEqual((await search('no such text')).commits, []);
    // Pages: 'change 1' matches far more than a page; the next page continues where the first ended.
    const first = await search('change 1');
    assert.equal(first.commits.length, 100);
    assert.equal(first.nextOffset, 100);
    const second = await search('change 1', { offset: 100 });
    assert.equal(second.commits.length, 100);
    assert.equal(new Set([...first.commits, ...second.commits].map(commit => commit.hash)).size, 200, 'the pages overlap');
    // Without a search, history still pages in topological order.
    const plain = await history.getHistory({ repositoryPath: '.', limit: 50 });
    assert.equal(plain.commits.length, 50);
    assert.equal(plain.commits[0].subject, 'fix: change 2599');
    // A subject containing the record separator does not break the search (or the extension host).
    const entry = (message, time, from) => `commit refs/heads/odd\nauthor Dev <d@x.org> ${time} +0000\ncommitter Dev <d@x.org> ${time} +0000\n` +
      `data ${Buffer.byteLength(message)}\n${message}\n${from ? `from ${from}\n` : ''}\n`;
    const stream2 = entry('parent findable', 1700000000, 'refs/heads/main') +
      // A child committed with an older date than its parent: Git's default order would list the parent first.
      entry('child findable', 1500000000) + entry('odd \x1e subject findable', 1400000000);
    execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, env, input: stream2 });
    // Topological order, as the graph needs: the child before its parent. The subject holding the
    // record separator is skipped; it does not break the search (or the extension host).
    assert.deepEqual((await search('findable', { includeRemotes: true })).commits.map(commit => commit.subject),
      ['child findable', 'parent findable']);
    // A newer request stops a search still scanning: Git is stopped and the old request ends as superseded.
    const service = new GitCommandService(repo);
    const controller = new AbortController();
    const slow = service.scanGitRecords(['log', '--format=%H%x1e'], repo, '\x1e', () => false, 30000, controller.signal);
    controller.abort();
    await assert.rejects(slow, error => error instanceof SupersededError);
    const ran = [];
    GitCommandService.observer = timing => ran.push(timing.args.join(' '));
    const replaced = history.getHistory({ repositoryPath: '.', limit: 100, search: 'no such commit anywhere' });
    const replacing = history.getHistory({ repositoryPath: '.', limit: 50 });
    await assert.rejects(replaced, error => error.name === 'SupersededError');
    assert.equal((await replacing).commits.length, 50);
    await new Promise(resolve => setTimeout(resolve, 300));
    GitCommandService.observer = undefined;
    // The replaced search looked up no upstream or stashes: only the page that replaced it did.
    assert.equal(ran.filter(command => command.includes('@{upstream}')).length, 1, ran.join('\n'));
    // An exception thrown while handling a record rejects the scan instead of escaping.
    await assert.rejects(service.scanGitRecords(['log', '--format=%H%x1e'], repo, '\x1e', () => { throw new Error('boom'); }), /boom/);
    console.log('History search smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
