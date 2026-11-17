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
    showQuickPick: async items => { const pick = answers.quickPick.shift(); return pick ? items.find(pick) : undefined; },
    showSaveDialog: async () => answers.save?.shift()
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
const { listModels, resolveSelector } = out('studioModels.js');
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
    // The run returned (a notification the person leaves open no longer holds it): the chat is unlocked.
    assert.equal(last().busy, null, 'the chat stayed locked after the run');
    posted.length = 0;
    answers.quickPick.push(() => false);
    await commands.get('repositoryManager.studio.chatHistory')(); await settle();
    assert.ok(!posted.some(message => /Wait for the current reply/.test(message.notice || '')), 'Chat History was refused after the run');

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

    // Export… writes the accepted plan to share, with requires computed by the same Export; the
    // plan's file is not touched. Cancelling the save dialog writes nothing.
    const exportedPlan = path.join(base, 'shared', 'summarize-notes.workflow.json');
    fs.mkdirSync(path.dirname(exportedPlan), { recursive: true });
    answers.save = [{ fsPath: exportedPlan }];
    await receive({ type: 'export' }); await settle();
    const sharedPlan = JSON.parse(fs.readFileSync(exportedPlan, 'utf8'));
    assert.deepEqual(sharedPlan.criteria, ['Two criteria now', 'and this'], 'Export did not take the accepted plan');
    assert.deepEqual([sharedPlan.requires.steps, sharedPlan.requires.scripts], [['file.write', 'prompt'], []]);
    assert.match(sharedPlan.requires.extension, /^>=\d+\.\d+\.\d+$/);
    assert.match(last().notice, /^Exported to .*summarize-notes\.workflow\.json\./);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).requires, undefined, 'Export wrote into the plan\'s file');
    fs.rmSync(exportedPlan);
    answers.save = [undefined];
    await receive({ type: 'export' }); await settle();
    assert.equal(fs.existsSync(exportedPlan), false);

    // A plan with problems does not run; the page is told why.
    await receive({ type: 'edit', operation: { op: 'setCriteria', criteria: [] } }); await settle();
    await receive({ type: 'run' }); await settle();
    assert.equal(ran.length, 1);
    assert.match(last().notice, /cannot run yet: criteria/);
    // Nor is it exported.
    answers.save = [{ fsPath: exportedPlan }];
    await receive({ type: 'export' }); await settle();
    assert.match(last().notice, /cannot be exported yet: criteria/);
    assert.equal(fs.existsSync(exportedPlan), false);
    answers.save = [];

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

  // ---- A run's progress in the chat (plan 3): steps and activity from the log entries the run emits, in
  // ---- the order appended; late entries; throttled posts; sparse saves; Stop.
  {
    const memento = () => { const values = new Map(); return { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } }; };
    const context = {
      subscriptions: [], extensionUri: fileUri(path.resolve(__dirname, '../..')),
      storageUri: fileUri(path.join(base, 'storage-progress')), globalStorageUri: fileUri(path.join(base, 'global-progress')),
      globalState: memento(), workspaceState: memento()
    };
    let scenario;
    const options = [];
    const runs = { steps, run: async (workflow, hash, onUpdate, runOptions) => { options.push(runOptions); return await scenario(workflow, onUpdate, runOptions); } };
    const provider = new StudioChatProvider(context, runs, workspace);
    const posted = [];
    // A post is copied when it is made, as VS Code does: later changes to the run do not rewrite it.
    provider.resolveWebviewView({ webview: { options: {}, html: '', cspSource: 'csp', asWebviewUri: uri => uri, postMessage: async message => { posted.push(JSON.parse(JSON.stringify(message))); },
      onDidReceiveMessage: () => undefined } });
    const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
    const last = () => posted[posted.length - 1];
    const runCard = message => (message || last()).messages.filter(item => item.role === 'run').pop()?.run;
    const chats = () => new ChatStore(path.join(base, 'storage-progress', 'studio', 'chats'));
    await provider.receive({ type: 'ready' }); await settle();
    lmReplies.push({ reply: 'A plan.', workflow: plan() });
    await provider.receive({ type: 'send', text: 'Summarize my notes into a file' }); await settle();
    assert.equal(last().messages.find(message => message.draft).draft.status, 'current');

    // Saves are counted at ChatStore.save.
    const realSave = ChatStore.prototype.save;
    let saves = 0;
    ChatStore.prototype.save = function (...args) { saves++; return realSave.apply(this, args); };
    const at = seconds => new Date(Date.now() - seconds * 1000).toISOString();
    const runWith = tools => async (workflow, onUpdate, { onLog }) => {
      const state = { id: 'run-p', status: 'running', nodes: { summarize: { status: 'pending' }, write: { status: 'pending' } }, criteria: workflow.criteria };
      onUpdate({ ...state });
      onLog({ at: at(30), type: 'node', node: 'summarize', step: 'prompt', runs: 1 });
      onLog({ at: at(29), type: 'model', node: 'summarize', model: 'gpt-4o', inputTokens: 900, outputTokens: 40 });
      for (let index = 0; index < tools; index++) { onLog({ at: at(28), type: 'tool', node: 'summarize', ok: true, name: 'read_file', note: `file${index}.ts:1-40` }); }
      onLog({ at: at(20), type: 'check', node: 'summarize', script: 'test', passed: true, exitCode: 0 });
      onLog({ at: at(19), type: 'done', node: 'summarize' });
      // Late: a step's own log call is not awaited, so its entry may come after the engine's done.
      onLog({ at: at(19), type: 'tool', node: 'summarize', ok: true, name: 'read_file', note: 'late.ts:1-9' });
      state.nodes.summarize = { status: 'done' };
      onLog({ at: at(18), type: 'node', node: 'write', step: 'file.write', runs: 1 });
      onLog({ at: at(17), type: 'done', node: 'write' });
      onLog({ at: at(17), type: 'finish', status: 'done' });
      // Late after the run's finish: the finished step stays done.
      onLog({ at: at(17), type: 'model', node: 'write', model: 'gpt-4o' });
      const done = { ...state, status: 'done', nodes: { summarize: { status: 'done' }, write: { status: 'done', output: { path: 'notes/summary.md' } } } };
      onUpdate(done);
      return done;
    };
    // The second run's card only: the posts before it was added still hold the first run's.
    const outcomes = message => message.messages.filter(item => item.role === 'run').length === 2 ? (runCard(message)?.steps ?? []).map(step => step.outcome).join(',') : '';

    // Without tool calls, then with 20 in one step: the same number of saves (step changes and the run end).
    scenario = runWith(0);
    posted.length = 0; saves = 0;
    await provider.receive({ type: 'run' }); await settle(300);
    const savesWithout = saves;
    assert.equal(last().busy, null, 'the chat stayed locked');
    scenario = runWith(20);
    posted.length = 0; saves = 0;
    await provider.receive({ type: 'run' }); await settle(300);
    assert.equal(saves, savesWithout, `20 tool entries changed the number of saves (${savesWithout} -> ${saves})`);
    assert.ok(saves <= 8, `a run saved ${saves} times`);

    // Steps went pending -> running -> done, in run order; each change was posted at once.
    const seen = [...new Set(posted.map(outcomes).filter(Boolean))];
    assert.deepEqual(seen, ['running,pending', 'done,pending', 'done,running', 'done,done'], 'the steps did not go pending, running, done in order');
    const finalRun = runCard();
    assert.deepEqual(finalRun.steps.map(step => [step.id, step.outcome]), [['summarize', 'done'], ['write', 'done']]);
    assert.equal(finalRun.status, 'done');
    // A late entry never flipped a finished step: after summarize was done, no post shows it running again.
    const sequence = posted.map(outcomes).filter(Boolean);
    assert.ok(!sequence.slice(sequence.indexOf('done,pending')).some(value => value.startsWith('running')), 'a finished step went back to running');
    // Activity lines, in order, with the late ones kept.
    const texts = finalRun.activity.map(line => line.text);
    assert.equal(texts[0], 'Model gpt-4o answered (900 in, 40 out)');
    assert.equal(texts[1], 'read_file file0.ts:1-40');
    assert.equal(texts[20], 'read_file file19.ts:1-40');
    assert.deepEqual(texts.slice(21), ['Check test passed (exit 0)', 'read_file late.ts:1-9', 'Model gpt-4o answered']);
    assert.ok(finalRun.activity.every(line => typeof line.at === 'string' && typeof line.node === 'string'));
    // The running step carried its start time for the page's clock.
    const midRun = posted.map(message => runCard(message)).find(run => run?.steps?.[0]?.outcome === 'running');
    assert.match(midRun.steps[0].since, /^\d{4}-\d\d-\d\dT/);
    // The saved chat keeps the steps and the lines.
    const stored = await chats().load(provider.conversation.id);
    const savedRun = stored.messages.filter(message => message.role === 'run').pop().run;
    assert.deepEqual(savedRun.steps.map(step => step.outcome), ['done', 'done']);
    assert.equal(savedRun.activity.length, 24);
    assert.equal(options[options.length - 1].signal.cancelled, false, 'a run starts not cancelled');

    // Posts are throttled: a burst of 230 activity lines inside one step posts a few times, not 230.
    scenario = async (workflow, onUpdate, { onLog }) => {
      const state = { id: 'run-burst', status: 'running', nodes: {}, criteria: workflow.criteria };
      onUpdate({ ...state });
      onLog({ at: at(5), type: 'node', node: 'summarize' });
      await settle(300);
      posted.length = 0;
      for (let index = 0; index < 230; index++) { onLog({ at: at(4), type: 'tool', node: 'summarize', ok: true, name: 'search', note: `q${index}` }); }
      await settle(400);
      assert.ok(posted.length >= 1 && posted.length <= 3, `230 lines posted ${posted.length} times`);
      assert.equal(runCard().activity.length, 200, 'the card keeps up to 200 lines while running');
      assert.equal(runCard().activity[199].text, 'search q229', 'the trailing post did not carry the last line');
      const done = { ...state, status: 'done' };
      onUpdate(done);
      return done;
    };
    posted.length = 0;
    await provider.receive({ type: 'run' }); await settle(50);
    // An assertion inside the scripted run ends the run with a notice: none is allowed.
    assert.deepEqual(posted.map(message => message.notice).filter(Boolean), []);
    const burstSaved = (await chats().load(provider.conversation.id)).messages.filter(message => message.role === 'run').pop().run;
    assert.equal(burstSaved.activity.length, 50, 'the saved chat keeps the last 50 lines');
    assert.equal(burstSaved.activity[49].text, 'search q229');

    // An entry that arrives after the run returned changes nothing.
    let leaked;
    scenario = async (workflow, onUpdate, { onLog }) => {
      leaked = onLog;
      const done = { id: 'run-leak', status: 'done', nodes: {}, criteria: workflow.criteria };
      onLog({ at: at(3), type: 'node', node: 'summarize' });
      onUpdate(done);
      return done;
    };
    await provider.receive({ type: 'run' }); await settle(30);
    posted.length = 0;
    leaked({ at: at(1), type: 'tool', node: 'summarize', ok: true, name: 'late', note: 'after the run' });
    await settle(300);
    assert.equal(posted.length, 0, 'an entry after the run changed the card');

    // Stop: `cancel` while running cancels the signal given to runs.run; the run ends stopped; the chat unlocks.
    let seenCancelled = false;
    scenario = async (workflow, onUpdate, { onLog, signal }) => {
      const state = { id: 'run-stop', status: 'running', nodes: {}, criteria: workflow.criteria };
      onUpdate({ ...state });
      onLog({ at: at(2), type: 'node', node: 'summarize' });
      while (!signal.cancelled) { await settle(5); }
      seenCancelled = true;
      onLog({ at: at(0), type: 'finish', status: 'stopped', reason: 'Cancelled' });
      const stoppedState = { ...state, status: 'stopped', error: 'Cancelled' };
      onUpdate(stoppedState);
      return stoppedState;
    };
    await provider.receive({ type: 'cancel' }); // nothing is running: it must not carry over to the next run
    posted.length = 0;
    const running = provider.receive({ type: 'run' });
    await settle(60);
    assert.equal(last().busy, 'running');
    assert.equal(last().stopping, false, 'a cancel with nothing running carried over to the next run');
    posted.length = 0;
    await provider.receive({ type: 'cancel' });
    assert.equal(last().stopping, true, 'the page was not told the run is stopping');
    await running; await settle(30);
    assert.equal(seenCancelled, true, 'cancel did not reach the signal given to runs.run');
    assert.equal(last().busy, null, 'the chat stayed locked after Stop');
    assert.equal(last().stopping, false);
    assert.deepEqual([runCard().status, runCard().steps.map(step => step.outcome)], ['stopped', ['stopped', 'pending']]);
    ChatStore.prototype.save = realSave;
  }

  // ---- The model menu as a person saw it (2026-11-13): asked with no vendor, VS Code listed only other
  // ---- vendors' models, and one without a name or family showed as an empty entry.
  {
    const saved = fakeVscode.lm.selectChatModels;
    const custom = [
      { ...lmModel('auto', 'Auto'), vendor: 'copilotcli' },
      { id: 'org/custom:latest', name: '', family: '', vendor: 'customendpoint', maxInputTokens: 1000 },
      { ...lmModel('gemini-4-argon', ''), vendor: 'customendpoint' }
    ];
    const copilot = [lmModel('claude-haiku', 'Claude Haiku'), lmModel('gpt-4o', 'GPT-4o')];
    fakeVscode.lm.selectChatModels = async selector => selector && selector.vendor === 'copilot' ? copilot : custom;
    const models = await listModels();
    assert.deepEqual(models.map(model => [model.selector, model.name]), [
      ['copilot:claude-haiku', 'Claude Haiku'], ['copilot:gpt-4o', 'GPT-4o'],
      ['copilotcli:auto', 'Auto'], ['customendpoint:org/custom:latest', 'org/custom:latest'], ['customendpoint:gemini-4-argon', 'gemini-4-argon']
    ], 'Copilot\'s models first; a model with no name or family is named by its id');
    assert.equal(resolveSelector('customendpoint:org/custom:latest', models).id, 'org/custom:latest');
    // A selector by id is a valid workflow model.
    const flow = plan({ defaults: { model: 'customendpoint:org/custom:latest' } });
    assert.deepEqual(validateWorkflow({ schema: 'repository-manager/workflow@1', id: 'x', version: '1', ...flow }, steps), []);
    // A vendor whose listing fails does not empty the menu.
    fakeVscode.lm.selectChatModels = async selector => { if (!selector.vendor) { throw new Error('a provider failed'); } return copilot; };
    assert.deepEqual((await listModels()).map(model => model.selector), ['copilot:claude-haiku', 'copilot:gpt-4o']);
    fakeVscode.lm.selectChatModels = saved;
  }

  // ---- The manifest: the chat is in the Secondary Side Bar (right, as Copilot's), and nothing of
  // ---- the old Agent view is left; that location needs VS Code 1.104.
  {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    const containers = manifest.contributes.viewsContainers;
    assert.deepEqual(containers.secondarySidebar.map(container => container.id), ['repository-manager-studio']);
    // Chat first; the Runs view (phase 3) next to it.
    assert.deepEqual(manifest.contributes.views['repository-manager-studio'].map(view => view.id), ['repositoryManager.studio.chat', 'repositoryManager.studio.runs']);
    assert.ok(!containers.activitybar.some(container => /agent|studio/.test(container.id)), 'no Activity Bar icon for the Studio');
    assert.deepEqual(manifest.contributes.commands.filter(command => command.command.startsWith('repositoryManager.agent.')), []);
    assert.equal(JSON.stringify(manifest.contributes).includes('repositoryManager.agent.'), false);
    assert.equal(manifest.engines.vscode, '^1.104.0');
  }

  console.log('Studio chat smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(base, { recursive: true, force: true }));
