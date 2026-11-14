/**
 * The Studio Chat view (docs/agent-studio.md, "Phase 2b design: Studio Chat"): a Copilot-like
 * chat in the Studio's Activity Bar container. The person types a goal; the planner answers with
 * a plan card; a later change waits as a diff until it is accepted; Run runs the plan the way Run
 * Workflow… runs a file. The rules live in chatSession.ts; this wires them to VS Code.
 */
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { draftPlan, planProblems } from './chatPlanner';
import { acceptDraft, addDraft, addRun, addUserMessage, ChatError, currentCard, discardDraft, editPlan, history, planView, setPlan } from './chatSession';
import { ChatRun, ChatStore, Conversation, newMessage } from './chatStore';
import { RunState } from './engine';
import { CancelSignal, StepDefinition } from './steps';
import { studioSteps } from './registry';
import { dashboardSelector, listModels, ModelChoice, onModelsChanged, studioModel } from './studioModels';
import { parseSkillSource, StudioSkills, studioSkills } from './githubSkills';
import { SkillSummary } from './skills';
import { readScripts } from '../agent/repositoryScripts';
import { StudioRuns } from './studioCommands';
import { EditOperation, serializeWorkflow } from './workflowEdit';
import { WORKFLOW_EDITOR } from './workflowEditorProvider';
import { Workflow, workflowHash } from './workflow';

export const CHAT_VIEW = 'repositoryManager.studio.chat';
const CURRENT_KEY = 'repositoryManager.studio.currentChat';
const WORKFLOW_FOLDER = path.join('.repository-manager', 'workflows');

type Incoming =
  | { type: 'ready' } | { type: 'send'; text: string } | { type: 'cancel' }
  | { type: 'setModel'; selector: string } | { type: 'accept'; id: string } | { type: 'discard'; id: string }
  | { type: 'edit'; operation: EditOperation } | { type: 'run' } | { type: 'save' } | { type: 'openDiagram' }
  | { type: 'addSkill'; id: string } | { type: 'refreshModels' };

