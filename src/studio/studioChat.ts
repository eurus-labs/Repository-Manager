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
import { fileURLToPath } from 'url';
import { draftPlan, planProblems } from './chatPlanner';
import { acceptDraft, addDraft, addRun, addUserMessage, ChatError, currentCard, discardDraft, editPlan, history, planView, setPlan } from './chatSession';
import { ChatMessage, ChatRun, ChatRunActivity, ChatRunStep, ChatStore, Conversation, newMessage } from './chatStore';
import { acceptEntry, Attachment, attachedLine, PreparedItem, prepareAttachments } from './chatAttachments';
import { gitIgnored, insideMaps } from './folderMap';
import { RunLogEntry, RunState } from './engine';
import { activityLine, runTimeline, stepOutcome } from './runsReport';
import { CancelSignal, StepDefinition, StudioModel } from './steps';
import { studioSteps } from './registry';
import { ChosenModelRefused, dashboardSelector, listModels, ModelChoice, onModelsChanged, studioModel } from './studioModels';
import { parseSkillSource, StudioSkills, studioSkills } from './githubSkills';
import { SkillSummary } from './skills';
import { SkillScriptFiles, scriptsNote } from './skillScripts';
import { readScripts } from '../agent/repositoryScripts';
import { StudioRuns } from './studioCommands';
import { EditOperation, serializeWorkflow } from './workflowEdit';
import { WORKFLOW_EDITOR } from './workflowEditorProvider';
import { runOrder, Workflow, workflowHash } from './workflow';
import { exportWorkflow } from './sharing';
import * as os from 'os';

export const CHAT_VIEW = 'repositoryManager.studio.chat';
const CURRENT_KEY = 'repositoryManager.studio.currentChat';
const WORKFLOW_FOLDER = path.join('.repository-manager', 'workflows');
/** The page is sent at most this often while a run writes its log (a trailing post follows). */
const POST_INTERVAL_MS = 250;
/** Activity lines kept on the card while the run goes, and in the saved chat. */
const LIVE_ACTIVITY = 200;
const SAVED_ACTIVITY = 50;

/** What the chat keeps of the run in progress: the log entries seen, and what the card shows from them. */
interface LiveRun {
  run?: ChatRun;
  plan: Workflow;
  state?: RunState;
  /** In the order they were appended: the order `runTimeline` reads. */
  entries: RunLogEntry[];
  activity: ChatRunActivity[];
  steps?: ChatRunStep[];
  /** When each step last started, for the page's clock. */
  since: Map<string, string>;
  signature: string;
}

type Incoming =
  | { type: 'ready' } | { type: 'send'; text: string } | { type: 'cancel' }
  | { type: 'setModel'; selector: string } | { type: 'accept'; id: string } | { type: 'discard'; id: string }
  | { type: 'edit'; operation: EditOperation } | { type: 'run' } | { type: 'save' } | { type: 'openDiagram' }
  | { type: 'addSkill'; id: string } | { type: 'refreshModels' } | { type: 'export' }
  | { type: 'attach'; uris: string[] } | { type: 'pickAttachments' } | { type: 'detach'; path: string } | { type: 'openMap'; path: string };

