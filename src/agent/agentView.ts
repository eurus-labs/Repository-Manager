/**
 * The Agent area of the Activity Bar: the Tasks view (grouped by what each task waits for, with a
 * badge counting those waiting for you), New Task, and one editor page per task. Wires the
 * runner to VS Code: Copilot through vscode.lm, Git, editors' unsaved state, and npm scripts.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { AgentRunner, RunnerHost } from './agentRunner';
import { CancelToken, CopilotApi, CopilotChatModel, CopilotRouter } from './lmRouter';
import { renderTaskBody, renderTaskPage } from './agentPage';
import { TaskStore } from './taskStore';
import { AgentTask, AgentToolName, CheckResult, TaskGroup, taskGroup, WRITE_TOOLS } from './types';
import { readSelectedModel } from '../modelPreferences';
import { askBeforeSending } from '../copilotSettings';
import { ReviewConsentStore } from '../reviewConsent';

export const TASKS_VIEW = 'repositoryManager.agent.tasks';
export const DIFF_SCHEME = 'repository-manager-agent';
const APPROVED_SCRIPTS_KEY = 'repositoryManager.agent.approvedScripts';
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 8000;

const GROUPS: Array<{ id: TaskGroup; label: string }> = [
  { id: 'waiting', label: 'Waiting for you' }, { id: 'running', label: 'Running' },
  { id: 'todo', label: 'To do' }, { id: 'done', label: 'Done' }
];

type Node = { kind: 'group'; group: TaskGroup; label: string; tasks: AgentTask[] } | { kind: 'task'; task: AgentTask };

class TasksProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly store: TaskStore) {}
  refresh(): void { this.changed.fire(undefined); }

  getChildren(node?: Node): Node[] {
    if (node?.kind === 'group') { return node.tasks.map(task => ({ kind: 'task', task })); }
    if (node) { return []; }
    const tasks = this.store.list();
    return GROUPS.map(group => ({ kind: 'group' as const, group: group.id, label: group.label, tasks: tasks.filter(task => taskGroup(task) === group.id) }))
      .filter(group => group.tasks.length);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, node.group === 'done' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.group}`;
      item.description = String(node.tasks.length);
      return item;
    }
    const task = node.task;
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.id = `task:${task.id}`;
    const steps = task.plan?.length ? `${task.plan.filter(step => step.state !== 'pending').length}/${task.plan.length} steps` : '';
    item.description = [statusText(task), steps].filter(Boolean).join(' · ');
    item.tooltip = `${task.goal}\n\n${path.basename(task.repositoryRoot)}${task.branch ? ` · ${task.branch}` : ''}${task.error ? `\n\n${task.error}` : ''}`;
    item.iconPath = new vscode.ThemeIcon(task.error ? 'warning' : taskGroup(task) === 'waiting' ? 'bell-dot' : taskGroup(task) === 'running' ? 'sync~spin' :
      task.status === 'done' ? 'pass' : task.status === 'stopped' ? 'circle-slash' : 'circle-large-outline');
    item.contextValue = 'agentTask';
    item.command = { command: 'repositoryManager.agent.openTask', title: 'Open Task', arguments: [task.id] };
    return item;
  }
}

export function statusText(task: AgentTask): string {
  switch (task.status) {
    case 'new': return task.error ? 'Plan failed' : 'No plan';
    case 'planning': return 'Drafting plan';
    case 'planReview': return 'Approve plan';
    case 'stepReady': return `Run step ${task.current + 1}`;
    case 'stepRunning': return `Step ${task.current + 1} running`;
    case 'stepReview': return `Review step ${task.current + 1}`;
    case 'done': return 'Done';
    case 'stopped': return 'Stopped';
  }
}

export function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['-c', 'core.longpaths=true', ...args], { cwd: root, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)));
}

/** A path compared as the file it names: links resolved, and case ignored where the file system does. */
export function samePathKey(file: string): string {
  let real: string;
  try { real = fs.realpathSync.native(file); } catch { real = path.resolve(file); }
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

export function readScripts(root: string): Record<string, string> {
  try {
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    if (!scripts || typeof scripts !== 'object') { return {}; }
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

export function runNpmScript(root: string, script: string, token?: CancelToken): Promise<CheckResult> {
  const started = Date.now();
  return new Promise(resolve => {
    if (token?.isCancellationRequested) { resolve({ script, passed: false, exitCode: null, output: 'Cancelled', durationMs: 0 }); return; }
    let output = '';
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], { cwd: root, shell: process.platform === 'win32', env: process.env });
    const add = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-OUTPUT_TAIL); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { output += `\nStopped after ${SCRIPT_TIMEOUT_MS / 60000} minutes.`; child.kill(); }, SCRIPT_TIMEOUT_MS);
    // Cancel stops the script, not only the model.
    const cancelled = token?.onCancellationRequested?.(() => { output += '\nCancelled.'; child.kill(); });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      cancelled?.dispose();
      resolve({ script, passed: exitCode === 0, exitCode, output, durationMs: Date.now() - started });
    };
    child.on('error', error => { output += `\n${error.message}`; finish(null); });
    child.on('close', code => finish(code));
  });
}

