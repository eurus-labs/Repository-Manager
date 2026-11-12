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
const { lineDiff, validBranchName } = out('codeStep.js');

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
