const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Changed files in VS Code's diff editor: the committed side's documents, and what each kind of
// change opens (a real repository, a fake vscode that records the commands).
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Docs Test', GIT_AUTHOR_EMAIL: 'docs@example.com',
  GIT_COMMITTER_NAME: 'Docs Test', GIT_COMMITTER_EMAIL: 'docs@example.com'
});
const executed = [];
const fakeVscode = {
  Uri: { file: fsPath => ({ scheme: 'file', fsPath }), from: parts => ({ ...parts }) },
  commands: { executeCommand: async (...args) => { executed.push(args); } }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { ChangeDocumentProvider, changeDocumentUri, isInWorkspace, openWorkingChange, openCommitChange } = require('../../out/changeDocuments.js');
Module._load = originalLoad;

const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-docs-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function main() {
  try {
    const root = path.join(base, 'repo');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(root, 'a.txt'), 'first\n');
    writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'one');
    const first = git(root, 'rev-parse', 'HEAD');
    writeFileSync(path.join(root, 'a.txt'), 'second\n');
    git(root, 'commit', '-qam', 'two');
    const second = git(root, 'rev-parse', 'HEAD');

    const provider = new ChangeDocumentProvider(() => [base]);
    const read = (ref, file, at = root) => provider.provideTextDocumentContent(changeDocumentUri(at, ref, file));
    assert.equal(await read(first, 'a.txt'), 'first\n');
    assert.equal(await read(second, 'a.txt'), 'second\n');
    // An empty side, a file absent at that commit, and a binary file.
    assert.equal(await read('', 'a.txt'), '');
    assert.equal(await read(first, 'missing.txt'), '');
    assert.match(await read(first, 'bin.dat'), /is a binary file/);
    // Only full hashes, repository-relative paths and repositories inside a workspace folder.
    assert.equal(await read('HEAD', 'a.txt'), '');
    assert.equal(await read(first.slice(0, 12), 'a.txt'), '');
    assert.equal(await read(first, '../outside.txt'), '');
    assert.equal(await new ChangeDocumentProvider(() => [path.join(base, 'elsewhere')]).provideTextDocumentContent(changeDocumentUri(root, first, 'a.txt')), '');
    assert.equal(await provider.provideTextDocumentContent({ query: 'not json' }), '');
    assert.equal(isInWorkspace(root, [base]), true);
    assert.equal(isInWorkspace(base, [root]), false);

    // A modified file: HEAD ↔ the file on disk, which stays editable.
    const change = (filePath, extra) => ({ path: filePath, indexStatus: ' ', workTreeStatus: 'M', staged: false, unstaged: true, untracked: false, conflicted: false, ...extra });
    await openWorkingChange({ root, head: second, change: change('a.txt') });
    let [command, left, right, title] = executed.at(-1);
    assert.deepEqual([command, JSON.parse(left.query), right.fsPath, title],
      ['vscode.diff', { root, ref: second, path: 'a.txt' }, path.join(root, 'a.txt'), 'a.txt (HEAD ↔ Working Tree)']);
    // Deleted: HEAD ↔ nothing. Renamed: the old name at HEAD ↔ the new file.
    await openWorkingChange({ root, head: second, change: change('gone.txt', { workTreeStatus: 'D' }) });
    [command, left, right, title] = executed.at(-1);
    assert.deepEqual([JSON.parse(right.query).ref, title], ['', 'gone.txt (Deleted)']);
    writeFileSync(path.join(root, 'b.txt'), 'second\n');
    await openWorkingChange({ root, head: second, change: change('b.txt', { indexStatus: 'R', originalPath: 'a.txt' }) });
    [command, left, right, title] = executed.at(-1);
    assert.deepEqual([JSON.parse(left.query).path, title], ['a.txt', 'a.txt → b.txt (HEAD ↔ Working Tree)']);
    // New and conflicted files open as they are; a folder (a linked repository) is revealed.
    await openWorkingChange({ root, head: second, change: change('b.txt', { indexStatus: '?', workTreeStatus: '?', untracked: true, unstaged: false }) });
    assert.deepEqual(executed.at(-1).slice(0, 1), ['vscode.open']);
    mkdirSync(path.join(root, 'lib'));
    await openWorkingChange({ root, head: second, change: change('lib') });
    assert.deepEqual(executed.at(-1)[0], 'revealInExplorer');

    // A commit's file: parent ↔ commit, named by short hashes; a root commit starts empty.
    await openCommitChange({ root, base: first, target: second, path: 'a.txt' });
    assert.equal(executed.at(-1)[3], `a.txt (${first.slice(0, 7)} ↔ ${second.slice(0, 7)})`);
    await openCommitChange({ root, base: '', target: first, path: 'a.txt' });
    assert.equal(executed.at(-1)[3], `a.txt (empty ↔ ${first.slice(0, 7)})`);
    console.log('Change documents smoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
