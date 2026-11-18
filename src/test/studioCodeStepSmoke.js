// The Studio's code step (docs/agent-studio.md, "2b-3") on a real Git repository with a scripted
// model that calls the agent's tools: the gate before it, the branch (the current one unless the plan
// names a new one), the repository's check,
// the review with its diff, Retry (undone, then run with what failed), Accept, Stop (undone), and
// the refusals (a new branch over uncommitted changes, a bad branch name, a script that is not the
// repository's or not approved).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const out = name => require(path.join(__dirname, '../../out/studio', name));
const { RunStore, WorkflowEngine } = out('engine.js');
const { studioSteps } = out('registry.js');
const { validateWorkflow } = out('workflow.js');
const { draftPlan } = out('chatPlanner.js');
const { lineDiff, validBranchName, cancelToken } = out('codeStep.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-code-step-'));
const repo = path.join(base, 'repo');
const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src', 'value.txt'), 'value = broken\n');
fs.writeFileSync(path.join(repo, 'check.js'), "const t = require('fs').readFileSync('src/value.txt', 'utf8'); if (!t.includes('fixed')) { console.error('value is ' + t.trim()); process.exit(1); }\n");
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { check: 'node check.js', deploy: 'echo no' } }, null, 2));
run(['init', '-q', '-b', 'main']);
run(['add', '.']);
run(['commit', '-q', '-m', 'init']);

const steps = studioSteps();
const never = { cancelled: false };
const approved = ['check'];

/** A scripted model with tools: each turn takes the next reply; records what it was sent. */
function router(turns, seen) {
  return {
    call: async (system, messages, tools) => {
      seen.push({ system, first: messages[0].content, tools: tools.map(tool => tool.name) });
      const turn = turns.shift();
      assert.ok(turn, 'the script has no turn left');
      if (turn.tool) { return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: `t${seen.length}`, name: turn.tool, input: turn.input }], usage: { inputTokens: 1, outputTokens: 1 }, modelId: 'scripted:1' }; }
      return { stopReason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: turn.final }) }], usage: { inputTokens: 1, outputTokens: 1 }, modelId: 'scripted:1' };
    }
  };
}