export class StudioChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private conversation?: Conversation;
  private models: ModelChoice[] = [];
  private modelsLoaded = false;
  private busy: 'drafting' | 'running' | undefined;
  private cancelled = false;
  private notice = '';
  private readonly store: ChatStore;
  private readonly steps: Map<string, StepDefinition>;
  private readonly skills: StudioSkills;
  /** Names of the skills seen in listings, by reference, for the plan card's chips. */
  private readonly skillNames = new Map<string, SkillSummary>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly runs: StudioRuns | undefined, private readonly root: string | undefined) {
    this.store = new ChatStore(path.join(context.storageUri?.fsPath ?? context.globalStorageUri.fsPath, 'studio', 'chats'));
    this.steps = runs?.steps ?? studioSteps();
    this.skills = runs?.skills ?? studioSkills(context);
  }

  static register(context: vscode.ExtensionContext, runs: StudioRuns | undefined, root: string | undefined): StudioChatProvider {
    const provider = new StudioChatProvider(context, runs, root);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(CHAT_VIEW, provider, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand('repositoryManager.studio.newChat', () => provider.newChat()),
      vscode.commands.registerCommand('repositoryManager.studio.chatHistory', () => provider.pickChat()),
      vscode.commands.registerCommand('repositoryManager.studio.manageSkillSources', () => provider.manageSkillSources())
    );
    return provider;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const resources = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
    view.webview.options = { enableScripts: true, localResourceRoots: [resources] };
    view.webview.html = chatHtml(
      view.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'studioChat.js')).toString(),
      view.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'studioChat.css')).toString(),
      view.webview.cspSource);
    view.webview.onDidReceiveMessage((message: Incoming) => { void this.receive(message); });
    // Copilot's models load after VS Code starts, and models come and go: the menu follows.
    const changed = onModelsChanged(() => { void this.refreshModels(); });
    if (changed) { this.context.subscriptions.push(changed); }
  }

  /** The models VS Code offers now; the drafting model is set once there is one. */
  private async refreshModels(): Promise<void> {
    this.models = await listModels().catch(() => [] as ModelChoice[]);
    this.modelsLoaded = true;
    if (this.conversation && !this.conversation.model) { this.conversation.model = this.defaultSelector(); }
    this.post();
  }

  async newChat(): Promise<void> {
    if (this.busy) { this.say('Wait for the current reply or run to finish, or stop it.'); return; }
    this.conversation = this.store.create();
    this.conversation.model = this.conversation.model ?? this.defaultSelector();
    await this.context.workspaceState.update(CURRENT_KEY, undefined);
    this.post();
  }

  async pickChat(): Promise<void> {
    // A reply or a run in progress writes to the chat it started in: switching would lose it.
    if (this.busy) { this.say('Wait for the current reply or run to finish, or stop it.'); return; }
    const all = await this.store.list();
    const picked = await vscode.window.showQuickPick(all.slice(0, 100).map(item => ({
      label: item.title, description: item.plan ? `plan: ${item.plan.title}` : '', detail: `${item.updatedAt.slice(0, 16).replace('T', ' ')} · ${item.messages.length} messages`, item
    })), { title: 'Studio Chats', placeHolder: all.length ? 'Open a chat' : 'No chats yet' });
    if (!picked) { return; }
    if (this.busy) { this.say('A reply or run started while choosing: wait for it, then open the chat again.'); return; }
    this.conversation = picked.item;
    await this.context.workspaceState.update(CURRENT_KEY, picked.item.id);
    await this.syncFromFile();
    this.post();
  }

  /** The skill repositories: add one, or remove one (its pinned skills stay cached and keep working). */
  async manageSkillSources(): Promise<void> {
    const sources = this.skills.sources();
    type Item = vscode.QuickPickItem & { source?: string; host?: string };
    // One sign-in per server the sources are on: github.com, and any GitHub Enterprise host.
    const hosts = [...new Set(['github.com', ...sources.filter(source => source.split('/').length === 3).map(source => source.split('/')[0])])];
    const picked = await vscode.window.showQuickPick<Item>([
      { label: '$(add) Add a GitHub repository…' },
      ...sources.map(source => ({ label: `$(trash) Remove ${source}`, source })),
      ...hosts.map(host => ({ label: `$(account) Sign in to ${host}`, description: 'to read private skill repositories', host }))
    ], { title: 'Skill Sources', placeHolder: sources.length ? `Now: ${sources.join(', ')}` : 'No skill repository yet' });
    if (!picked) { return; }
    if (picked.host) {
      this.say(await this.skills.signIn(picked.host) ? `Signed in to ${picked.host}: its private skill repositories can be read.`
        : `Not signed in to ${picked.host}: public skill repositories still work.${picked.host === 'github.com' ? '' : ' If the sign-in did not open after the setup, reload the window and try again.'}`);
      return;
    }
    if (picked.source) {
      await this.skills.removeSource(picked.source);
      this.say(`Removed ${picked.source}. Skills already on a plan keep working from the cache.`);
      return;
    }
    const added = await this.chooseSourcesAdd();
    if (added) { this.say(`Added ${added}: its skills show under + Skill.`); }
  }

  private async chooseSourcesAdd(): Promise<string | undefined> {
    const typed = await vscode.window.showInputBox({
      title: 'Add a skill repository', prompt: 'A repository with skills (folders with a SKILL.md) on GitHub or a GitHub Enterprise server: owner/name, host/owner/name, or its URL.',
      placeHolder: 'eurus-labs/skills', ignoreFocusOut: true,
      validateInput: value => !value.trim() || parseSkillSource(value) ? undefined : 'Write owner/name (or host/owner/name), or paste the repository\'s URL on GitHub or GitHub Enterprise.'
    });
    const source = typed ? parseSkillSource(typed) : undefined;
    if (!source || !await this.skills.ensureTrusted([source])) { return undefined; }
    await this.skills.addSource(source);
    return source;
  }

  private defaultSelector(): string | undefined {
    return dashboardSelector(this.context, this.models) ?? this.models[0]?.selector;
  }

  private async ensureConversation(): Promise<Conversation> {
    if (!this.conversation) {
      const id = this.context.workspaceState.get<string>(CURRENT_KEY);
      this.conversation = (id && await this.store.load(id)) || this.store.create();
      await this.syncFromFile();
    }
    if (!this.conversation.model) { this.conversation.model = this.defaultSelector(); }
    return this.conversation;
  }

  private async receive(message: Incoming): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.models = await listModels().catch(() => []);
          this.modelsLoaded = true;
          await this.cachedSkills();
          await this.ensureConversation();
          this.post();
          return;
        case 'send': return await this.send(message.text);
        case 'cancel': this.cancelled = true; return;
        case 'setModel': {
          const conversation = await this.ensureConversation();
          conversation.model = message.selector || undefined;
          await this.saveConversation();
          this.post();
          return;
        }
        case 'accept': {
          const conversation = await this.ensureConversation();
          acceptDraft(conversation, message.id);
          await this.writeFile();
          await this.saveConversation();
          this.post();
          return;
        }
        case 'discard':
          discardDraft(await this.ensureConversation(), message.id);
          await this.saveConversation();
          this.post();
          return;
        case 'edit': {
          const conversation = await this.ensureConversation();
          await this.syncFromFile();
          editPlan(conversation, message.operation, this.steps);
          await this.writeFile();
          await this.saveConversation();
          this.post();
          return;
        }
        case 'run': return await this.run();
        case 'save': await this.save(); return;
        case 'addSkill': await this.addSkill(message.id); return;
        case 'refreshModels': await this.refreshModels(); return;
        case 'openDiagram': {
          const file = await this.save();
          if (file) { await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), WORKFLOW_EDITOR); }
          return;
        }
      }
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
    }
  }

  private async send(text: string): Promise<void> {
    if (this.busy) { return; }
    if (!text.trim()) { return; }
    const conversation = await this.ensureConversation();
    await this.syncFromFile();
    const earlier = history(conversation);
    addUserMessage(conversation, text);
    this.busy = 'drafting';
    this.cancelled = false;
    this.post();
    // The signal reads the flag the Stop button sets.
    const stopped = () => this.cancelled;
    const signal: CancelSignal = { get cancelled() { return stopped(); } };
    try {
      const skills = await this.cachedSkills();
      const scripts = this.root ? Object.keys(readScripts(this.root)) : undefined;
      const draft = await draftPlan(studioModel(this.context), this.steps, { message: text, current: conversation.plan, history: earlier, model: conversation.model, skills, scripts }, signal);
      addDraft(conversation, draft);
      if (currentCard(conversation)?.draft?.workflow === draft.workflow) { await this.writeFile(); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      conversation.messages.push(newMessage({ role: 'error', text: message === 'Cancelled' ? 'Stopped.' : message }));
    } finally {
      this.busy = undefined;
      await this.saveConversation();
      this.post();
    }
  }

  private async run(): Promise<void> {
    if (this.busy) { return; }
    if (!this.runs || !this.root) { this.say('Open a folder to run a plan: it reads and writes files there.'); return; }
    const conversation = await this.ensureConversation();
    await this.syncFromFile();
    const plan = conversation.plan;
    if (!plan) { this.say('There is no plan to run yet.'); return; }
    const problems = planProblems(plan, this.steps);
    if (problems.length) { this.say(`The plan cannot run yet: ${problems[0].where}: ${problems[0].message}`); return; }
    if (conversation.repositoryRoot && path.resolve(conversation.repositoryRoot) !== path.resolve(this.root)) {
      this.say(`This plan was made for ${conversation.repositoryRoot}, and the folder open is ${this.root}: open that repository (as the first folder) to run it.`);
      return;
    }
    this.busy = 'running';
    this.post();
    let run: ChatRun | undefined;
    const update = (state: RunState) => {
      const written = Object.values(state.nodes).map(node => node.output)
        .filter((output): output is { path: string } => Boolean(output) && typeof (output as { path?: unknown }).path === 'string').map(output => output.path);
      if (!run) {
        run = { id: state.id, status: state.status, criteria: state.criteria };
        addRun(conversation, run, `Run of "${plan.title}"`);
      }
      Object.assign(run, { status: state.status, error: state.error, written });
      void this.saveConversation().catch(() => undefined);
      this.post();
    };
    try {
      const final = await this.runs.run(plan, workflowHash(serializeWorkflow(plan)), update);
      if (!final) { this.say('The run did not start.'); }
    } finally {
      this.busy = undefined;
      await this.saveConversation();
      this.post();
    }
  }

  /** Skills listed before (no network): offered to the planner and named on the card. */
  private async cachedSkills(): Promise<SkillSummary[]> {
    const cached = await this.skills.cached().catch(() => [] as SkillSummary[]);
    for (const skill of cached) { this.skillNames.set(skill.ref, skill); }
    return cached;
  }

  /** "+ Skill" on a step: the skills of the trusted sources, newest commit; the pick is pinned. */
  private async addSkill(id: string): Promise<void> {
    const conversation = await this.ensureConversation();
    await this.syncFromFile();
    const node = conversation.plan?.nodes.find(candidate => candidate.id === id);
    if (!node) { this.say('That step is no longer in the plan.'); return; }
    const sources = await this.chooseSources();
    if (!sources?.length) { return; }
    if (!await this.skills.ensureTrusted(sources)) { return; }
    const listed: SkillSummary[] = [];
    const failed: string[] = [];
    for (const source of sources) {
      try { listed.push(...(await this.skills.index(source)).skills); } catch (error) { failed.push(`${source}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const skill of listed) { this.skillNames.set(skill.ref, skill); }
    if (!listed.length) { this.say(failed.length ? `No skills could be listed. ${failed.join(' ')}` : `${sources.join(', ')} has no SKILL.md.`); return; }
    const present = new Set(node.skills ?? []);
    const picked = await vscode.window.showQuickPick(listed.filter(skill => !present.has(skill.ref)).map(skill => ({
      label: skill.name, description: skill.ref.replace(/^github:/, '').replace(/@([0-9a-f]{7})[0-9a-f]+$/, '@$1'),
      detail: `${skill.description}${skill.usesScripts ? ' · uses scripts: not run here' : ''}`, skill
    })), { title: `Add a skill to "${node.title ?? node.id}"`, placeHolder: failed.length ? `Some sources could not be read: ${failed.join(' ')}` : 'Pinned to the commit listed now', matchOnDetail: true });
    if (!picked) { return; }
    editPlan(conversation, { op: 'setSkills', id, skills: [...present, picked.skill.ref] }, this.steps);
    await this.writeFile();
    await this.saveConversation();
    this.post();
  }

  /**
   * Where the skills come from: one source, all of them, or a GitHub repository added now (kept in
   * the setting). Undefined: cancelled.
   */
  private async chooseSources(): Promise<string[] | undefined> {
    const sources = this.skills.sources();
    type Item = vscode.QuickPickItem & { sources?: string[]; add?: boolean };
    const items: Item[] = [
      ...sources.map(source => ({ label: source, description: source.split('/').length === 3 ? 'GitHub Enterprise' : 'github.com', sources: [source] })),
      ...(sources.length > 1 ? [{ label: 'All sources', description: `${sources.length} repositories`, sources }] : []),
      { label: '$(add) Add a GitHub repository…', description: 'owner/name or its URL', add: true }
    ];
    const picked = await vscode.window.showQuickPick<Item>(items, { title: 'Skills from', placeHolder: sources.length ? 'Choose where the skills come from' : 'No skill repository yet: add one' });
    if (!picked) { return undefined; }
    if (!picked.add) { return picked.sources; }
    const source = await this.chooseSourcesAdd();
    return source ? [source] : undefined;
  }

  /** Saves the plan as a workflow file in the folder; from then on the file is the plan. */
  private async save(): Promise<string | undefined> {
    if (!this.root) { this.say('Open a folder to save a plan as a workflow.'); return undefined; }
    const conversation = await this.ensureConversation();
    if (!conversation.plan) { this.say('There is no plan to save yet.'); return undefined; }
    if (conversation.file) { await this.syncFromFile(); await this.writeFile(); return path.join(this.root, conversation.file); }
    const relative = path.join(WORKFLOW_FOLDER, `${conversation.plan.id || 'plan'}.workflow.json`);
    const target = path.join(this.root, relative);
    const exists = await fs.stat(target).then(() => true, () => false);
    if (exists) {
      const replace = 'Replace';
      const answer = await vscode.window.showWarningMessage(`${relative} exists. Replace it with this plan?`, { modal: true }, replace);
      if (answer !== replace) { return undefined; }
    }
    conversation.file = relative.split(path.sep).join('/');
    await this.writeFile();
    await this.saveConversation();
    this.post();
    return target;
  }

  /** Once saved, the file is the plan: an edit in the diagram or the JSON shows here. */
  private async syncFromFile(): Promise<void> {
    const conversation = this.conversation;
    if (!conversation?.file || !this.root) { return; }
    const target = path.join(this.root, conversation.file);
    const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === target);
    const text = open ? open.getText() : await fs.readFile(target, 'utf8').catch(() => undefined);
    if (text === undefined) { conversation.file = undefined; return; } // deleted: the chat keeps its copy
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new ChatError(`${conversation.file} is not valid JSON now. Fix it, or open it as JSON.`); }
    if (serializeWorkflow(parsed as Workflow) !== serializeWorkflow(conversation.plan ?? ({} as Workflow))) { setPlan(conversation, parsed as Workflow, this.steps); }
  }

  /** Writes the plan to its saved file, through the open document when there is one (undo works). */
  private async writeFile(): Promise<void> {
    const conversation = this.conversation;
    if (!conversation?.file || !conversation.plan || !this.root) { return; }
    const target = path.join(this.root, conversation.file);
    const text = serializeWorkflow(conversation.plan);
    const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === target);
    if (open) {
      if (open.getText() === text) { return; }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(open.uri, new vscode.Range(0, 0, open.lineCount, 0), text);
      await vscode.workspace.applyEdit(edit);
      await open.save();
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }

  private async saveConversation(): Promise<void> {
    if (!this.conversation || !this.conversation.messages.length) { return; }
    await this.store.save(this.conversation);
    await this.context.workspaceState.update(CURRENT_KEY, this.conversation.id);
  }

  private say(text: string): void {
    this.notice = text;
    this.post();
  }

  private post(): void {
    if (!this.view || !this.conversation) { return; }
    const conversation = this.conversation;
    const notice = this.notice;
    this.notice = '';
    void this.view.webview.postMessage({
      type: 'state', notice, busy: this.busy ?? null, folder: Boolean(this.root),
      models: this.models.map(model => ({ selector: model.selector, name: model.name, vendor: model.vendor })), modelsLoaded: this.modelsLoaded,
      skills: Object.fromEntries([...this.skillNames.values()].map(skill => [skill.ref, { name: skill.name, usesScripts: skill.usesScripts }])),
      model: conversation.model ?? null, file: conversation.file ?? null, title: conversation.title,
      messages: conversation.messages.map(message => ({
        id: message.id, role: message.role, text: message.text, model: message.model ?? null, run: message.run ?? null,
        draft: message.draft ? {
          status: message.draft.status, problems: message.draft.problems, diff: message.draft.diff ?? null,
          view: planView(message.draft.workflow, this.steps)
        } : null
      }))
    });
  }
}

function chatHtml(script: string, style: string, cspSource: string): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
  <title>Studio Chat</title>
  <link rel="stylesheet" href="${style}">
</head>
<body>
  <main id="thread" aria-live="polite"></main>
  <div id="notice" role="alert" hidden></div>
  <form id="composer" autocomplete="off">
    <textarea id="message" rows="3" placeholder="Describe what you want done…" aria-label="Message"></textarea>
    <div class="composer-bar">
      <label class="model-label">Model <select id="model" aria-label="Model for drafting the plan"></select></label>
      <button type="submit" id="send" class="primary">Send</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