/**
 * What `npm run <name>` runs: npm runs pre<name> and post<name> around it, so they are part of
 * what is approved, and a change to any of the three asks again.
 */
export function scriptCommand(scripts: Record<string, string>, name: string): string | undefined {
  if (scripts[name] === undefined) { return undefined; }
  return [scripts[`pre${name}`], scripts[name], scripts[`post${name}`]].map(command => command ?? '').join('\n');
}

/** How the approval question shows a script: its command, and the hooks npm runs with it. */
export function describeScript(scripts: Record<string, string>, name: string): string {
  const hooks = [`pre${name}`, `post${name}`].filter(hook => scripts[hook] !== undefined).map(hook => `\n    with ${hook}: ${scripts[hook]}`).join('');
  return `npm run ${name}  →  ${scripts[name]}${hooks}`;
}

/** Scripts approved per repository, with the commands each ran then: a changed command asks again. */
export class ScriptApprovals {
  constructor(private readonly memento: vscode.Memento) {}
  private all(): Record<string, Record<string, string>> {
    const value = this.memento.get<unknown>(APPROVED_SCRIPTS_KEY);
    return value && typeof value === 'object' ? value as Record<string, Record<string, string>> : {};
  }
  allowed(root: string, scripts: Record<string, string>): string[] {
    const approved = this.all()[root] ?? {};
    return Object.keys(scripts).filter(name => approved[name] !== undefined && approved[name] === scriptCommand(scripts, name));
  }
  async approve(root: string, scripts: Record<string, string>, names: string[]): Promise<void> {
    const all = this.all();
    const commands = Object.fromEntries(names.map(name => [name, scriptCommand(scripts, name) ?? '']));
    await this.memento.update(APPROVED_SCRIPTS_KEY, { ...all, [root]: { ...(all[root] ?? {}), ...commands } });
  }
}

class TaskPage {
  private static readonly pages = new Map<string, TaskPage>();
  private cancel?: vscode.CancellationTokenSource;
  private busy = false;

