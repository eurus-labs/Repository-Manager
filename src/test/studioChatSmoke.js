// The Studio Chat (docs/agent-studio.md, "Phase 2b design: Studio Chat") with scripted models:
// the planner drafts, repairs once and diffs; the conversation rules (first plan, proposed change,
// accept, discard, card edits); per-step models and frozen criteria in the engine; and the chat
// view's host through a fake `vscode` whose vscode.lm answers from a script.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-studio-chat-'));
const workspace = path.join(base, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

// --- the fake `vscode` (used only by the host part at the end) -------------------------------------
const lmReplies = [];
// Copilot's models load after the chat opens: empty at first, then announced.
const availableModels = [];
const modelListeners = [];
const lmCalls = [];
const asked = [];
const answers = { warning: [], quickPick: [] };
const commands = new Map();
let viewProvider;
const fileUri = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` });
const lmModel = (family, name) => ({
  id: `${family}-id`, name, vendor: 'copilot', family, version: '1', maxInputTokens: 200000,
  countTokens: async text => Math.ceil(text.length / 4),
  sendRequest: async (messages) => {
    lmCalls.push({ family, prompt: messages[0].text });
    let reply = lmReplies.shift();
    if (reply === undefined) { throw new Error('the script has no reply left'); }
    // A function is a reply that comes later: the test decides when.
    if (typeof reply === 'function') { reply = await reply(); }
    return { text: (async function* () { yield typeof reply === 'string' ? reply : JSON.stringify(reply); })() };
  }
});
const fakeVscode = {
  Uri: { file: fileUri, joinPath: (uri, ...parts) => fileUri(path.join(uri.fsPath, ...parts)) },
  Range: class {},
  WorkspaceEdit: class { replace() {} },
  CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} },
  LanguageModelChatMessage: { User: text => ({ text }) },
  lm: {
    selectChatModels: async () => [...availableModels],
    onDidChangeChatModels: listener => { modelListeners.push(listener); return { dispose() {} }; }
  },
  workspace: { textDocuments: [], applyEdit: async () => true },
  window: {
    registerWebviewViewProvider: (_id, provider) => { viewProvider = provider; return { dispose() {} }; },
    showWarningMessage: async (message) => { asked.push(['warning', message]); return answers.warning.shift(); },
    showQuickPick: async items => { const pick = answers.quickPick.shift(); return pick ? items.find(pick) : undefined; }
  },
  commands: {
    registerCommand: (id, run) => { commands.set(id, run); return { dispose() {} }; },
    executeCommand: async (...args) => { asked.push(['command', ...args.map(arg => arg && arg.fsPath ? arg.fsPath : arg)]); }
  }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const out = name => require(path.join(__dirname, '../../out/studio', name));
const { draftPlan, planDiff, diffIsEmpty, normalizePlan, stepCatalog } = out('chatPlanner.js');
const { addDraft, addUserMessage, acceptDraft, discardDraft, editPlan, currentCard, planView, history, ChatError } = out('chatSession.js');
const { ChatStore } = out('chatStore.js');
const { RunStore, WorkflowEngine, workflowModels } = out('engine.js');
const { stepRegistry } = out('steps.js');
const { validateWorkflow } = out('workflow.js');
const { StudioChatProvider } = out('studioChat.js');
Module._load = originalLoad;

const steps = stepRegistry();
const never = { cancelled: false };

/** A plan as the model would write it: a prompt that summarizes, then a file write. */
const plan = (extra = {}) => ({
  title: 'Summarize notes',
  criteria: ['notes/summary.md holds a summary of the input text'],
  inputs: { text: { type: 'string', title: 'Text' } },
  types: { Summary: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
  prompts: { summarize: { instructions: 'Summarize the text.', output: 'Summary' } },
  nodes: [
    { id: 'summarize', type: 'prompt', prompt: 'summarize', with: { input: '${inputs.text}' } },
    { id: 'write', type: 'file.write', with: { path: 'notes/summary.md', content: '${summarize.output.summary}' } }
  ],
  edges: [{ from: 'summarize', to: 'write' }],
  ...extra
});

/** A scripted StudioModel: replies in order, records each prompt and the selector asked for. */
function scripted(replies) {
  const calls = [];
  return { calls, complete: async (prompt, _signal, model) => {
    calls.push({ prompt, model });
    const reply = replies.shift();
    return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), model: model ? `Scripted ${model}` : 'Scripted' };
  } };
}

async function main() {
  // ---- The catalog the model is given names every step and what it asks.
  const catalog = stepCatalog(steps);
  for (const type of ['prompt', 'docs.requirements', 'requirements.compare', 'file.write', 'gate']) { assert.match(catalog, new RegExp(`^- ${type.replace('.', '\\.')}:`, 'm')); }
  assert.match(catalog, /file\.write: .*a person approves it first/);

  // ---- A first plan, valid at once: filled in (schema, id, version) and sent with the chosen model.
  {
    const model = scripted([{ reply: 'Here is a plan.', workflow: plan() }]);
    const draft = await draftPlan(model, steps, { message: 'Summarize my notes into a file', history: [], model: 'copilot:gpt-4o' }, never);
    assert.deepEqual(draft.problems, []);
    assert.equal(draft.workflow.schema, 'repository-manager/workflow@1');
    assert.equal(draft.workflow.id, 'summarize-notes');
    assert.equal(draft.workflow.version, '0.1.0');
    assert.equal(draft.diff, undefined, 'a first plan has nothing to diff');
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0].model, 'copilot:gpt-4o', 'the chosen model drafts');
    assert.match(model.calls[0].prompt, /There is no plan yet\./);
    assert.match(model.calls[0].prompt, /Summarize my notes into a file/);
  }

  // ---- An unknown step type gets one repair turn with the problem; the fixed reply is used.
  {
    const bad = plan(); bad.nodes[1].type = 'file.append';
    const model = scripted([{ reply: 'Plan.', workflow: bad }, '```json\n' + JSON.stringify({ reply: 'Fixed.', workflow: plan() }) + '\n```']);
    const draft = await draftPlan(model, steps, { message: 'Summarize', history: [] }, never);
    assert.equal(model.calls.length, 2);
    assert.match(model.calls[1].prompt, /Unknown step type "file\.append"/);
    assert.deepEqual(draft.problems, []);
    assert.equal(draft.reply, 'Fixed.');
  }

  // ---- Still wrong after the repair: shown with its problems (no criteria, a reference to nothing).
  {
    const wrong = plan({ criteria: undefined }); wrong.nodes[1].with.content = '${nowhere.output}';
    const model = scripted([{ reply: 'A', workflow: wrong }, { reply: 'B', workflow: wrong }]);
    const draft = await draftPlan(model, steps, { message: 'Summarize', history: [] }, never);
    assert.equal(model.calls.length, 2, 'only one repair turn');
    assert.ok(draft.workflow, 'the draft is kept to show');
    assert.ok(draft.problems.some(problem => problem.where === 'criteria'), 'a plan without criteria is a problem');
    assert.ok(draft.problems.some(problem => /no node "nowhere"/.test(problem.message)));
  }

  // ---- A reply that is not JSON twice; a reply that does not change the plan.
  {
    const draft = await draftPlan(scripted(['sure!', 'sure!']), steps, { message: 'Hi', history: [] }, never);
    assert.equal(draft.workflow, undefined);
    assert.equal(draft.reply, '');
    assert.match(draft.problems[0].message, /not one JSON object/);
    const answer = await draftPlan(scripted([{ reply: 'It writes one file.', workflow: null }]), steps, { message: 'What does it write?', history: [] }, never);
    assert.deepEqual(answer, { reply: 'It writes one file.', problems: [], model: 'Scripted' });
  }

  // ---- A model and criteria in the file are checked like any other field.
  {
    const check = workflow => validateWorkflow({ schema: 'repository-manager/workflow@1', id: 'x', version: '1', ...workflow }, steps).map(problem => `${problem.where}: ${problem.message}`);
    const withModels = plan({ defaults: { model: 'copilot:gpt-4o' } }); withModels.nodes[0].model = 'copilot:claude-sonnet';
    assert.deepEqual(check(withModels), []);
    const onWrite = plan(); onWrite.nodes[1].model = 'copilot:gpt-4o';
    assert.ok(check(onWrite).some(line => /\(write\)\.model: "file\.write" does not use a model/.test(line)));
    const badName = plan({ defaults: { model: 'gpt 4o', temperature: 1 } });
    assert.ok(check(badName).some(line => /^defaults\.model: Name a model/.test(line)));
    assert.ok(check(badName).some(line => /^defaults\.temperature:/.test(line)));
    assert.ok(check(plan({ criteria: ['ok', ''] })).some(line => /^criteria:/.test(line)));
    assert.deepEqual(workflowModels(withModels), ['copilot:gpt-4o', 'copilot:claude-sonnet']);
  }

  // ---- The conversation: first plan is the plan; a change waits as a diff until accepted.
  {
    const store = new ChatStore(path.join(base, 'chats'));
    const conversation = store.create();
    addUserMessage(conversation, 'Summarize my notes into a file');
    const first = addDraft(conversation, await draftPlan(scripted([{ reply: 'Plan.', workflow: plan() }]), steps, { message: 'Summarize', history: [] }, never));
    assert.equal(first.draft.status, 'current');
    assert.equal(conversation.plan.id, 'summarize-notes');
    assert.equal(conversation.title, 'Summarize my notes into a file');
    assert.deepEqual(planView(conversation.plan, steps).steps.map(step => [step.id, step.effect, step.usesModel]), [['summarize', 'read', true], ['write', 'write', false]]);

    // The model drops the write step while asked for something else: the drop is shown, not applied.
    const dropped = plan({ criteria: ['A summary is shown'] }); dropped.nodes = [dropped.nodes[0]]; dropped.edges = [];
    const model = scripted([{ reply: 'Changed.', workflow: dropped }]);
    const turn = { message: 'Use a shorter summary', current: conversation.plan, history: history(conversation) };
    const change = addDraft(conversation, await draftPlan(model, steps, turn, never));
    assert.match(model.calls[0].prompt, /The current plan:\n\{.*"summarize-notes"/s);
    assert.match(model.calls[0].prompt, /Person: Summarize my notes into a file/);
    assert.equal(change.draft.status, 'proposed');
    assert.deepEqual(change.draft.diff.removed, ['write']);
    assert.deepEqual(change.draft.diff.criteriaRemoved, ['notes/summary.md holds a summary of the input text']);
    assert.equal(conversation.plan.nodes.length, 2, 'the plan does not change before Accept');

    // A second change supersedes the first; only the latest can be accepted.
    const kept = plan(); kept.nodes[0].with = { input: '${inputs.text}' }; kept.prompts.summarize.instructions = 'Summarize the text in 3 lines.';
    const second = addDraft(conversation, await draftPlan(scripted([{ reply: 'Shorter.', workflow: kept }]), steps, { ...turn, current: conversation.plan }, never));
    assert.equal(change.draft.status, 'superseded');
    assert.deepEqual(second.draft.diff.changed, ['summarize'], 'a changed prompt marks the node that uses it');
    assert.throws(() => acceptDraft(conversation, change.id), ChatError);
    acceptDraft(conversation, second.id);
    assert.equal(second.draft.status, 'current');
    assert.equal(first.draft.status, 'superseded');
    assert.equal(conversation.plan.prompts.summarize.instructions, 'Summarize the text in 3 lines.');
    assert.equal(conversation.plan.id, 'summarize-notes', 'a change keeps the plan id');

    // Only the flow changes (a condition on an edge): still a change to accept (edges are compared).
    const reordered = { ...conversation.plan, edges: [{ from: 'summarize', to: 'write', when: '${summarize.output.summary}' }] };
    const reorder = addDraft(conversation, await draftPlan(scripted([{ reply: 'Unchained.', workflow: reordered }]), steps, { ...turn, current: conversation.plan }, never));
    assert.equal(reorder.draft.status, 'proposed');
    assert.deepEqual(reorder.draft.diff.other, ['edges']);
    discardDraft(conversation, reorder.id);

    // A "change" with nothing different is a reply; discard leaves the plan.
    const same = addDraft(conversation, await draftPlan(scripted([{ reply: 'Same.', workflow: conversation.plan }]), steps, { ...turn, current: conversation.plan }, never));
    assert.equal(same.draft, undefined);
    const third = addDraft(conversation, await draftPlan(scripted([{ reply: 'Gate.', workflow: { ...conversation.plan, nodes: [...conversation.plan.nodes, { id: 'look', type: 'gate', with: { title: 'Look' } }] } }]), steps, { ...turn, current: conversation.plan }, never));
    discardDraft(conversation, third.id);
    assert.equal(third.draft.status, 'discarded');
    assert.equal(conversation.plan.nodes.length, 2);

    // Card edits: criteria and models only.
    editPlan(conversation, { op: 'setCriteria', criteria: ['The summary has 3 lines', ' '] }, steps);
    editPlan(conversation, { op: 'setNode', id: 'summarize', field: 'model', value: 'copilot:claude-sonnet' }, steps);
    editPlan(conversation, { op: 'setDefaultModel', value: 'copilot:gpt-4o' }, steps);
    assert.deepEqual(conversation.plan.criteria, ['The summary has 3 lines']);
    assert.equal(conversation.plan.nodes[0].model, 'copilot:claude-sonnet');
    assert.deepEqual(currentCard(conversation).draft.problems, []);
    assert.throws(() => editPlan(conversation, { op: 'removeNode', id: 'write' }, steps), /criteria, models and skills/);
    editPlan(conversation, { op: 'setCriteria', criteria: [] }, steps);
    assert.ok(currentCard(conversation).draft.problems.some(problem => problem.where === 'criteria'), 'removing every criterion stops Run');
    editPlan(conversation, { op: 'setCriteria', criteria: ['The summary has 3 lines'] }, steps);

    await store.save(conversation);
    const [loaded] = await store.list();
    assert.equal(loaded.id, conversation.id);
    assert.equal(loaded.plan.nodes[0].model, 'copilot:claude-sonnet');
    assert.ok(!diffIsEmpty(planDiff(plan(), loaded.plan)));
  }

  // ---- The engine: each prompt node asks for its model, a missing one goes to its replacement,
  // ---- and the criteria are frozen when the run starts.
  {
    const workflow = normalizePlan(plan({ defaults: { model: 'copilot:gpt-4o' } }), undefined, 'x');
    workflow.nodes.splice(1, 0, { id: 'again', type: 'prompt', prompt: 'summarize', model: 'copilot:gone', with: { input: '${inputs.text}' } });
    workflow.edges.push({ from: 'summarize', to: 'again' });
    const model = scripted([{ summary: 'one' }, { summary: 'two' }]);
    const store = new RunStore(path.join(base, 'runs'));
    const engine = new WorkflowEngine({ root: workspace, steps, store, model });
    const state = await engine.start(workflow, 'hash', { text: 'notes' }, { 'copilot:gone': 'copilot:claude-sonnet' });
    workflow.criteria.push('added after the start');
    assert.deepEqual(state.criteria, ['notes/summary.md holds a summary of the input text']);
    const after = await engine.continue(workflow, state, never);
    assert.equal(after.status, 'waiting', 'the write asks first');
    assert.deepEqual(model.calls.map(call => call.model), ['copilot:gpt-4o', 'copilot:claude-sonnet']);
    assert.deepEqual((await store.load(state.id)).models, { 'copilot:gone': 'copilot:claude-sonnet' });
  }

  // ---- The chat view's host: send, accept, card edits, save, sync from the file, run.
  {
    const posted = [];
    const memento = () => { const values = new Map(); return { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } }; };
    const context = {
      subscriptions: [], extensionUri: fileUri(path.resolve(__dirname, '../..')),
      storageUri: fileUri(path.join(base, 'storage')), globalStorageUri: fileUri(path.join(base, 'global')),
      globalState: memento(), workspaceState: memento()
    };
    const ran = [];
    const runs = {
      steps,
      run: async (workflow, hash, onUpdate) => {
        ran.push({ workflow, hash });
        const state = { id: 'run-1', status: 'running', nodes: {}, criteria: workflow.criteria };
        onUpdate({ ...state });
        const done = { ...state, status: 'done', nodes: { write: { status: 'done', output: { path: 'notes/summary.md' } } } };
        onUpdate(done);
        return done;
      }
    };
    StudioChatProvider.register(context, runs, workspace);
    assert.ok(commands.has('repositoryManager.studio.newChat') && commands.has('repositoryManager.studio.chatHistory'));
    let receive;
    viewProvider.resolveWebviewView({ webview: { options: {}, html: '', cspSource: 'csp', asWebviewUri: uri => uri, postMessage: async message => { posted.push(message); },
      onDidReceiveMessage: listener => { receive = listener; } } });
    const last = () => posted[posted.length - 1];
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    await receive({ type: 'ready' }); await settle();
    assert.deepEqual(last().models, [], 'no model yet');
    assert.equal(last().modelsLoaded, true);
    assert.equal(last().model, null);
    // The models load (another vendor's too): the menu follows, and the first drafts.
    availableModels.push(lmModel('gpt-4o', 'GPT-4o'), lmModel('claude-sonnet', 'Claude Sonnet'), { ...lmModel('llama', 'Llama'), vendor: 'ollama' });
    modelListeners.forEach(listener => listener()); await settle();
    assert.deepEqual(last().models.map(model => model.selector), ['copilot:gpt-4o', 'copilot:claude-sonnet', 'ollama:llama']);
    assert.equal(last().model, 'copilot:gpt-4o', 'without a dashboard choice, the first model drafts');
    // Opening the menu asks again.
    availableModels.pop();
    await receive({ type: 'refreshModels' }); await settle();
    assert.deepEqual(last().models.map(model => model.selector), ['copilot:gpt-4o', 'copilot:claude-sonnet']);

    await receive({ type: 'setModel', selector: 'copilot:claude-sonnet' });
    lmReplies.push({ reply: 'A plan.', workflow: plan() });
    await receive({ type: 'send', text: 'Summarize my notes into a file' }); await settle();
    assert.equal(lmCalls[lmCalls.length - 1].family, 'claude-sonnet', 'the model picked in the composer drafts');
    const card = last().messages.find(message => message.draft);
    assert.equal(card.draft.status, 'current');
    assert.deepEqual(card.draft.view.steps.map(step => step.id), ['summarize', 'write']);

    await receive({ type: 'edit', operation: { op: 'setNode', id: 'summarize', field: 'model', value: 'copilot:gpt-4o' } }); await settle();
    assert.equal(last().messages.find(message => message.draft).draft.view.steps[0].model, 'copilot:gpt-4o');

    // Save as workflow writes the file; from then on the file is the plan.
    await receive({ type: 'save' }); await settle();
    const file = path.join(workspace, '.repository-manager', 'workflows', 'summarize-notes.workflow.json');
    assert.equal(last().file, '.repository-manager/workflows/summarize-notes.workflow.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nodes[0].model, 'copilot:gpt-4o');
    const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
    edited.title = 'Summarize notes (edited in the diagram)';
    fs.writeFileSync(file, JSON.stringify(edited));
    await receive({ type: 'run' }); await settle();
    assert.equal(ran.length, 1);
    assert.equal(ran[0].workflow.title, 'Summarize notes (edited in the diagram)', 'Run runs the saved file as it is now');
    const run = last().messages.find(message => message.role === 'run');
    assert.equal(run.run.status, 'done');
    assert.deepEqual(run.run.written, ['notes/summary.md']);
    assert.deepEqual(run.run.criteria, ['notes/summary.md holds a summary of the input text']);

    // A proposed change, accepted, is written to the file.
    const changed = { ...edited, criteria: ['Two criteria now', 'and this'] };
    lmReplies.push({ reply: 'Changed.', workflow: changed });
    await receive({ type: 'send', text: 'Add a criterion' }); await settle();
    const proposed = last().messages.filter(message => message.draft && message.draft.status === 'proposed');
    assert.equal(proposed.length, 1);
    assert.match(lmCalls[lmCalls.length - 1].prompt, /edited in the diagram/, 'the change starts from the file');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).criteria.length, 1, 'not written before Accept');
    await receive({ type: 'accept', id: proposed[0].id }); await settle();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).criteria, ['Two criteria now', 'and this']);

    // A plan with problems does not run; the page is told why.
    await receive({ type: 'edit', operation: { op: 'setCriteria', criteria: [] } }); await settle();
    await receive({ type: 'run' }); await settle();
    assert.equal(ran.length, 1);
    assert.match(last().notice, /cannot run yet: criteria/);

    // A plan moved from an agent task runs only in the repository it was made for.
    await receive({ type: 'edit', operation: { op: 'setCriteria', criteria: ['Two criteria now'] } }); await settle();
    viewProvider.conversation.repositoryRoot = path.join(base, 'another-repository');
    await receive({ type: 'run' }); await settle();
    assert.equal(ran.length, 1, 'not run in the wrong repository');
    assert.match(last().notice, /This plan was made for .*another-repository, and the folder open is .*workspace: open that repository/);
    viewProvider.conversation.repositoryRoot = workspace;

    // While a reply is drafted, Chat History does not switch away (the reply would be lost).
    let answer;
    lmReplies.push(() => new Promise(resolve => { answer = resolve; }));
    const pending = viewProvider.receive({ type: 'send', text: 'One more thing' });
    await settle();
    assert.equal(last().busy, 'drafting');
    const before = viewProvider.conversation.id;
    await commands.get('repositoryManager.studio.chatHistory')(); await settle();
    assert.equal(viewProvider.conversation.id, before);
    assert.match(last().notice, /Wait for the current reply or run to finish/);
    answer({ reply: 'Noted.', workflow: null });
    await pending; await settle();
    const saved = await new ChatStore(path.join(base, 'storage', 'studio', 'chats')).load(before);
    assert.ok(saved.messages.some(message => message.text === 'Noted.'), 'the reply was saved to its chat');

    // New Chat starts empty; Chat History reopens the saved one, plan and all.
    await commands.get('repositoryManager.studio.newChat')(); await settle();
    assert.deepEqual(last().messages, []);
    answers.quickPick.push(item => item.label === 'Summarize my notes into a file');
    await commands.get('repositoryManager.studio.chatHistory')(); await settle();
    assert.ok(last().messages.some(message => message.role === 'run'));
    assert.equal(last().file, '.repository-manager/workflows/summarize-notes.workflow.json');

    // Without a folder the view still answers, and says why Run cannot.
    const lone = new StudioChatProvider(context, undefined, undefined);
    let loneReceive; const lonePosted = [];
    lone.resolveWebviewView({ webview: { options: {}, html: '', cspSource: 'csp', asWebviewUri: uri => uri, postMessage: async message => { lonePosted.push(message); }, onDidReceiveMessage: listener => { loneReceive = listener; } } });
    await loneReceive({ type: 'ready' }); await loneReceive({ type: 'run' }); await settle();
    assert.equal(lonePosted[lonePosted.length - 1].folder, false);
    assert.match(lonePosted[lonePosted.length - 1].notice, /Open a folder/);
  }

  // ---- The manifest: the chat is in the Secondary Side Bar (right, as Copilot's), and nothing of
  // ---- the old Agent view is left; that location needs VS Code 1.104.
  {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    const containers = manifest.contributes.viewsContainers;
    assert.deepEqual(containers.secondarySidebar.map(container => container.id), ['repository-manager-studio']);
    assert.deepEqual(manifest.contributes.views['repository-manager-studio'].map(view => view.id), ['repositoryManager.studio.chat']);
    assert.ok(!containers.activitybar.some(container => /agent|studio/.test(container.id)), 'no Activity Bar icon for the Studio');
    assert.deepEqual(manifest.contributes.commands.filter(command => command.command.startsWith('repositoryManager.agent.')), []);
    assert.equal(JSON.stringify(manifest.contributes).includes('repositoryManager.agent.'), false);
    assert.equal(manifest.engines.vscode, '^1.104.0');
  }

  console.log('Studio chat smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(base, { recursive: true, force: true }));