export class StudioChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private conversation?: Conversation;
  private models: ModelChoice[] = [];
  private modelsLoaded = false;
  /** The conversation whose model the chat filled in (not chosen): a refusal moves on instead of stopping. */
  private defaultedFor: string | undefined;
  private busy: 'drafting' | 'running' | undefined;
  private cancelled = false;
  private notice = '';
  /** What the send in progress is doing before the plan's call ("Updating the map of docs/req…"). */
  private progress = '';
  /** How each chip went at the last send, by conversation and path. */
  private readonly outcomes = new Map<string, Map<string, PreparedItem>>();
  private live?: LiveRun;
  private lastPost = 0;
  private postTimer?: ReturnType<typeof setTimeout>;
  private readonly store: ChatStore;
  private readonly steps: Map<string, StepDefinition>;
  private readonly skills: StudioSkills;
  /** Names of the skills seen in listings, by reference, for the plan card's chips. */
  private readonly skillNames = new Map<string, SkillSummary>();
  /** Where a code step runs skill scripts now; null until the engine probe (up to 5 s) answered. */
  private scriptMode: 'container' | 'direct' | 'off' | null = null;
  private scriptModeAt = 0;
  /** What loading a skill showed about its script files (none, or why unavailable); `at` lets a failed download be tried again. */
  private readonly scriptFiles = new Map<string, SkillScriptFiles & { at: number }>();
  private readonly scriptFilesAsked = new Set<string>();

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
    this.models = await listModels(this.context).catch(() => [] as ModelChoice[]);
    this.modelsLoaded = true;
    if (this.conversation && !this.conversation.model) { this.conversation.model = this.defaultSelector(); this.defaultedFor = this.conversation.id; }
    this.post();
  }

  async newChat(): Promise<void> {
    if (this.busy) { this.say('Wait for the current reply or run to finish, or stop it.'); return; }
    this.conversation = this.store.create();
    if (!this.conversation.model) { this.conversation.model = this.defaultSelector(); this.defaultedFor = this.conversation.id; }
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
    if (!this.conversation.model) { this.conversation.model = this.defaultSelector(); this.defaultedFor = this.conversation.id; }
    return this.conversation;
  }

  private async receive(message: Incoming): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.models = await listModels(this.context).catch(() => []);
          this.modelsLoaded = true;
          await this.cachedSkills();
          await this.ensureConversation();
          this.post();
          return;
        case 'send': return await this.send(message.text);
        case 'cancel':
          if (!this.busy) { return; }
          this.cancelled = true;
          // A run stops where its step next looks: the page says it is stopping.
          if (this.busy === 'running') { this.post(); }
          return;
        case 'setModel': {
          const conversation = await this.ensureConversation();
          conversation.model = message.selector || undefined;
          this.defaultedFor = undefined;
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
        case 'export': await this.exportPlan(); return;
        case 'addSkill': await this.addSkill(message.id); return;
        case 'refreshModels': await this.refreshModels(); return;
        case 'attach': return await this.attach(message.uris);
        case 'pickAttachments': return await this.pickAttachments();
        case 'detach': return await this.detach(message.path);
        case 'openMap': return await this.openMap(message.path);
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
    const userMessage = addUserMessage(conversation, text);
    this.busy = 'drafting';
    this.cancelled = false;
    this.progress = '';
    this.post();
    // The signal reads the flag the Stop button sets.
    const stopped = () => this.cancelled;
    const signal: CancelSignal = { get cancelled() { return stopped(); } };
    try {
      const skills = await this.cachedSkills();
      const scripts = this.root ? Object.keys(readScripts(this.root)) : undefined;
      const model = studioModel(this.context);
      // A model the chat filled in is not a choice: when it refuses, the next usable model answers.
      const selector = this.defaultedFor === conversation.id ? undefined : conversation.model;
      const attachments = await this.readAttachments(conversation, userMessage, model, signal, selector);
      const draft = await draftPlan(model, this.steps, { message: text, current: conversation.plan, history: earlier, model: selector, skills, scripts, scriptsOff: this.scriptMode === 'off', ...(attachments ? { attachments } : {}) }, signal);
      addDraft(conversation, draft);
      if (currentCard(conversation)?.draft?.workflow === draft.workflow) { await this.writeFile(); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The model the person chose was refused and is marked: it leaves the menu, and nothing is retried.
      if (error instanceof ChosenModelRefused && conversation.model === error.selector) { conversation.model = undefined; }
      conversation.messages.push(newMessage({ role: 'error', text: message === 'Cancelled' ? 'Stopped.' : message }));
    } finally {
      this.busy = undefined;
      this.progress = '';
      await this.dropUnusableModels(conversation);
      await this.saveConversation();
      this.post();
    }
  }

  /** A model refused during this send leaves the menu; a model the chat filled in is replaced. */
  private async dropUnusableModels(conversation: Conversation): Promise<void> {
    const listed = await listModels(this.context).catch(() => undefined);
    if (!listed) { return; }
    this.models = listed;
    const offered = (selector: string | undefined) => listed.some(model => model.selector === selector);
    if (conversation.model && this.defaultedFor === conversation.id && !offered(conversation.model)) { conversation.model = this.defaultSelector(); }
  }

  /**
   * What is attached, read again at this send (what the editor shows), with the folder maps brought up to
   * date first. Records on the message what went with it: paths, counts and outcomes, never file text.
   */
  private async readAttachments(conversation: Conversation, message: ChatMessage, model: StudioModel, signal: CancelSignal, selector: string | undefined): Promise<string | undefined> {
    const chips = conversation.attachments ?? [];
    if (!chips.length || !this.root) { return undefined; }
    const root = this.root;
    const limit = await model.inputLimit?.(selector).catch(() => undefined);
    const prepared = await prepareAttachments(chips, {
      root,
      openText: absolute => this.documentAt(absolute)?.getText(),
      isDirty: absolute => Boolean(this.documentAt(absolute)?.isDirty),
      ignored: relative => gitIgnored(root, relative),
      complete: async prompt => (await model.complete(prompt, signal, selector)).text,
      signal, inputLimit: limit,
      progress: text => { this.progress = text; this.post(); }
    });
    const byPath = new Map<string, PreparedItem>();
    for (const item of prepared.items) {
      byPath.set(item.path, item);
      const chip = chips.find(candidate => candidate.path === item.path);
      if (chip && item.kind === 'file') { if (item.ignored) { chip.ignored = true; } else { delete chip.ignored; } }
    }
    this.outcomes.set(conversation.id, byPath);
    message.attached = prepared.items.map(item => ({ path: item.path, kind: item.kind, sent: item.sent, ...(item.map ? { map: item.map } : {}) }));
    if (prepared.notes.length) { this.notice = prepared.notes.join(' '); }
    return prepared.text;
  }

  private documentAt(absolute: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(document => document.uri.fsPath === absolute);
  }

  /** The entries the page dropped (URI lists in the data types VS Code uses): parsed here, never trusted. */
  private async attach(uris: string[]): Promise<void> {
    const entries: Array<{ scheme: string; fsPath: string }> = [];
    const refusals: string[] = [];
    for (const raw of Array.isArray(uris) ? uris.filter(item => typeof item === 'string') : []) {
      for (const line of raw.split(/\r?\n/).map(item => item.trim()).filter(item => item && !item.startsWith('#'))) {
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(line)?.[1]?.toLowerCase() ?? '';
        if (scheme !== 'file') { refusals.push(`Not added: ${line.slice(0, 80)} is not a file on this machine.`); continue; }
        try { entries.push({ scheme, fsPath: fileURLToPath(line) }); } catch { refusals.push(`Not added: ${line.slice(0, 80)} is not a valid file address.`); }
      }
    }
    await this.addEntries(entries, refusals);
  }

  /** Add…: Files… or Folder…, then the editor's own dialog (one dialog for both shows only folders on Windows and Linux). */
  private async pickAttachments(): Promise<void> {
    if (this.busy) { this.say('Wait for the current reply or run to finish, or stop it, before adding files.'); return; }
    if (!this.root) { this.say('Open a folder to attach files and folders: they are read from it.'); return; }
    const choice = await vscode.window.showQuickPick([{ label: 'Files…', folders: false }, { label: 'Folder…', folders: true }], { title: 'Add to the chat', placeHolder: 'Attach files or a folder of this workspace' });
    if (!choice) { return; }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: !choice.folders, canSelectFolders: choice.folders, canSelectMany: !choice.folders,
      defaultUri: vscode.Uri.file(this.root), openLabel: 'Attach', title: choice.folders ? 'Attach a folder' : 'Attach files'
    });
    if (!picked?.length) { return; }
    await this.addEntries(picked.map(uri => ({ scheme: uri.scheme, fsPath: uri.fsPath })), []);
  }

  private async addEntries(entries: Array<{ scheme: string; fsPath: string }>, refusals: string[]): Promise<void> {
    if (this.busy) { this.say('Wait for the current reply or run to finish, or stop it, before adding files.'); return; }
    if (!this.root) { this.say('Open a folder to attach files and folders: they are read from it.'); return; }
    const conversation = await this.ensureConversation();
    const list = conversation.attachments ?? [];
    for (const entry of entries) {
      const accepted = acceptEntry(this.root, entry, list);
      if (accepted.ok) {
        const chip: Attachment = { ...accepted.attachment };
        if (chip.kind === 'file' && await gitIgnored(this.root, chip.path)) { chip.ignored = true; }
        list.push(chip);
      } else if (!accepted.duplicate) {
        const relative = path.relative(this.root, entry.fsPath);
        const shown = !relative || relative.startsWith('..') || path.isAbsolute(relative) ? entry.fsPath : relative.split(path.sep).join('/');
        refusals.push(`Not added: ${shown} ${accepted.reason}.`);
      }
    }
    conversation.attachments = list;
    await this.saveConversation();
    if (refusals.length) { this.notice = refusals.join('\n'); }
    this.post();
  }

  private async detach(relative: string): Promise<void> {
    if (this.busy) { this.say('Wait for the current reply or run to finish, or stop it, before removing files.'); return; }
    const conversation = await this.ensureConversation();
    conversation.attachments = (conversation.attachments ?? []).filter(chip => chip.path !== relative);
    this.outcomes.get(conversation.id)?.delete(relative);
    await this.saveConversation();
    this.post();
  }

  /** Open map: a map file under .repository-manager/maps, nothing else. */
  private async openMap(relative: string): Promise<void> {
    if (!this.root || typeof relative !== 'string' || !insideMaps(relative) || relative.includes('..')) { return; }
    const target = path.join(this.root, relative);
    if (!await fs.stat(target).then(stat => stat.isFile(), () => false)) { this.say('That map does not exist yet: it is made at the next send.'); return; }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
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
    this.cancelled = false;
    this.post();
    const live: LiveRun = { plan, entries: [], activity: [], since: new Map(), signature: '' };
    this.live = live;
    // ChatStore writes one conversation's saves in the order asked, so the last one written is the last asked for.
    const queueSave = () => { void this.saveConversation().catch(() => undefined); };
    const persist = () => {
      if (!live.run) { return; }
      live.run.steps = live.steps?.map(step => ({ ...step }));
      live.run.activity = live.activity.slice(-SAVED_ACTIVITY);
      queueSave();
    };
    const update = (state: RunState) => {
      const written = Object.values(state.nodes).map(node => node.output)
        .filter((output): output is { path: string } => Boolean(output) && typeof (output as { path?: unknown }).path === 'string').map(output => output.path);
      live.state = state;
      if (!live.run) {
        live.run = { id: state.id, status: state.status, criteria: state.criteria };
        addRun(conversation, live.run, `Run of "${plan.title}"`);
      }
      Object.assign(live.run, { status: state.status, error: state.error, written });
      this.refreshSteps(live);
      persist();
      this.post();
    };
    // Each log entry the run appends, in order: the card's steps come from `runTimeline` over them.
    const onLog = (entry: RunLogEntry) => {
      if (this.live !== live) { return; }
      live.entries.push(entry);
      if (entry.type === 'node' && typeof entry.node === 'string') { live.since.set(entry.node, entry.at); }
      const line = activityLine(entry);
      if (line) {
        live.activity.push({ at: entry.at, node: typeof entry.node === 'string' ? entry.node : '', text: line.text, ...(line.ok === undefined ? {} : { ok: line.ok }) });
        if (live.activity.length > LIVE_ACTIVITY) { live.activity.splice(0, live.activity.length - LIVE_ACTIVITY); }
      }
      if (!live.run) { return; }
      if (this.refreshSteps(live)) { persist(); }
      this.postSoon();
    };
    const stopped = () => this.cancelled;
    try {
      const final = await this.runs.run(plan, workflowHash(serializeWorkflow(plan)), update, { onLog, signal: { get cancelled() { return stopped(); } } });
      if (!final) { this.say('The run did not start.'); }
    } finally {
      this.live = undefined;
      this.busy = undefined;
      this.cancelled = false;
      if (live.run) { live.run.steps = live.steps?.map(step => ({ ...step })); live.run.activity = live.activity.slice(-SAVED_ACTIVITY); }
      await this.saveConversation();
      this.post();
    }
  }

  /**
   * Recomputes the steps of the run in progress from the entries seen and the latest state. True when a
   * step started, ended or changed what it is (a post and a save follow at once); an activity line alone
   * does not count.
   */
  private refreshSteps(live: LiveRun): boolean {
    // No log entry yet: nothing to say about steps, and the card is as it was before steps existed.
    if (!live.state || !live.entries.length) { return false; }
    const timeline = runTimeline({ state: live.state, log: live.entries }, live.plan);
    const byId = new Map(timeline.nodes.map(node => [node.node, node]));
    const status = live.state.status;
    live.steps = runOrder(live.plan).map(id => {
      const node = byId.get(id);
      const title = live.plan.nodes.find(candidate => candidate.id === id)?.title;
      return {
        id, ...(title ? { title } : {}), outcome: stepOutcome(node?.outcome ?? 'pending', status),
        ...(node?.executionMs === undefined ? {} : { executionMs: node.executionMs }), ...(node?.error ? { error: node.error } : {})
      };
    });
    const signature = live.steps.map(step => `${step.id}:${step.outcome}`).join('|');
    const changed = signature !== live.signature;
    live.signature = signature;
    return changed;
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
      detail: `${skill.description}${skill.usesScripts ? ` · ${scriptsNote(node.type, this.scriptMode ?? 'unknown', this.filesOf(skill)).replace(/^[A-Z]/, letter => letter.toLowerCase())}` : ''}`, skill
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

  /**
   * Export… on the plan card: the accepted plan as a file to share, written by the same Export as
   * Export Workflow… (requires computed from it). No folder needed: nothing runs.
   */
  private async exportPlan(): Promise<void> {
    const conversation = await this.ensureConversation();
    await this.syncFromFile();
    if (!conversation.plan) { this.say('There is no plan to export yet.'); return; }
    const problems = planProblems(conversation.plan, this.steps);
    if (problems.length) { this.say(`The plan cannot be exported yet: ${problems[0].where}: ${problems[0].message}`); return; }
    const version = String((this.context.extension?.packageJSON as { version?: unknown } | undefined)?.version ?? '0.0.0');
    const result = exportWorkflow(serializeWorkflow(conversation.plan), this.steps, version);
    if (!result.text) { this.say(`The plan cannot be exported: ${result.problems[0]?.where}: ${result.problems[0]?.message}`); return; }
    const target = await vscode.window.showSaveDialog({ title: 'Export Plan as Workflow', saveLabel: 'Export',
      defaultUri: vscode.Uri.file(path.join(this.root ?? os.homedir(), `${conversation.plan.id || 'plan'}.workflow.json`)), filters: { workflow: ['json'] } });
    if (!target) { return; }
    await fs.writeFile(target.fsPath, result.text, 'utf8');
    this.say(`Exported to ${target.fsPath}. Whoever imports it sees what it does and what it needs.`);
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
    if (!this.conversation) { return; }
    // A chat with nothing in it is not kept, unless it was saved before: then it is saved again, so a removed chip stays removed.
    if (!this.conversation.messages.length && !this.conversation.attachments?.length && !await this.store.load(this.conversation.id)) { return; }
    await this.store.save(this.conversation);
    await this.context.workspaceState.update(CURRENT_KEY, this.conversation.id);
  }

  private say(text: string): void {
    this.notice = text;
    this.post();
  }

  /** Posts now, or at most every POST_INTERVAL_MS with a trailing post, for a run writing many lines. */
  private postSoon(): void {
    if (this.postTimer) { return; }
    const wait = POST_INTERVAL_MS - (Date.now() - this.lastPost);
    if (wait <= 0) { this.post(); return; }
    this.postTimer = setTimeout(() => { this.postTimer = undefined; this.post(); }, wait);
  }

  /** The run as the page gets it: the one in progress with its live steps, lines and start times. */
  private runView(run: ChatRun): unknown {
    const live = this.live;
    if (!live || live.run !== run || !live.steps) { return run; }
    return { ...run, steps: live.steps.map(step => ({ ...step, ...(step.outcome === 'running' && live.since.has(step.id) ? { since: live.since.get(step.id) } : {}) })), activity: live.activity };
  }

  /** What is known of a skill's script files: from loading it, else from its listing. */
  private filesOf(skill: SkillSummary): SkillScriptFiles | undefined {
    const known = this.scriptFiles.get(skill.ref);
    if (known) { return { none: known.none, unavailable: known.unavailable }; }
    return skill.noScriptFiles ? { none: true } : undefined;
  }

  /**
   * Loads the skills on code steps that use scripts (pinned and cached, so no new commit is read) to
   * learn whether their scripts will run there; posts again when something is found. A failed
   * download is tried again after 30 s.
   */
  private refreshScriptFiles(refs: string[]): void {
    for (const ref of refs) {
      const known = this.scriptFiles.get(ref);
      const retry = known?.unavailable !== undefined && /could not be (downloaded|listed)/.test(known.unavailable) && Date.now() - known.at > 30_000;
      if (this.scriptFilesAsked.has(ref) || (known && !retry)) { continue; }
      this.scriptFilesAsked.add(ref);
      void this.skills.load(ref).then(loaded => {
        const files: SkillScriptFiles = loaded.scriptsUnavailable ? { unavailable: loaded.scriptsUnavailable } : !loaded.scripts.length ? { none: true } : {};
        this.scriptFiles.set(ref, { ...files, at: Date.now() });
        this.post();
      }, () => undefined).finally(() => this.scriptFilesAsked.delete(ref));
    }
  }

  /** Looks up where skill scripts run (the setting, then the engine probe) without holding up a post; posts again when it changed. */
  private refreshScriptMode(): void {
    const probe = this.runs?.scriptRunner;
    if (!probe || Date.now() - this.scriptModeAt < 5000) { return; }
    this.scriptModeAt = Date.now();
    void probe().then(mode => { if (mode !== this.scriptMode) { this.scriptMode = mode; this.post(); } }, () => undefined);
  }

  /** A chip as the page gets it: what it is and how it went at the last send. */
  private chipView(conversation: Conversation, chip: Attachment): unknown {
    const last = this.outcomes.get(conversation.id)?.get(chip.path);
    return {
      path: chip.path, kind: chip.kind, ignored: Boolean(last ? last.ignored : chip.ignored),
      map: chip.kind === 'folder' ? (last?.map ?? null) : null,
      outcome: last ? { notSent: last.notSent ?? null, sent: last.sent, files: last.files, moreFiles: last.moreFiles, mapNotSaved: Boolean(last.mapNotSaved) } : null
    };
  }

  private post(): void {
    this.refreshScriptMode();
    if (this.postTimer) { clearTimeout(this.postTimer); this.postTimer = undefined; }
    this.lastPost = Date.now();
    if (!this.view || !this.conversation) { return; }
    const conversation = this.conversation;
    const onCode = new Set<string>();
    for (const message of conversation.messages) {
      for (const node of message.draft?.workflow.nodes ?? []) {
        if (node.type === 'code') { for (const ref of node.skills ?? []) { if (this.skillNames.get(ref)?.usesScripts) { onCode.add(ref); } } }
      }
    }
    this.refreshScriptFiles([...onCode]);
    const notice = this.notice;
    this.notice = '';
    void this.view.webview.postMessage({
      type: 'state', notice, busy: this.busy ?? null, stopping: Boolean(this.busy && this.cancelled), folder: Boolean(this.root),
      models: this.models.map(model => ({ selector: model.selector, name: model.name, vendor: model.vendor })), modelsLoaded: this.modelsLoaded,
      skills: Object.fromEntries([...this.skillNames.values()].map(skill => [skill.ref, { name: skill.name, usesScripts: skill.usesScripts, ...(skill.usesScripts ? this.filesOf(skill) : {}) }])),
      scriptRunner: this.scriptMode,
      model: conversation.model ?? null, file: conversation.file ?? null, title: conversation.title, progress: this.progress,
      attachments: (conversation.attachments ?? []).map(chip => this.chipView(conversation, chip)),
      messages: conversation.messages.map(message => ({
        id: message.id, role: message.role, text: message.text, model: message.model ?? null, attached: message.attached ? attachedLine(message.attached) : null, run: message.run ? this.runView(message.run) : null,
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
  <div id="run-status" class="visually-hidden" role="status"></div>
  <div id="notice" role="alert" hidden></div>
  <form id="composer" autocomplete="off">
    <div id="attachments" role="list" aria-label="Attached files and folders" hidden></div>
    <textarea id="message" rows="3" placeholder="Describe what you want done…" aria-label="Message"></textarea>
    <p id="attach-hint" class="hint" hidden>Hold Shift to drop files or folders here.</p>
    <div class="composer-bar">
      <button type="button" id="add" title="Attach files or a folder of this workspace">Add…</button>
      <label class="model-label">Model <select id="model" aria-label="Model for drafting the plan"></select></label>
      <button type="submit" id="send" class="primary">Send</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