  static show(id: string, agent: AgentController): void {
    const open = TaskPage.pages.get(id);
    if (open) { open.panel.reveal(); open.update(); return; }
    const task = agent.store.get(id);
    if (!task) { void vscode.window.showErrorMessage('The task no longer exists.'); return; }
    const panel = vscode.window.createWebviewPanel('repositoryManager.agentTask', `Agent: ${task.title}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(agent.extensionUri, 'resources')] });
    TaskPage.pages.set(id, new TaskPage(id, panel, agent));
  }

  static updateAll(): void { TaskPage.pages.forEach(page => page.update()); }
  static close(id: string): void { TaskPage.pages.get(id)?.panel.dispose(); }

  private constructor(private readonly id: string, private readonly panel: vscode.WebviewPanel, private readonly agent: AgentController) {
    const nonce = randomBytes(16).toString('hex');
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(agent.extensionUri, 'resources', 'agent.css'));
    panel.webview.html = renderTaskPage(nonce, panel.webview.cspSource, style.toString(), this.body());
    panel.onDidDispose(() => { this.cancel?.cancel(); TaskPage.pages.delete(id); });
    panel.webview.onDidReceiveMessage(message => { void this.handle(message); });
  }

  private body(): string {
    const task = this.agent.store.get(this.id);
    return task ? renderTaskBody(task, this.agent.store.readLog(this.id), this.agent.modelName()) : '<p>The task no longer exists.</p>';
  }

  update(): void {
    const task = this.agent.store.get(this.id);
    if (task) { this.panel.title = `Agent: ${task.title}`; }
    void this.panel.webview.postMessage({ type: 'render', html: this.body() });
  }

  private async handle(message: { type?: string; action?: string; index?: number; path?: string }): Promise<void> {
    if (message.type !== 'action') { return; }
    // One action at a time (a double click must not start two runs); Cancel always gets through.
    if (message.action !== 'cancel' && message.action !== 'showDiff') {
      if (this.busy) { return; }
      this.busy = true;
    }
    const runner = this.agent.runner;
    try {
      switch (message.action) {
        case 'plan': {
          if (!await this.agent.confirmSending(this.id)) { return; }
          this.cancel = new vscode.CancellationTokenSource();
          await runner.plan(this.id, this.cancel.token);
          break;
        }
        case 'approvePlan': {
          if (!await this.agent.approveScriptsFor(this.id)) { return; }
          await runner.approvePlan(this.id);
          break;
        }
        case 'replan': runner.replan(this.id); break;
        case 'editStep': await this.agent.editStep(this.id, message.index ?? -1); break;
        case 'run': {
          // A check whose command changed since it was approved is asked about again here.
          if (!await this.agent.approveScriptsFor(this.id, true)) { return; }
          if (!await this.agent.confirmSending(this.id)) { return; }
          this.cancel = new vscode.CancellationTokenSource();
          await runner.runStep(this.id, this.cancel.token);
          break;
        }
        case 'cancel': this.cancel?.cancel(); break;
        case 'accept': await runner.accept(this.id); break;
        case 'acceptAnyway': {
          const task = this.agent.store.get(this.id);
          const checks = task?.plan?.[task.current]?.result?.checks.filter(check => !check.passed).map(check => check.script) ?? [];
          const choice = await vscode.window.showWarningMessage(`Accept this step although ${checks.join(', ')} failed?`,
            { modal: true, detail: 'Use this when the check failed before the task too. The step is marked as accepted with failing checks, here and in the run log.' }, 'Accept Anyway');
          if (choice) { await runner.accept(this.id, { anyway: true }); }
          break;
        }
        case 'acceptUnverified': {
          const task = this.agent.store.get(this.id);
          const changed = task?.plan?.[task.current]?.result?.changes.map(change => change.path) ?? [];
          const choice = await vscode.window.showWarningMessage(`Accept this step although no check verified it?`,
            { modal: true, detail: `It changed ${changed.join(', ') || 'files'} and no check ran. The step is marked as unverified, here and in the run log.` }, 'Accept as Unverified');
          if (choice) { await runner.accept(this.id, { anyway: true }); }
          break;
        }
        case 'retry': runner.retry(this.id); break;
        case 'skip': runner.skip(this.id); break;
        case 'stop': {
          const choice = await vscode.window.showWarningMessage('Stop this task? A step waiting for review is undone; accepted steps stay on the task\'s branch.', { modal: true }, 'Stop Task');
          if (choice) { runner.stop(this.id); }
          break;
        }
        case 'showDiff': await this.agent.showDiff(this.id, message.index ?? -1, message.path ?? ''); break;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (message.action !== 'cancel' && message.action !== 'showDiff') { this.busy = false; }
      this.update();
    }
  }
}

export class AgentController {
  readonly store: TaskStore;
  readonly runner: AgentRunner;
  private readonly approvals: ScriptApprovals;
  private readonly consent: ReviewConsentStore;

  constructor(private readonly context: vscode.ExtensionContext, readonly extensionUri: vscode.Uri) {
    const folder = (context.storageUri ?? context.globalStorageUri).fsPath;
    this.store = new TaskStore(path.join(folder, 'agent'));
    this.approvals = new ScriptApprovals(context.workspaceState);
    this.consent = new ReviewConsentStore(context.workspaceState);
    const api = vscode as unknown as {
      lm?: { selectChatModels(selector: { vendor: string }): Thenable<CopilotChatModel[]> };
      // eslint-disable-next-line @typescript-eslint/naming-convention
      LanguageModelChatMessage?: { User(text: string): unknown; Assistant?(text: string): unknown };
    };
    const copilot: CopilotApi = {
      selectModel: async () => {
        if (!api.lm?.selectChatModels || !api.LanguageModelChatMessage) { throw new Error('The agent requires VS Code 1.91 or newer and GitHub Copilot.'); }
        const models = await api.lm.selectChatModels({ vendor: 'copilot' });
        const chosen = readSelectedModel(context.globalState);
        const model = chosen ? models.find(item => item.id === chosen.id) : models[0];
        if (!model) { throw new Error(chosen ? `The model ${chosen.name} is not available. Choose another in the dashboard's model menu.` : 'No Copilot model is available.'); }
        return model;
      },
      user: text => api.LanguageModelChatMessage!.User(text),
      assistant: api.LanguageModelChatMessage?.Assistant ? text => api.LanguageModelChatMessage!.Assistant!(text) : undefined
    };
    const host: RunnerHost = {
      router: new CopilotRouter(copilot),
      git: {
        currentBranch: async root => (await git(root, ['branch', '--show-current'])).trim(),
        hasChanges: async root => Boolean((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()),
        createBranch: async (root, name) => { await git(root, ['switch', '-c', name]); }
      },
      isDirty: absolutePath => {
        const target = samePathKey(absolutePath);
        return vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && samePathKey(document.uri.fsPath) === target);
      },
      scripts: readScripts,
      allowedScripts: root => this.approvals.allowed(root, readScripts(root)),
      runScript: runNpmScript
    };
    this.runner = new AgentRunner(this.store, host);
  }

  modelName(): string {
    return readSelectedModel(this.context.globalState)?.name ?? 'Copilot default';
  }

  /** The copilot.askBeforeSending setting, as for reviews: once per repository or every time. */
  async confirmSending(id: string): Promise<boolean> {
    const task = this.store.get(id);
    if (!task) { return false; }
    const mode = askBeforeSending(vscode.workspace.getConfiguration('repositoryManager'));
    if (mode === 'never' || (mode === 'oncePerRepository' && this.consent.has(task.repositoryRoot))) { return true; }
    const name = path.basename(task.repositoryRoot);
    const options = mode === 'oncePerRepository' ? ['Send', 'Always Allow for This Repository'] : ['Send'];
    const choice = await vscode.window.showWarningMessage(`The agent sends files of ${name} that it reads to ${this.modelName()}.`, { modal: true }, ...options);
    if (choice === 'Always Allow for This Repository') { await this.consent.allow(task.repositoryRoot); }
    return Boolean(choice);
  }

  /** Asks once for the scripts the plan's checks use that are not approved yet (or changed since). */
  async approveScriptsFor(id: string, onlyCurrentStep = false): Promise<boolean> {
    const task = this.store.get(id);
    if (!task) { return false; }
    const steps = onlyCurrentStep ? (task.plan ?? []).slice(task.current, task.current + 1) : task.plan ?? [];
    return this.approveScripts(task.repositoryRoot, steps.flatMap(step => step.checks));
  }

  /**
   * Asks once for the scripts among `names` not approved yet (or whose command changed since), so
   * every way a check gets into a step (plan approval, Edit, Run) can be approved where it happens.
   */
  async approveScripts(root: string, names: string[]): Promise<boolean> {
    const scripts = readScripts(root);
    const allowed = this.approvals.allowed(root, scripts);
    const needed = [...new Set(names)].filter(name => !allowed.includes(name) && scripts[name] !== undefined);
    if (!needed.length) { return true; }
    const detail = needed.map(name => describeScript(scripts, name)).join('\n');
    const choice = await vscode.window.showWarningMessage(`Allow the agent to run these scripts of ${path.basename(root)}? You are asked again only if a script's command changes.`,
      { modal: true, detail }, 'Allow');
    if (choice !== 'Allow') { return false; }
    await this.approvals.approve(root, scripts, needed);
    return true;
  }

  async editStep(id: string, index: number): Promise<void> {
    const task = this.store.get(id);
    const step = task?.plan?.[index];
    if (!task || !step) { return; }
    const field = await vscode.window.showQuickPick([
      { label: 'Intent', description: step.intent.slice(0, 80), field: 'intent' as const },
      { label: 'Title', description: step.title, field: 'title' as const },
      { label: 'Paths it may change', description: step.paths.join(', ') || 'none', field: 'paths' as const },
      { label: 'Checks', description: step.checks.join(', ') || 'none', field: 'checks' as const },
      { label: 'Write tools', description: step.tools.join(', ') || 'none', field: 'tools' as const }
    ], { title: `Edit step ${index + 1}: ${step.title}` });
    if (!field) { return; }
    if (field.field === 'tools') {
      const picked = await vscode.window.showQuickPick(WRITE_TOOLS.map(tool => ({ label: tool, picked: step.tools.includes(tool) })),
        { canPickMany: true, title: 'Write tools the step may use (reading is always allowed)' });
      if (picked) { this.runner.editStep(id, index, { tools: picked.map(item => item.label as AgentToolName) }); }
      return;
    }
    if (field.field === 'checks') {
      const scripts = Object.keys(readScripts(task.repositoryRoot));
      const picked = await vscode.window.showQuickPick(scripts.map(name => ({ label: name, picked: step.checks.includes(name) })),
        { canPickMany: true, title: 'Repository scripts that check this step' });
      if (!picked) { return; }
      // A check added after the plan was approved is approved here, not left to fail at Run.
      const checks = picked.map(item => item.label);
      if (task.frozenAt && !await this.approveScripts(task.repositoryRoot, checks.filter(name => !step.checks.includes(name)))) { return; }
      this.runner.editStep(id, index, { checks });
      return;
    }
    const list = field.field === 'paths';
    const value = await vscode.window.showInputBox({
      title: `Step ${index + 1}: ${field.label}`,
      value: list ? step.paths.join(', ') : step[field.field],
      prompt: list ? 'Files or folders (ending with /), relative to the repository, separated by commas' : undefined
    });
    if (value === undefined) { return; }
    this.runner.editStep(id, index, list ? { paths: value.split(',').map(item => item.trim()).filter(Boolean) } : { [field.field]: value });
  }

  async showDiff(id: string, index: number, file: string): Promise<void> {
    const task = this.store.get(id);
    if (!task?.plan?.[index]?.result?.changes.some(change => change.path === file)) { return; }
    const before = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${file}`, query: `${id}:${index}` });
    const after = vscode.Uri.file(path.join(task.repositoryRoot, file));
    await vscode.commands.executeCommand('vscode.diff', before, after, `${path.basename(file)} (step ${index + 1})`);
  }

  /** The content before the step, for the diff's left side. */
  before(uri: vscode.Uri): string {
    const [id, index] = uri.query.split(':');
    const change = this.store.get(id)?.plan?.[Number(index)]?.result?.changes.find(item => item.path === uri.path.replace(/^\//, ''));
    return change?.before ?? '';
  }

  async deleteTask(id: string): Promise<void> {
    const task = this.store.get(id);
    if (!task) { return; }
    if (task.status === 'planning' || task.status === 'stepRunning') { void vscode.window.showErrorMessage('Cancel the running work first.'); return; }
    const choice = await vscode.window.showWarningMessage(`Delete the task "${task.title}" and its run log? Files and the branch are not touched.`, { modal: true }, 'Delete');
    if (choice) { TaskPage.close(id); this.store.delete(id); }
  }
}

export function registerAgent(context: vscode.ExtensionContext): void {
  const agent = new AgentController(context, context.extensionUri);
  agent.runner.recover();
  const provider = new TasksProvider(agent.store);
  const view = vscode.window.createTreeView(TASKS_VIEW, { treeDataProvider: provider });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'workbench.view.extension.repository-manager-agent';
  const refresh = () => {
    provider.refresh();
    const waiting = agent.store.list().filter(task => taskGroup(task) === 'waiting');
    view.badge = waiting.length ? { value: waiting.length, tooltip: `${waiting.length} agent task${waiting.length === 1 ? '' : 's'} waiting for you` } : undefined;
    if (waiting.length) {
      status.text = `$(bell-dot) Agent: ${waiting.length === 1 ? statusText(waiting[0]) : `${waiting.length} waiting`}`;
      status.tooltip = waiting.map(task => `${task.title}: ${statusText(task)}`).join('\n');
      status.show();
    } else {
      status.hide();
    }
    TaskPage.updateAll();
  };
  agent.store.onDidChange(refresh);
  refresh();
  context.subscriptions.push(view, status,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, { provideTextDocumentContent: uri => agent.before(uri) }),
    // New tasks start in the Studio chat (2.20.0): a goal there becomes a plan whose code steps do what tasks did.
    vscode.commands.registerCommand('repositoryManager.agent.newTask', async () => {
      await vscode.commands.executeCommand('repositoryManager.studio.chat.focus');
      await vscode.commands.executeCommand('repositoryManager.studio.newChat');
    }),
    vscode.commands.registerCommand('repositoryManager.agent.openTask', (id?: string | Node) => {
      const taskId = typeof id === 'string' ? id : id?.kind === 'task' ? id.task.id : undefined;
      if (taskId) { TaskPage.show(taskId, agent); }
    }),
    vscode.commands.registerCommand('repositoryManager.agent.deleteTask', (node?: Node) => {
      if (node?.kind === 'task') { return agent.deleteTask(node.task.id); }
    }));
}