function services(turns, seen, selectors) {
  return {
    router: selector => { selectors.push(selector); return router(turns, seen); },
    git: {
      currentBranch: async root => run(['branch', '--show-current'], root).trim(),
      hasChanges: async root => Boolean(run(['status', '--porcelain', '--untracked-files=no'], root).trim()),
      createBranch: async (root, name) => { run(['switch', '-q', '-c', name], root); }
    },
    isDirty: () => false,
    scripts: root => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts,
    allowedScripts: () => approved,
    runScript: async (root, script) => {
      const started = Date.now();
      try {
        execFileSync('node', ['check.js'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
        return { script, passed: true, exitCode: 0, output: '', durationMs: Date.now() - started };
      } catch (error) {
        return { script, passed: false, exitCode: error.status, output: String(error.stderr), durationMs: Date.now() - started };
      }
    }
  };
}

const workflow = (extra = {}) => ({
  schema: 'repository-manager/workflow@1', id: 'fix-value', version: '0.1.0', title: 'Fix the value', criteria: ['src/value.txt says fixed', 'npm run check passes'],
  nodes: [{ id: 'fix', type: 'code', title: 'Fix it', model: 'copilot:gpt-4o', with: { task: 'Make src/value.txt say fixed', paths: ['src/'], checks: ['check'] } }],
  ...extra
});

async function main() {
  // ---- Validation: a code step names workspace paths, and is never looped.
  assert.deepEqual(validateWorkflow(workflow(), steps), []);
  const looped = workflow(); looped.nodes[0].forEach = '${inputs.list}'; looped.inputs = { list: { type: 'string' } };
  assert.ok(validateWorkflow(looped, steps).some(problem => /reviewed after it runs, so it cannot loop/.test(problem.message)));
  const outside = workflow(); outside.nodes[0].with.paths = ['../elsewhere/'];
  assert.ok(validateWorkflow(outside, steps).some(problem => /list of paths inside the workspace/.test(problem.message)));
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc\nd'), ['- b', '+ B', '+ d']);

  // ---- Gate first; then a failing attempt, reviewed; Retry undoes it and tells the model why.
  {
    const seen = []; const selectors = [];
    const turns = [
      { tool: 'read_file', input: { path: 'src/value.txt' } },
      { tool: 'edit_file', input: { path: 'src/value.txt', oldText: 'broken', newText: 'wrong' } },
      { final: 'Changed the value.' },
      { tool: 'edit_file', input: { path: 'src/value.txt', oldText: 'broken', newText: 'fixed' } },
      { final: 'Now it is fixed.' }
    ];
    const store = new RunStore(path.join(base, 'runs'));
    const engine = new WorkflowEngine({ root: repo, steps, store, code: services(turns, seen, selectors) });
    const flow = workflow();
    let state = await engine.start(flow, 'hash', {});
    state = await engine.continue(flow, state, never);
    assert.equal(state.waiting.kind, 'effect', 'the engine asks before a code step');
    assert.match(state.waiting.preview, /Task: Make src\/value\.txt say fixed\nMay change: src\/\nChecks after it: check\nBranch: the branch the repository is on now \(no new branch\)/);
    // An uncommitted change elsewhere is fine without a new branch, and is left alone.
    fs.appendFileSync(path.join(repo, 'check.js'), '// a local edit\n');

    state = await engine.answer(state, true);
    state = await engine.continue(flow, state, never);
    const branch = 'main';
    assert.equal(run(['branch', '--show-current']).trim(), 'main', 'no branch was created');
    assert.equal(run(['branch', '--list']).trim(), '* main');
    assert.equal(state.data.branch, branch);
    assert.deepEqual(selectors, ['copilot:gpt-4o'], 'the step\'s model is asked for');
    assert.deepEqual(seen[0].tools, ['read_file', 'list_files', 'search_code', 'edit_file', 'create_file', 'run_check']);
    assert.match(seen[0].first, /Criteria:\n1\. src\/value\.txt says fixed/);
    assert.equal(state.waiting.kind, 'review');
    // The step's writes were journaled first (#140); once the result is saved for review the journal goes.
    assert.equal(fs.existsSync(path.join(base, 'runs', state.id, 'fix.writes.jsonl')), false, 'the write journal outlived the saved result');
    assert.equal(state.waiting.verdict, 'failed');
    assert.equal(state.waiting.attempts, 1);
    assert.match(state.waiting.preview, /^A check FAILED\./);
    assert.match(state.waiting.preview, /### src\/value\.txt\n- value = broken\n\+ value = wrong/);
    assert.match(state.waiting.preview, /✗ check \(exit 1\)\nvalue is value = wrong/);
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'value.txt'), 'utf8'), 'value = wrong\n');

    // A review needs the workflow (it undoes); without it, it is refused and nothing changes.
    await assert.rejects(engine.answer(state, 'retry'), /cannot be reviewed here/);
    state = await engine.answer(state, 'retry', flow);
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'value.txt'), 'utf8'), 'value = broken\n', 'Retry undid the change');
    assert.equal(state.status, 'running');
    state = await engine.continue(flow, state, never);
    assert.match(seen[seen.length - 2].first, /An earlier attempt of this step was retried\. What went wrong:\nYour summary: Changed the value\.\n\nCheck check failed \(exit 1\)/);
    assert.equal(state.waiting.verdict, 'passed');
    assert.equal(state.waiting.attempts, 2);
    state = await engine.answer(state, 'accept', flow);
    state = await engine.continue(flow, state, never);
    assert.equal(state.status, 'done');
    assert.equal(state.nodes.fix.output.verification, 'passed');
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'value.txt'), 'utf8'), 'value = fixed\n');
    const log = await store.readLog(state.id);
    assert.deepEqual(log.filter(entry => entry.type === 'review').map(entry => entry.decision), ['retry', 'accept']);
    assert.ok(log.some(entry => entry.type === 'branch' && entry.branch === 'main' && entry.created === false));
    assert.match(fs.readFileSync(path.join(repo, 'check.js'), 'utf8'), /\/\/ a local edit\n$/, 'the person\'s own change is untouched');
    run(['checkout', '--', 'check.js']);
    run(['add', '.']); run(['commit', '-q', '-m', 'fixed']);
  }

  // ---- Stop at the review undoes the change and ends the run; the attempts are bounded.
  {
    const seen = [];
    const turns = [{ tool: 'create_file', input: { path: 'src/new.js', content: 'module.exports = 1;\n' } }, { final: 'Added a file.' }];
    const engine = new WorkflowEngine({ root: repo, steps, store: new RunStore(path.join(base, 'runs')), code: services(turns, seen, []) });
    const flow = workflow({ nodes: [{ id: 'add', type: 'code', with: { task: 'Add a file', paths: ['src/new.js'] } }] });
    let state = await engine.continue(flow, await engine.start(flow, 'hash', {}), never);
    state = await engine.continue(flow, await engine.answer(state, true), never);
    assert.equal(state.waiting.verdict, 'unverified', 'code changed and no check ran');
    assert.ok(fs.existsSync(path.join(repo, 'src', 'new.js')));
    state = await engine.answer(state, 'stop', flow);
    assert.equal(state.status, 'stopped');
    assert.match(state.error, /Stopped at the review of "add"; its changes were undone\./);
    assert.equal(fs.existsSync(path.join(repo, 'src', 'new.js')), false, 'the new file is gone');
    state.attempts.add = 3;
    state.status = 'waiting'; state.waiting = { node: 'add', kind: 'review', title: '', effect: 'write', preview: '' };
    await assert.rejects(engine.answer(state, 'retry', flow), /already ran 3 times/);
  }

  // ---- A new branch only when the plan names one; refusals.
  {
    const engine = new WorkflowEngine({ root: repo, steps, store: new RunStore(path.join(base, 'runs')), code: services([{ final: 'Nothing to do.' }], [], []) });
    const go = async flow => engine.continue(flow, await engine.answer(await engine.continue(flow, await engine.start(flow, 'hash', {}), never), true), never);
    const named = workflow(); named.nodes[0].with.branch = 'fix/value-again';
    const before = await engine.continue(named, await engine.start(named, 'hash', {}), never);
    assert.match(before.waiting.preview, /Branch: fix\/value-again \(a new branch, created from the current one\)/);
    const created = await engine.continue(named, await engine.answer(before, true), never);
    assert.equal(created.waiting.kind, 'review');
    assert.equal(run(['branch', '--show-current']).trim(), 'fix/value-again', 'the named branch was created');
    run(['switch', '-q', 'main']);

    fs.appendFileSync(path.join(repo, 'check.js'), '// local edit\n');
    const dirty = workflow(); dirty.nodes[0].with.branch = 'fix/other';
    const refused = await go(dirty);
    assert.equal(refused.status, 'failed');
    assert.match(refused.error, /uncommitted changes\. Commit or stash them first, so fix\/other starts clean/);
    run(['checkout', '--', 'check.js']);
    const bad = workflow(); bad.nodes[0].with.branch = 'bad..name';
    assert.match((await engine.continue(bad, await engine.start(bad, 'hash', {}), never)).error, /"bad\.\.name" is not a branch name Git accepts/);
    assert.deepEqual(['feat/x', 'fix/a.b', 'x..y', '-x', 'a/', '.hidden', 'a.lock'].map(validBranchName), [true, true, false, false, false, false, false]);
    const unknown = workflow(); unknown.nodes[0].with.checks = ['test'];
    assert.match((await go(unknown)).error, /Not scripts of this repository: test/);
    const unapproved = workflow(); unapproved.nodes[0].with.checks = ['deploy'];
    assert.match((await go(unapproved)).error, /not approved for this repository: deploy/);
    assert.equal(run(['branch', '--show-current']).trim(), 'main');
    assert.equal(run(['branch', '--list', 'fix/other']).trim(), '', 'a refused step made no branch');
  }

  // ---- A script's own writes (#139): a check that edits a tracked file, creates a file and deletes
  // one is in the review, Retry and Stop put back what can be put back and name what cannot, and the
  // person's own uncommitted work and later edits are left alone.
  for (const decision of ['retry', 'stop']) {
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'notes\n');
    fs.writeFileSync(path.join(repo, 'del.txt'), 'delete me\n');
    fs.writeFileSync(path.join(repo, 'user.txt'), 'user\n');
    fs.mkdirSync(path.join(repo, 'src', 'dir'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'inside.txt'), 'inside\n');
    fs.writeFileSync(path.join(repo, 'src', 'dir', 'f.txt'), 'in a folder\n');
    fs.writeFileSync(path.join(repo, 'old.bin'), Buffer.from([0, 9, 9, 0]));
    run(['add', '.']); run(['commit', '-q', '--allow-empty', '-m', `script fixtures ${decision}`]);
    fs.appendFileSync(path.join(repo, 'user.txt'), 'my own uncommitted line\n');
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'untracked work of mine\n');
    const turns = [
      { tool: 'run_check', input: { script: 'check' } },
      { final: 'Ran the check.' }
    ];
    const svc = services(turns, [], []);
    const base_ = svc.runScript;
    svc.runScript = async (root, script) => {
      fs.writeFileSync(path.join(root, 'notes.txt'), 'notes changed by the script\n');
      fs.mkdirSync(path.join(root, 'gen'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gen', 'out.txt'), 'generated\n');
      fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
      fs.rmSync(path.join(root, 'del.txt'), { force: true });
      fs.rmSync(path.join(root, 'src', 'inside.txt'), { force: true });
      fs.rmSync(path.join(root, 'src', 'dir'), { recursive: true, force: true });
      fs.rmSync(path.join(root, 'old.bin'), { force: true });
      fs.appendFileSync(path.join(root, 'user.txt'), 'script line\n');
      return base_(root, script);
    };
    const engine = new WorkflowEngine({ root: repo, steps, store: new RunStore(path.join(base, 'runs')), code: svc });
    const flow = workflow({ nodes: [{ id: 'fx', type: 'code', with: { task: 'Run the check', paths: ['src/'], checks: ['check'] } }] });
    let state = await engine.continue(flow, await engine.start(flow, 'hash', {}), never);
    state = await engine.continue(flow, await engine.answer(state, true), never);
    assert.equal(state.waiting.kind, 'review');
    const preview = state.waiting.preview;
    assert.match(preview, /### notes\.txt\n- notes\n\+ notes changed by the script/, 'the script\'s edit to a tracked file is in the review');
    assert.match(preview, /### gen\/out\.txt \(new\)/, 'the file the script created is in the review');
    assert.match(preview, /### user\.txt\n.*\+ script line/s, 'the script\'s line in a file the person already changed is in the review');
    assert.doesNotMatch(preview, /### user\.txt\n(.*\n)*- my own/, 'the person\'s own line is not shown as the step\'s change');
    assert.match(preview, /notes\.txt: changed by a script outside the paths this step may change/);
    assert.match(preview, /### del\.txt \(deleted by a script\)\n- delete me/, 'a deleted clean file is a change in the review');
    assert.match(preview, /### src\/inside\.txt \(deleted by a script\)/, 'a deletion inside the step\'s paths is a change');
    assert.match(preview, /del\.txt: deleted by a script outside the paths this step may change \(undone with the step\)/);
    assert.doesNotMatch(preview, /del\.txt: deleted by a script: cannot be undone/, 'a deleted text file is no longer "cannot be undone"');
    assert.match(preview, /old\.bin: deleted by a script: cannot be undone here/, 'a deleted binary file stays "cannot be undone"');
    assert.match(preview, /blob\.bin: binary, large or not a plain file by a script: cannot be undone here/);
    assert.doesNotMatch(preview, /mine\.txt/, 'the person\'s untracked file is not touched or listed');
    // The person edits a file the script created, after the script ran: that edit must survive the undo.
    fs.appendFileSync(path.join(repo, 'gen', 'out.txt'), 'person edit\n');
    if (decision === 'retry') { turns.push({ tool: 'run_check', input: { script: 'check' } }, { final: 'Again.' }); }
    state = await engine.answer(state, decision, flow);
    assert.equal(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'), 'notes\n', `${decision} put the edited tracked file back`);
    assert.equal(fs.readFileSync(path.join(repo, 'user.txt'), 'utf8'), 'user\nmy own uncommitted line\n', `${decision} kept the person's own work and removed the script's line`);
    assert.equal(fs.readFileSync(path.join(repo, 'mine.txt'), 'utf8'), 'untracked work of mine\n');
    assert.equal(fs.readFileSync(path.join(repo, 'gen', 'out.txt'), 'utf8'), 'generated\nperson edit\n', 'a file changed since the script is kept');
    assert.equal(fs.readFileSync(path.join(repo, 'del.txt'), 'utf8'), 'delete me\n', `${decision} restored the deleted clean file`);
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'inside.txt'), 'utf8'), 'inside\n', `${decision} restored the file deleted inside the step's paths`);
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'dir', 'f.txt'), 'utf8'), 'in a folder\n', `${decision} recreated the deleted folder`);
    assert.equal(fs.existsSync(path.join(repo, 'old.bin')), false, 'a deleted binary file is reported, not restored');
    // Leave the repository clean for the next block.
    run(['reset', '-q', '--hard']); run(['clean', '-fdq']);
  }

  // ---- Script effects, review findings on #167.
  {
    const { StepWorkspace, revertChanges } = require(path.join(__dirname, '../../out/agent/agentTools.js'));
    const sandbox = fs.mkdtempSync(path.join(base, 'effects-'));
    const work = path.join(sandbox, 'work');
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(path.join(work, 'lib'), { recursive: true }); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'a.txt'), 'outside original\n');
    fs.writeFileSync(path.join(work, 'lib', 'a.txt'), 'inside original\n');
    fs.writeFileSync(path.join(work, '.gitattributes'), 'crlf.txt text eol=crlf\n');
    fs.writeFileSync(path.join(work, 'crlf.txt'), 'original\r\n');
    const g = args => run(args, work);
    fs.writeFileSync(path.join(work, 'lib', 'person.txt'), 'head version\n');
    fs.writeFileSync(path.join(work, 'lib', 'edited.txt'), 'before the step\n');
    fs.writeFileSync(path.join(work, 'lib', 'bin.dat'), Buffer.from([0, 1, 0, 1]));
    fs.writeFileSync(path.join(work, 'lib', 'dirdel.txt'), 'in a folder\n');
    g(['init', '-q', '-b', 'main']); g(['add', '.']); g(['commit', '-q', '-m', 'init']);
    assert.equal(g(['status', '--porcelain']).trim(), '', 'the CRLF fixture is clean');
    const host = script => ({ root: work, isDirty: () => false, allowedScripts: () => ['x'], runScript: async () => { await script(); return { script: 'x', passed: true, exitCode: 0, output: '', durationMs: 0 }; } });

    // 1. A folder replaced by a link to a folder outside: nothing outside is recorded or written.
    let workspace = new StepWorkspace(host(async () => {
      fs.rmSync(path.join(work, 'lib'), { recursive: true });
      fs.symlinkSync(outside, path.join(work, 'lib'));
      fs.writeFileSync(path.join(outside, 'a.txt'), 'outside changed by the script\n');
    }), { tools: ['run_check'], paths: ['src/'] });
    await workspace.invoke('run_check', { script: 'x' });
    assert.deepEqual([...workspace.changes.keys()].filter(file => file.startsWith('lib')), [], 'nothing reached through a link is recorded');
    assert.ok(workspace.scriptNotes.some(note => note.path === 'lib/a.txt' && !note.undoable && /through a link/.test(note.reason)), JSON.stringify(workspace.scriptNotes));
    revertChanges(work, [...workspace.changes.values()], () => false);
    assert.equal(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8'), 'outside changed by the script\n', 'an undo never writes through the link');
    g(['checkout', '-q', '--', '.']); fs.rmSync(path.join(work, 'lib'), { force: true, recursive: true }); g(['checkout', '-q', '--', '.']);

    // 1b. A change recorded earlier, then its folder becomes a link before the undo: the undo skips it and names it.
    fs.writeFileSync(path.join(outside, 'a.txt'), 'outside original\n');
    workspace = new StepWorkspace(host(async () => { fs.writeFileSync(path.join(work, 'lib', 'a.txt'), 'inside changed\n'); }), { tools: ['run_check'], paths: ['src/'] });
    await workspace.invoke('run_check', { script: 'x' });
    assert.equal(workspace.changes.get('lib/a.txt').after, 'inside changed\n');
    fs.rmSync(path.join(work, 'lib'), { recursive: true });
    fs.symlinkSync(outside, path.join(work, 'lib'));
    fs.writeFileSync(path.join(outside, 'a.txt'), 'inside changed\n');
    const skipped = revertChanges(work, [...workspace.changes.values()], () => false);
    assert.deepEqual(skipped, ['lib/a.txt'], 'the undo names what it did not put back');
    assert.equal(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8'), 'inside changed\n', 'the undo never wrote through the link');
    fs.rmSync(path.join(work, 'lib')); g(['checkout', '-q', '--', '.']);

    // 2. A file with CRLF checkout: the "before" is the bytes on disk, so an undo restores them.
    workspace = new StepWorkspace(host(async () => { fs.writeFileSync(path.join(work, 'crlf.txt'), 'changed\r\n'); }), { tools: ['run_check'], paths: ['src/'] });
    await workspace.invoke('run_check', { script: 'x' });
    assert.equal(workspace.changes.get('crlf.txt').before, 'original\r\n');
    revertChanges(work, [...workspace.changes.values()], () => false);
    assert.equal(fs.readFileSync(path.join(work, 'crlf.txt'), 'utf8'), 'original\r\n', 'the undo restored the CRLF bytes');

    // 3. A clean CRLF file a script deletes comes back with its CRLF bytes (#169).
    workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'crlf.txt')); }), { tools: ['run_check'], paths: ['lib/'] });
    await workspace.invoke('run_check', { script: 'x' });
    assert.equal(workspace.changes.get('crlf.txt').after, null, 'a deletion is a change with after: null');
    assert.equal(workspace.changes.get('crlf.txt').before, 'original\r\n');
    assert.deepEqual(revertChanges(work, [...workspace.changes.values()], () => false), []);
    assert.equal(fs.readFileSync(path.join(work, 'crlf.txt')).toString('latin1'), 'original\r\n', 'the undo restored the deleted CRLF file byte for byte');

    // 4. Something is at the path when the undo runs: nothing is written, the path is kept.
    for (const [what, make] of [
      ['a new file', file => fs.writeFileSync(file, 'recreated by the person\n')],
      ['a folder', file => fs.mkdirSync(file)],
      ['a link', file => fs.symlinkSync(path.join(outside, 'a.txt'), file)]
    ]) {
      workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'lib', 'person.txt')); }), { tools: ['run_check'], paths: ['lib/'] });
      await workspace.invoke('run_check', { script: 'x' });
      assert.equal(workspace.changes.get('lib/person.txt').after, null);
      make(path.join(work, 'lib', 'person.txt'));
      const kept = revertChanges(work, [...workspace.changes.values()], () => false);
      assert.deepEqual(kept, ['lib/person.txt'], `${what} at the path is kept`);
      const stat = fs.lstatSync(path.join(work, 'lib', 'person.txt'));
      assert.ok(what === 'a folder' ? stat.isDirectory() : what === 'a link' ? stat.isSymbolicLink() : fs.readFileSync(path.join(work, 'lib', 'person.txt'), 'utf8') === 'recreated by the person\n', `${what} was left as it was`);
      fs.rmSync(path.join(work, 'lib', 'person.txt'), { recursive: true, force: true }); g(['checkout', '-q', '--', '.']);
    }
    // An editor with unsaved text for the absent path keeps it too.
    workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'lib', 'person.txt')); }), { tools: ['run_check'], paths: ['lib/'] });
    await workspace.invoke('run_check', { script: 'x' });
    assert.deepEqual(revertChanges(work, [...workspace.changes.values()], () => true), ['lib/person.txt'], 'unsaved editor text keeps the path');
    assert.equal(fs.existsSync(path.join(work, 'lib', 'person.txt')), false);
    g(['checkout', '-q', '--', '.']);

    // 5. A file the person had changed and not committed: restored with their content, not HEAD's.
    fs.writeFileSync(path.join(work, 'lib', 'person.txt'), 'my uncommitted version\n');
    workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'lib', 'person.txt')); }), { tools: ['run_check'], paths: ['lib/'] });
    await workspace.invoke('run_check', { script: 'x' });
    assert.equal(workspace.changes.get('lib/person.txt').before, 'my uncommitted version\n');
    revertChanges(work, [...workspace.changes.values()], () => false);
    assert.equal(fs.readFileSync(path.join(work, 'lib', 'person.txt'), 'utf8'), 'my uncommitted version\n', 'the person\'s content came back, not HEAD\'s');
    g(['checkout', '-q', '--', '.']);

    // 6. A file the step edited with edit_file, then a script deleted: undo restores the content from before the step.
    workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'lib', 'edited.txt')); }), { tools: ['edit_file', 'run_check'], paths: ['lib/'] });
    assert.equal((await workspace.invoke('edit_file', { path: 'lib/edited.txt', oldText: 'before', newText: 'during' })).ok, true);
    await workspace.invoke('run_check', { script: 'x' });
    assert.equal(workspace.changes.get('lib/edited.txt').after, null);
    assert.equal(workspace.changes.get('lib/edited.txt').before, 'before the step\n', 'the first before is kept');
    revertChanges(work, [...workspace.changes.values()], () => false);
    assert.equal(fs.readFileSync(path.join(work, 'lib', 'edited.txt'), 'utf8'), 'before the step\n');
    g(['checkout', '-q', '--', '.']);

    // 7. An untracked text file (not ignored) the person had: restored.
    fs.writeFileSync(path.join(work, 'lib', 'scratch.txt'), 'my scratch\n');
    workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'lib', 'scratch.txt')); }), { tools: ['run_check'], paths: ['lib/'] });
    await workspace.invoke('run_check', { script: 'x' });
    revertChanges(work, [...workspace.changes.values()], () => false);
    assert.equal(fs.readFileSync(path.join(work, 'lib', 'scratch.txt'), 'utf8'), 'my scratch\n', 'an untracked text file came back');
    fs.rmSync(path.join(work, 'lib', 'scratch.txt'));

    // 8. A clean binary file a script deletes stays "cannot be undone".
    workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'lib', 'bin.dat')); }), { tools: ['run_check'], paths: ['lib/'] });
    await workspace.invoke('run_check', { script: 'x' });
    assert.equal(workspace.changes.has('lib/bin.dat'), false);
    assert.ok(workspace.scriptNotes.some(note => note.path === 'lib/bin.dat' && !note.undoable && /deleted/.test(note.reason)), JSON.stringify(workspace.scriptNotes));
    g(['checkout', '-q', '--', '.']);

    // 9. The whole folder is gone: the undo recreates it.
    workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'lib'), { recursive: true }); }), { tools: ['run_check'], paths: ['src/'] });
    await workspace.invoke('run_check', { script: 'x' });
    assert.equal(fs.existsSync(path.join(work, 'lib')), false);
    assert.deepEqual(revertChanges(work, [...workspace.changes.values()].filter(c => c.path === 'lib/dirdel.txt'), () => false), []);
    assert.equal(fs.readFileSync(path.join(work, 'lib', 'dirdel.txt'), 'utf8'), 'in a folder\n', 'the missing folder was recreated');
    g(['checkout', '-q', '--', '.']);

    // 10. A file the step created and a script then deleted is no change: before and after are both null.
    workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'src', 'new.txt')); }), { tools: ['create_file', 'run_check'], paths: ['src/'] });
    await workspace.invoke('create_file', { path: 'src/new.txt', content: 'made by the step\n' });
    assert.equal(workspace.changes.has('src/new.txt'), true, 'the created file is recorded while it exists');
    await workspace.invoke('run_check', { script: 'x' });
    assert.equal(fs.existsSync(path.join(work, 'src', 'new.txt')), false);
    assert.equal(workspace.changes.has('src/new.txt'), false, 'a file created and then deleted is not a change');
    assert.deepEqual(revertChanges(work, [...workspace.changes.values()], () => false), [], 'nothing is kept or left to undo');
    assert.equal(fs.existsSync(path.join(work, 'src', 'new.txt')), false, 'the file stays absent');
    const { codePreview } = out('codeStep.js');
    const preview = codePreview({ changes: [...workspace.changes.values()], verification: 'noChanges', summary: '', branch: 'b', checks: [], aiText: [], scriptNotes: workspace.scriptNotes });
    assert.doesNotMatch(preview, /new\.txt/, 'the preview does not mention it');

    // 11. A committed (clean) symlink: a script that deletes or retargets it leaves a note that cannot be undone,
    // and an undo never writes a regular file in its place.
    let canLink = true;
    try { fs.writeFileSync(path.join(work, 'target.txt'), 'the target\n'); fs.symlinkSync('target.txt', path.join(work, 'link.txt')); } catch { canLink = false; }
    if (!canLink) { console.log('skipped: fs.symlinkSync is not permitted on this platform, so the tracked-symlink cases did not run'); } else {
      g(['add', 'target.txt', 'link.txt']); g(['commit', '-q', '-m', 'a tracked link']);
      assert.match(g(['ls-tree', 'HEAD', '--', 'link.txt']), /^120000 /, 'the fixture link is committed as a symlink');
      workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'link.txt')); }), { tools: ['run_check'], paths: ['lib/'] });
      await workspace.invoke('run_check', { script: 'x' });
      assert.equal(workspace.changes.has('link.txt'), false, 'a deleted tracked link is not an undoable change');
      assert.ok(workspace.scriptNotes.some(note => note.path === 'link.txt' && !note.undoable), JSON.stringify(workspace.scriptNotes));
      assert.deepEqual(revertChanges(work, [...workspace.changes.values()], () => false), []);
      assert.equal(fs.existsSync(path.join(work, 'link.txt')) || (() => { try { fs.lstatSync(path.join(work, 'link.txt')); return true; } catch { return false; } })(), false, 'no regular file was written where the link was');
      g(['checkout', '-q', '--', '.']);
      assert.ok(fs.lstatSync(path.join(work, 'link.txt')).isSymbolicLink(), 'the fixture link is back');

      workspace = new StepWorkspace(host(async () => { fs.rmSync(path.join(work, 'link.txt')); fs.symlinkSync('elsewhere.txt', path.join(work, 'link.txt')); }), { tools: ['run_check'], paths: ['lib/'] });
      await workspace.invoke('run_check', { script: 'x' });
      assert.equal(workspace.changes.has('link.txt'), false, 'a retargeted tracked link is not an undoable change');
      assert.ok(workspace.scriptNotes.some(note => note.path === 'link.txt' && !note.undoable), JSON.stringify(workspace.scriptNotes));
      g(['checkout', '-q', '--', '.']);
    }
  }

  // A step that fails or is cancelled after a script changed files keeps the notes in the run log.
  for (const how of ['cancel', 'fail']) {
    fs.writeFileSync(path.join(repo, 'gone.bin'), Buffer.from([0, 1, 2]));
    run(['add', '.']); run(['commit', '-q', '--allow-empty', '-m', `gone ${how}`]);
    const live = { cancelled: false };
    const turns = [{ tool: 'run_check', input: { script: 'check' } }];
    if (how === 'cancel') { turns.push({ final: 'Done.' }); }
    const svc = services(turns, [], []);
    const inner = svc.runScript;
    svc.runScript = async (root, script) => {
      fs.rmSync(path.join(root, 'gone.bin'), { force: true });
      if (how === 'cancel') { live.cancelled = true; }
      return inner(root, script);
    };
    const store = new RunStore(path.join(base, 'runs'));
    const engine = new WorkflowEngine({ root: repo, steps, store, code: svc });
    const flow = workflow();
    const waiting = await engine.continue(flow, await engine.start(flow, 'hash', {}), never);
    const state = await engine.continue(flow, await engine.answer(waiting, true), live);
    assert.notEqual(state.status, 'waiting');
    const entry = (await store.readLog(state.id)).find(item => item.type === 'script-changes');
    assert.ok(entry, `${how}: the log names what a script changed that cannot be undone`);
    assert.deepEqual(entry.files.map(file => file.path), ['gone.bin']);
    if (how === 'fail') { assert.match(state.error, /changed by a script and not undone, check with Git: gone\.bin/); }
    run(['reset', '-q', '--hard']); run(['clean', '-fdq']);
  }

  // ---- Cancel reaches a running check: it is told, stops, and the step's change is undone.
  {
    const signal = { cancelled: false };
    const token = cancelToken(signal, 10);
    let told = 0;
    token.onCancellationRequested(() => { told++; });
    signal.cancelled = true;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(told, 1);
    token.onCancellationRequested(() => { told++; });
    assert.equal(told, 2, 'a listener added after the cancel is told at once');
    token.dispose();

    const live = { cancelled: false };
    let stopped = false;
    const slow = services([{ tool: 'edit_file', input: { path: 'src/value.txt', oldText: 'fixed', newText: 'half' } }, { final: 'Done.' }], [], []);
    slow.runScript = (_root, script, checkToken) => new Promise(resolve => {
      // A check that would run for minutes, unless it is stopped.
      const timer = setTimeout(() => resolve({ script, passed: true, exitCode: 0, output: '', durationMs: 600000 }), 600000);
      checkToken.onCancellationRequested(() => { stopped = true; clearTimeout(timer); resolve({ script, passed: false, exitCode: null, output: 'Cancelled.', durationMs: 1 }); });
      setTimeout(() => { live.cancelled = true; }, 50);
    });
    const engine = new WorkflowEngine({ root: repo, steps, store: new RunStore(path.join(base, 'runs')), code: slow });
    const flow = workflow();
    const waiting = await engine.continue(flow, await engine.start(flow, 'hash', {}), never);
    const started = Date.now();
    const state = await engine.continue(flow, await engine.answer(waiting, true), live);
    assert.ok(stopped, 'the running check was told to stop');
    assert.ok(Date.now() - started < 5000, 'not waited out');
    assert.equal(state.status, 'stopped');
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'value.txt'), 'utf8'), 'value = fixed\n', 'the change was undone');
  }

  // ---- The planner: code steps may only name the repository's scripts as checks.
  {
    const plan = { reply: 'Plan.', workflow: { title: 'Fix', criteria: ['fixed'], nodes: [{ id: 'fix', type: 'code', with: { task: 'Fix', paths: ['src/'], checks: ['tests'] } }] } };
    const prompts = [];
    const model = { complete: async prompt => { prompts.push(prompt); return { text: JSON.stringify(plan), model: 'Scripted' }; } };
    const draft = await draftPlan(model, steps, { message: 'Fix the value', history: [], scripts: ['check', 'deploy'] }, never);
    assert.match(prompts[0], /Repository scripts \(the only names a code step's "checks" may use; prefer lint and tests\): check, deploy/);
    assert.match(prompts[0], /- code: Changes code in this repository/);
    assert.match(prompts[0], /Set "branch" in a code step's "with" ONLY when the person asks for a new branch/);
    assert.ok(draft.problems.some(problem => /Not scripts of this repository: tests/.test(problem.message)));
    const folderless = await draftPlan(model, steps, { message: 'Fix', history: [] }, never);
    assert.ok(folderless.problems.length);
    assert.match(prompts[prompts.length - 1], /No folder is open: do not plan code steps\./);
  }

  console.log('Studio code step smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(base, { recursive: true, force: true }));
