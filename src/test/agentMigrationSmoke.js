// Moving Agent tasks to the Studio Chat (docs/agent-studio.md, "Agent tasks moved to Studio"):
// what each kind of task becomes, the task left alone while a step waits for review, the moved
// task kept on disk but no longer listed, and the moved plan running its next step on the task's
// branch with a scripted model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { TaskStore } = require('../../out/agent/taskStore.js');
const { taskToConversation, moveBlocker, remainingPlan } = require('../../out/studio/agentMigration.js');
const { ChatStore } = require('../../out/studio/chatStore.js');
const { studioSteps } = require('../../out/studio/registry.js');
const { RunStore, WorkflowEngine } = require('../../out/studio/engine.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-agent-move-'));
const steps = studioSteps();

const step = (title, fields = {}) => ({ title, intent: `Do ${title}`, tools: ['edit_file'], paths: ['src/'], checks: ['check'], state: 'pending', attempts: 0, ...fields });

async function main() {
  const tasks = new TaskStore(path.join(base, 'agent'));
  const chats = new ChatStore(path.join(base, 'chats'));
  const make = (title, fields) => { const task = tasks.create({ title, goal: `Goal of ${title}`, criteria: ['It works', 'Tests pass'], repositoryRoot: base }); Object.assign(task, fields); tasks.save(task); return task; };

  const midway = make('Fix parser', {
    status: 'stepReady', branch: 'agent/fix-parser-abc123', current: 1,
    plan: [step('Read the parser', { state: 'done', verification: 'passed' }), step('Fix the bug', { feedback: 'Check check failed (exit 1)' }), step('Add a test')]
  });
  const fresh = make('Add logging', { status: 'new' });
  const finished = make('Rename module', { status: 'done', branch: 'agent/rename', plan: [step('Rename', { state: 'done', verification: 'failed', acceptedDespite: ['check'] }), step('Docs', { state: 'skipped' })] });
  const reviewing = make('Half done', { status: 'stepReview', current: 0, plan: [step('Change it')] });

  // ---- A task with a step waiting for review stays: its changes are on disk.
  assert.match(moveBlocker(reviewing), /Step 1 is waiting for your review: Accept, Retry or Stop it in the task first\./);
  assert.deepEqual(taskToConversation(reviewing, chats, steps), { blocked: moveBlocker(reviewing) });
  assert.match(moveBlocker({ ...reviewing, status: 'stepRunning' }), /It is running/);

  // ---- Midway: the goal and criteria, what was done, and the rest as code steps on its branch.
  {
    const { conversation } = taskToConversation(midway, chats, steps);
    assert.equal(conversation.title, 'Fix parser');
    assert.equal(conversation.messages[0].role, 'user');
    assert.equal(conversation.messages[0].text, 'Goal of Fix parser\nDone when:\n- It works\n- Tests pass');
    const note = conversation.messages[1];
    assert.match(note.text, /^Moved from the Agent task "Fix parser" \(/);
    assert.match(note.text, /Its branch: agent\/fix-parser-abc123\. The steps below work on it: switch to it before Run\./);
    assert.match(note.text, /Done in the Agent:\n1\. Read the parser: checks passed/);
    assert.match(note.text, /"Fix the bug" was retried before: Check check failed/);
    assert.equal(note.draft.status, 'current');
    assert.deepEqual(note.draft.problems, [], 'the moved plan is a valid plan');
    const plan = conversation.plan;
    assert.deepEqual(plan.criteria, ['It works', 'Tests pass']);
    assert.equal(plan.description, 'Goal of Fix parser');
    assert.deepEqual(plan.nodes.map(node => [node.id, node.type, node.title]), [['step-2', 'code', 'Fix the bug'], ['step-3', 'code', 'Add a test']]);
    assert.deepEqual(plan.nodes[0].with, { task: 'Do Fix the bug', paths: ['src/'], checks: ['check'], branch: 'agent/fix-parser-abc123' });
    assert.deepEqual(plan.edges, [{ from: 'step-2', to: 'step-3' }]);
  }

  // ---- No plan yet: the goal, and a note to draft one. Finished: history only, no plan.
  {
    const { conversation } = taskToConversation(fresh, chats, steps);
    assert.equal(conversation.plan, undefined);
    assert.match(conversation.messages[1].text, /It had no plan yet: send a message to draft one\./);
    const done = taskToConversation(finished, chats, steps).conversation;
    assert.equal(done.plan, undefined);
    assert.equal(remainingPlan(finished), undefined);
    assert.match(done.messages[1].text, /It was finished\./);
    assert.match(done.messages[1].text, /1\. Rename: accepted with failing checks \(failing: check\)\n2\. Docs: skipped/);
  }

  // ---- A moved task is kept on disk, with its log, and no longer listed.
  {
    const { conversation } = taskToConversation(midway, chats, steps);
    await chats.save(conversation);
    midway.movedTo = conversation.id;
    tasks.save(midway);
    assert.deepEqual(tasks.list().map(task => task.title).sort(), ['Add logging', 'Half done', 'Rename module']);
    assert.equal(tasks.listAll().length, 4);
    assert.equal(tasks.get(midway.id).movedTo, conversation.id);
    assert.equal((await chats.load(conversation.id)).plan.nodes.length, 2);
  }

  // ---- The moved plan runs on the task's branch: refused until the repository is on it, then works.
  {
    const repo = path.join(base, 'repo');
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'node -e 0' } }));
    git(['init', '-q', '-b', 'main']); git(['add', '.']); git(['commit', '-q', '-m', 'init']);
    git(['branch', 'agent/fix-parser-abc123']);
    const turns = [{ tool: 'edit_file', input: { path: 'src/a.js', oldText: '1', newText: '2' } }, { final: 'Fixed.' }];
    const code = {
      router: () => ({ call: async () => {
        const turn = turns.shift();
        return turn.tool ? { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: turn.tool, input: turn.input }], usage: { inputTokens: 1, outputTokens: 1 }, modelId: 's' }
          : { stopReason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: turn.final }) }], usage: { inputTokens: 1, outputTokens: 1 }, modelId: 's' };
      } }),
      git: {
        currentBranch: async () => git(['branch', '--show-current']).trim(),
        hasChanges: async () => Boolean(git(['status', '--porcelain', '--untracked-files=no']).trim()),
        createBranch: async (_root, name) => { git(['switch', '-q', '-c', name]); }
      },
      isDirty: () => false, scripts: () => ({ check: 'node -e 0' }), allowedScripts: () => ['check'],
      runScript: async (_root, script) => ({ script, passed: true, exitCode: 0, output: '', durationMs: 1 })
    };
    const engine = new WorkflowEngine({ root: repo, steps, store: new RunStore(path.join(base, 'runs')), code });
    const plan = remainingPlan(midway);
    const go = async () => engine.continue(plan, await engine.answer(await engine.continue(plan, await engine.start(plan, 'h', {}), { cancelled: false }), true), { cancelled: false });
    const refused = await go();
    assert.match(refused.error, /The branch agent\/fix-parser-abc123 exists: switch to it to go on \(the repository is on main\)\./);
    git(['switch', '-q', 'agent/fix-parser-abc123']);
    const state = await go();
    assert.equal(state.waiting.kind, 'review', 'on the task\'s branch, its next step runs');
    assert.equal(state.data.branch, 'agent/fix-parser-abc123');
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8'), 'module.exports = 2;\n');
  }

  console.log('Agent migration smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(base, { recursive: true, force: true }));
