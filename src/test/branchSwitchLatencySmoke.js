const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Ignore the developer's global Git config, for this process and the git it spawns.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Latency Test', GIT_AUTHOR_EMAIL: 'latency@example.com',
  GIT_COMMITTER_NAME: 'Latency Test', GIT_COMMITTER_EMAIL: 'latency@example.com'
});

// The messages VS Code would show, recorded.
const shown = [];
const fakeVscode = {
  window: {
    showInformationMessage: message => { shown.push({ kind: 'info', message }); },
    showWarningMessage: message => { shown.push({ kind: 'warning', message }); },
    showErrorMessage: message => { shown.push({ kind: 'error', message }); },
    createOutputChannel: () => ({ appendLine() {} })
  },
  workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handleCheckoutBranch, handleGetHistory, handleGetRepositoryRefs } = require('../../out/handlers/webviewMessageHandler.js');
const { GitOperations } = require('../../out/gitOperations.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { OpenTimings } = require('../../out/openTimings.js');
const { BranchSwitchTracker } = require('../../out/services/branchService.js');
Module._load = originalLoad;

const PROCESS_COST_MS = 100;
const COMMITS = 300;
const bases = [];
const env = process.env;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A parent repository with two linked repositories and 300 commits, pushed to a bare origin; x is
 * one commit ahead on origin than the copy this machine last fetched.
 */
function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-latency-'));
  bases.push(base);
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const parent = path.join(base, 'parent');
  mkdirSync(parent);
  git(parent, 'init', '-q', '-b', 'main');
  let stream = '';
  for (let index = 1; index <= COMMITS; index++) {
    stream += `commit refs/heads/main\ncommitter Latency Test <latency@example.com> ${1700000000 + index} +0000\n`
      + `data ${`commit ${index}`.length}\ncommit ${index}\nM 100644 inline f.txt\ndata ${`${index}\n`.length}\n${index}\n\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: parent, env, input: stream });
  git(parent, 'reset', '-q', '--hard', 'main');
  for (const name of ['lib-a', 'lib-b']) {
    const library = path.join(base, name);
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(library, 'a.txt'), 'a\n');
    git(library, 'add', 'a.txt');
    git(library, 'commit', '-qm', `${name} base`);
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, name);
  }
  git(parent, 'commit', '-qm', 'add the linked repositories');
  git(parent, 'branch', 'x');
  git(parent, 'remote', 'add', 'origin', remote);
  git(parent, 'push', '-q', 'origin', 'main', 'x');
  const upstream = path.join(base, 'upstream');
  git(base, 'clone', '-q', remote, upstream);
  git(upstream, 'checkout', '-q', 'x');
  writeFileSync(path.join(upstream, 'g.txt'), 'new on origin\n');
  git(upstream, 'add', 'g.txt');
  git(upstream, 'commit', '-qm', 'one commit ahead on origin');
  git(upstream, 'push', '-q', 'origin', 'x');
  return { base, parent, remote, upstream, originX: git(upstream, 'rev-parse', 'HEAD'), mainTip: git(parent, 'rev-parse', 'main') };
}

/**
 * Makes every Git process wait before it runs (the start-up cost of a process on a slow machine) and
 * records each one's start and end. `delays` adds to that for chosen commands (a slow network fetch).
 */
function slowGit(delays = {}) {
  const calls = [];
  const originals = {};
  const wrap = name => {
    originals[name] = GitCommandService.prototype[name];
    GitCommandService.prototype[name] = async function (args, ...rest) {
      const call = { args, started: Date.now(), ended: 0 };
      calls.push(call);
      await sleep(PROCESS_COST_MS + (delays[args[0]] || 0));
      try { return await originals[name].call(this, args, ...rest); } finally { call.ended = Date.now(); }
    };
  };
  const scan = 'scanGitRecords';
  originals[scan] = GitCommandService.prototype[scan];
  GitCommandService.prototype[scan] = async function (args, cwd, ...rest) {
    const call = { args, started: Date.now(), ended: 0 };
    calls.push(call);
    await sleep(PROCESS_COST_MS);
    try { return await originals[scan].call(this, args, cwd, ...rest); } finally { call.ended = Date.now(); }
  };
  wrap('execGitRaw');
  wrap('execGitBuffer');
  return { calls, restore() { Object.assign(GitCommandService.prototype, originals); } };
}

/** The context the panel gives a handler, with every message and refresh recorded. */
function recordingContext(repos, options = {}) {
  const events = [];
  const posted = [];
  const lines = [];
  const timings = new OpenTimings(line => lines.push(line));
  const gitOps = new GitOperations(repos.parent);
  const ctx = {
    workspaceRoot: repos.parent,
    gitOps,
    timings,
    branchSwitches: new BranchSwitchTracker(),
    panel: {
      webview: {
        postMessage: async message => {
          posted.push({ ...message, at: Date.now(), calls: options.slow ? options.slow.calls.length : 0, refreshStarted: events.includes('refresh started') });
          events.push(message.type);
          return true;
        }
      }
    },
    async refresh() { events.push('refresh started'); await gitOps.getSubmodules(); events.push('refresh done'); },
    async reloadDashboardHistory(paths) { events.push(`reload history ${paths.join(',')}`); }
  };
  return { ctx, events, posted, lines, timings };
}

async function main() {
  let slow;
  try {
    // The budget: a click on a branch that exists locally draws its history within 0.5 s.
    let repos = setup();
    slow = slowGit();
    let run = recordingContext(repos, { slow });
    const started = Date.now();
    const handled = handleCheckoutBranch(run.ctx, { submodule: '.', branch: 'x' });
    while (!run.posted.some(message => message.type === 'branchCheckoutResult')) await sleep(1);
    const result = run.posted.find(message => message.type === 'branchCheckoutResult');
    const resultMs = result.at - started;
    const beforeResult = slow.calls.slice(0, result.calls);
    // The page then asks for the history and the refs together, as the dashboard does.
    await Promise.all([
      handleGetHistory(run.ctx, { repositoryPath: '.', limit: 100, offset: 0, search: '', includeRemotes: false, requestId: 1 }),
      handleGetRepositoryRefs(run.ctx, { repositoryPath: '.' })
    ]);
    const drawnMs = Date.now() - started;
    console.log(`Branch switch with ${PROCESS_COST_MS} ms per Git process: result posted after ${resultMs} ms ` +
      `(${beforeResult.length} Git processes: ${beforeResult.map(call => call.args[0]).join(', ')}), ` +
      `history and refs returned after ${drawnMs} ms`);
    assert.ok(beforeResult.every(call => call.args[0] !== 'fetch'), `a fetch ran before the result: ${JSON.stringify(beforeResult.map(call => call.args))}`);
    assert.ok(beforeResult.length <= 2, `${beforeResult.length} Git processes ran before the result`);
    const serial = beforeResult.every((call, index) => index === 0 || call.started >= beforeResult[index - 1].ended);
    assert.ok(serial, 'the processes before the result ran together instead of one after another');
    assert.equal(result.refreshStarted, false, 'ctx.refresh() started before the result was posted');
    assert.ok(resultMs < 300, `the result took ${resultMs} ms`);
    assert.equal(result.payload.success, true, result.payload.message);
    assert.equal(result.payload.update, 'pending');
    assert.ok(run.posted.some(message => message.type === 'historyLoaded') && run.posted.some(message => message.type === 'repositoryRefsLoaded'));
    assert.ok(drawnMs < 500, `history and refs took ${drawnMs} ms`);

    await handled;
    const update = run.posted.find(message => message.type === 'branchUpdateResult');
    assert.ok(update, 'no branchUpdateResult');
    assert.equal(update.payload.update, 'fast-forwarded', update.payload.message);
    assert.equal(update.payload.branch, 'x');
    assert.equal(git(repos.parent, 'rev-parse', 'x'), repos.originX);
    assert.equal(git(repos.parent, 'symbolic-ref', '--short', 'HEAD'), 'x');
    assert.deepEqual(shown.map(item => item.kind), ['info'], JSON.stringify(shown));
    assert.match(shown[0].message, /Updated x by 1 commit from origin/);

    // The timings output has the marks of a switch, in order, with the Git processes between them.
    const marks = ['click arrived', 'checkout done', 'result posted', 'update ended: fast-forwarded'];
    const positions = marks.map(mark => run.lines.findIndex(line => line.endsWith(mark)));
    assert.ok(positions.every(position => position >= 0), JSON.stringify(run.lines));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, JSON.stringify(run.lines));
    assert.ok(run.lines.some(line => /git for-each-ref .*\(\d+ ms\)/.test(line)) && run.lines.some(line => /git fetch origin .*\(\d+ ms\)/.test(line)),
      JSON.stringify(run.lines));
    run.timings.dispose();
    slow.restore();

    // Two clicks: x's slow fetch ends after the click on main. It must not fast-forward main
    // onto origin/x (x descends from main), and it must not warn; origin/x is still updated.
    repos = setup();
    shown.length = 0;
    slow = slowGit({ fetch: 800 });
    run = recordingContext(repos, { slow });
    const clickX = handleCheckoutBranch(run.ctx, { submodule: '.', branch: 'x' });
    while (!run.posted.some(message => message.type === 'branchCheckoutResult')) await sleep(1);
    assert.equal(git(repos.parent, 'symbolic-ref', '--short', 'HEAD'), 'x');
    await handleCheckoutBranch(run.ctx, { submodule: '.', branch: 'main' });
    await clickX;
    slow.restore();
    run.timings.dispose();
    assert.equal(git(repos.parent, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(git(repos.parent, 'rev-parse', 'refs/heads/main'), repos.mainTip, 'x\'s update fast-forwarded main');
    assert.notEqual(git(repos.parent, 'rev-parse', 'refs/heads/x'), repos.originX, 'x\'s update moved x after the click on main');
    assert.equal(git(repos.parent, 'rev-parse', 'refs/remotes/origin/x'), repos.originX, 'origin/x was not updated');
    assert.deepEqual(shown.filter(item => item.kind !== 'info'), [], JSON.stringify(shown));
    assert.equal(run.posted.filter(message => message.type === 'branchUpdateResult' && message.payload.branch === 'x').length, 0);
    // x's fetch moved origin/x after main's refresh read it: the list and the page are refreshed again.
    // One refresh per click, and a third once x's fetch has moved origin/x.
    assert.equal(run.events.filter(event => event === 'refresh started').length, 3, JSON.stringify(run.events));
    assert.ok(run.events.includes('reload history .'), JSON.stringify(run.events));

    // What the person is told: nothing for a checkout and a quiet update, a warning for one that needs
    // action, an error for a failed checkout.
    const clickOn = async (repositories, branch) => {
      shown.length = 0;
      const clicked = recordingContext(repositories);
      await handleCheckoutBranch(clicked.ctx, { submodule: '.', branch });
      clicked.timings.dispose();
      return clicked;
    };
    repos = setup();
    git(repos.parent, 'fetch', '-q', 'origin');
    git(repos.parent, 'branch', '-f', 'x', 'origin/x');
    let clicked = await clickOn(repos, 'x');
    assert.equal(clicked.posted.find(message => message.type === 'branchUpdateResult').payload.update, 'up-to-date');
    assert.deepEqual(shown, [], 'a checkout followed by up-to-date showed a message');
    // The fetch moved nothing: no second refresh and no reload.
    assert.equal(clicked.events.filter(event => event === 'refresh started').length, 1, JSON.stringify(clicked.events));
    assert.equal(clicked.events.some(event => event.startsWith('reload history')), false, JSON.stringify(clicked.events));

    repos = setup();
    git(repos.parent, 'checkout', '-q', 'x');
    writeFileSync(path.join(repos.parent, 'h.txt'), 'local\n');
    git(repos.parent, 'add', 'h.txt');
    git(repos.parent, 'commit', '-qm', 'local commit on x');
    git(repos.parent, 'checkout', '-q', 'main');
    clicked = await clickOn(repos, 'x');
    assert.equal(clicked.posted.find(message => message.type === 'branchUpdateResult').payload.update, 'diverged');
    assert.deepEqual(shown.map(item => item.kind), ['warning'], JSON.stringify(shown));
    // Diverged moves no branch, but the fetch moved origin/x: the ahead/behind counts and the graph's
    // origin/x label are read again after it, not left as the first refresh saw them.
    const updated = clicked.events.indexOf('branchUpdateResult');
    assert.ok(clicked.events.lastIndexOf('refresh started') > updated, JSON.stringify(clicked.events));
    assert.ok(clicked.events.indexOf('reload history .') > updated, JSON.stringify(clicked.events));

    repos = setup();
    clicked = await clickOn(repos, 'no-such-branch');
    assert.equal(clicked.posted.find(message => message.type === 'branchCheckoutResult').payload.success, false);
    assert.deepEqual(shown.map(item => item.kind), ['error'], JSON.stringify(shown));
    assert.equal(clicked.posted.some(message => message.type === 'branchUpdateResult'), false);

    // The refresh's `git status` and a checkout run at the same time now. Without GIT_OPTIONAL_LOCKS=0
    // status takes index.lock to refresh the index and about one checkout in six fails with
    // "Unable to create '.git/index.lock'". Two branches differ in 400 files; status runs in a loop
    // that touches three tracked files between runs, while 200 checkouts alternate the branches.
    const lockBase = mkdtempSync(path.join(tmpdir(), 'repository-manager-lock-'));
    bases.push(lockBase);
    const lockRepo = path.join(lockBase, 'repo');
    mkdirSync(lockRepo);
    git(lockRepo, 'init', '-q', '-b', 'a');
    const touched = ['t1.txt', 't2.txt', 't3.txt'];
    for (const file of touched) writeFileSync(path.join(lockRepo, file), `${file}\n`);
    for (let index = 0; index < 400; index++) writeFileSync(path.join(lockRepo, `f${index}.txt`), `a ${index}\n`);
    git(lockRepo, 'add', '.');
    git(lockRepo, 'commit', '-qm', 'a');
    git(lockRepo, 'checkout', '-q', '-b', 'b');
    for (let index = 0; index < 400; index++) writeFileSync(path.join(lockRepo, `f${index}.txt`), `b ${index}\n`);
    git(lockRepo, 'commit', '-qam', 'b');
    const lockGit = new GitCommandService(lockRepo);
    let statusRuns = 0;
    let looping = true;
    const statusLoop = (async () => {
      while (looping) {
        for (const file of touched) writeFileSync(path.join(lockRepo, file), `${file}\n`);
        await lockGit.execGit(['status', '--porcelain'], lockRepo).catch(() => undefined);
        statusRuns++;
      }
    })();
    const failures = [];
    for (let index = 0; index < 200; index++) {
      await lockGit.execGit(['checkout', index % 2 ? 'b' : 'a', '--'], lockRepo).catch(error => failures.push(error.message));
    }
    looping = false;
    await statusLoop;
    console.log(`Checkouts failing while status runs: ${failures.length} of 200 (${statusRuns} status runs)`);
    assert.deepEqual(failures.slice(0, 1), [], `${failures.length} of 200 checkouts failed`);

    // The tracker numbers clicks per repository.
    const tracker = new BranchSwitchTracker();
    const first = tracker.begin('/r');
    const other = tracker.begin('/other');
    assert.equal(tracker.isLatest('/r', first), true);
    const second = tracker.begin('/r');
    assert.equal(tracker.isLatest('/r', first), false);
    assert.equal(tracker.isLatest('/r', second), true);
    assert.equal(tracker.isLatest('/other', other), true);
    console.log('Branch switch latency smoke passed.');
  } finally {
    if (slow) slow.restore();
    for (const base of bases) if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
