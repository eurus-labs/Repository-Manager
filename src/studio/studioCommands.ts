/**
 * The Studio in VS Code, phase 1 (docs/agent-studio.md): Run Workflow… picks a workflow from the
 * library, the folder or the samples, asks its inputs and the consent to send to Copilot, runs it,
 * and asks at each gate with exactly what will happen. Show Workflow Runs reopens a run waiting
 * for an answer. The engine itself has no `vscode` (src/studio/engine.ts).
 */
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { recoverInterruptedSteps, RunLogEntry, RunState, RunStore, WorkflowEngine, workflowEffects, workflowModels, workflowSkills } from './engine';
import { activityLine } from './runsReport';
import { skillSources, StudioSkills, studioSkills } from './githubSkills';
import { approveChecks, codeServices } from './codeHost';
import { CancelSignal, StepDefinition } from './steps';
import { studioSteps } from './registry';
import { listModels, resolveSelector, studioModel } from './studioModels';
import { parseWorkflow, runOrder, Workflow, workflowHash } from './workflow';
import { checkImport, exportWorkflow, freeId, MAX_SHARED_BYTES, withId } from './sharing';
import { fetchSharedWorkflow } from './fetchShared';
import { readScripts } from '../agent/repositoryScripts';

const REPOSITORY_FOLDER = path.join('.repository-manager', 'workflows');
const SUFFIX = '.workflow.json';

interface Found { label: string; where: string; file: string }

async function workflowFiles(folder: string, where: string): Promise<Found[]> {
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  return names.filter(name => name.endsWith(SUFFIX)).sort().map(name => ({ label: name.slice(0, -SUFFIX.length), where, file: path.join(folder, name) }));
}

/** What a caller of `run` may add: to see the run's log entries as they are written, and to stop it. */
export interface RunOptions {
  /** Each entry of this run's log, in the order it was appended (never another run's). */
  onLog?(entry: RunLogEntry): void;
  /** Cancels the run where a step checks it, like the notification's Cancel. */
  signal?: CancelSignal;
}

/** What the Studio Chat uses to run a plan the way Run Workflow… runs a file. */
export interface StudioRuns {
  steps: Map<string, StepDefinition>;
  skills: StudioSkills;
  /** Asks the inputs, the models to use instead of missing ones, and the consent; then runs. Undefined when the person cancelled first. */
  run(workflow: Workflow, hash: string, onUpdate?: (state: RunState) => void, options?: RunOptions): Promise<RunState | undefined>;
  /** The stored runs, once recovery after a restart is done. */
  runs(): Promise<RunStore>;
  /** Takes a waiting run up again (asks at its gate or review), with the workflow as it was when it started. */
  resume(id: string): Promise<RunState | undefined>;
  /** Opens a run's state and log as JSON, for investigating. */
  openLog(id: string): Promise<void>;
}

export function registerStudio(context: vscode.ExtensionContext, workspaceRoot: string): StudioRuns {
  const steps = studioSteps();
  const extensionVersion = String((context.extension?.packageJSON as { version?: unknown } | undefined)?.version ?? '0.0.0');
  const library = path.join(context.globalStorageUri.fsPath, 'studio', 'workflows');
  const store = new RunStore(path.join(context.storageUri?.fsPath ?? context.globalStorageUri.fsPath, 'studio', 'runs'));
  const skills = studioSkills(context);
  const code = codeServices(context);
  const engine = new WorkflowEngine({ root: workspaceRoot, steps, store, model: studioModel(context), skills, code });
  // Runs cut short when VS Code last closed: a step's writes are undone, and the run says so (#140).
  // Every run waits for this first, so recovery only ever meets runs nothing is running.
  const recovery: Promise<unknown> = recoverInterruptedSteps(store, code.isDirty).then(found => {
    const unreadable = found.filter(item => item.unreadable);
    if (unreadable.length) {
      void vscode.window.showErrorMessage(`A workflow step's record of its writes could not be read, so its changes were not undone; it is kept to try again next time. ${unreadable[0].unreadable}`);
    }
    const undone = found.filter(item => item.restored.length || item.kept.length);
    if (!undone.length) { return; }
    const kept = undone.flatMap(item => item.kept);
    void vscode.window.showWarningMessage(
      `VS Code closed while ${undone.length === 1 ? `a step of "${undone[0].workflow ?? undone[0].runId}" was` : `${undone.length} workflow steps were`} changing files. ${undone.reduce((sum, item) => sum + item.restored.length, 0)} file(s) were put back as before the step.${kept.length ? ` Changed since, left as they are: ${kept.join(', ')}.` : ''}`);
  }, error => console.error('[RepositoryManager] Studio recovery:', error));
  const recovered = () => recovery.catch(() => undefined);
  const samples = path.join(context.extensionUri.fsPath, 'resources', 'studio', 'samples');
  const load = async (file: string): Promise<{ workflow: Workflow; hash: string } | undefined> => {
    const text = await fs.readFile(file, 'utf8');
    const { workflow, problems } = parseWorkflow(text, steps);
    if (!workflow) {
      const shown = problems.slice(0, 8).map(problem => `• ${problem.where}: ${problem.message}`).join('\n');
      void vscode.window.showErrorMessage(`${path.basename(file)} cannot run.`, { modal: true,
        detail: `${shown}${problems.length > 8 ? `\n… and ${problems.length - 8} more` : ''}` });
      return undefined;
    }
    return { workflow, hash: workflowHash(text) };
  };

  const askInputs = async (workflow: Workflow): Promise<Record<string, unknown> | undefined> => {
    const values: Record<string, unknown> = {};
    for (const [name, input] of Object.entries(workflow.inputs ?? {})) {
      const title = input.title ?? name;
      if (input.type === 'string') {
        const value = await vscode.window.showInputBox({ title, prompt: input.description, value: typeof input.default === 'string' ? input.default : '', ignoreFocusOut: true });
        if (value === undefined) { return undefined; }
        values[name] = value;
        continue;
      }
      const picked = await vscode.window.showOpenDialog({ title, canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        defaultUri: vscode.Uri.file(workspaceRoot), openLabel: 'Select' });
      if (!picked?.length) { return undefined; }
      const folder = picked[0].fsPath;
      if (input.type === 'folder') { values[name] = path.relative(workspaceRoot, folder).startsWith('..') ? folder : path.relative(workspaceRoot, folder) || '.'; continue; }
      const ref = await vscode.window.showInputBox({ title: `${title}: revision`, prompt: 'A branch, tag or commit of that repository. Leave empty to read its files as they are now.', ignoreFocusOut: true });
      if (ref === undefined) { return undefined; }
      values[name] = { path: folder, ref: ref.trim() || undefined };
    }
    return values;
  };

  /**
   * The models the workflow names that this VS Code does not have, each with the one the person
   * picks instead (a shared file may name a model only its author has). Undefined: cancelled.
   */
  const replacements = async (workflow: Workflow): Promise<Record<string, string> | undefined> => {
    const named = workflowModels(workflow);
    if (!named.length) { return {}; }
    const available = await listModels();
    const chosen: Record<string, string> = {};
    for (const selector of named) {
      if (resolveSelector(selector, available)) { continue; }
      if (!available.length) {
        void vscode.window.showErrorMessage(`"${workflow.title}" names the model "${selector}", and no Copilot model is available. Sign in to GitHub Copilot and try again.`);
        return undefined;
      }
      const picked = await vscode.window.showQuickPick(available.map(model => ({ label: model.name, description: model.selector, model })),
        { title: `"${selector}" is not available here: use instead`, placeHolder: 'For this run only; the workflow is not changed', ignoreFocusOut: true });
      if (!picked) { return undefined; }
      chosen[selector] = picked.model.selector;
    }
    return chosen;
  };

  /** What the workflow sends and changes when it runs, one line each (Run and Import show the same). */
  const describe = (workflow: Workflow, models: Record<string, string>): string[] => {
    const effects = workflowEffects(workflow, steps as Map<string, StepDefinition>);
    const named = workflowModels(workflow).map(selector => models[selector] ? `${selector} (instead: ${models[selector]})` : selector);
    return [
      effects.promptNodes.length ? `Sends the input of ${effects.promptNodes.length} prompt step${effects.promptNodes.length === 1 ? '' : 's'} (${effects.promptNodes.join(', ')}) to ${named.length ? `Copilot: ${named.join(', ')}${workflow.defaults?.model ? '' : ', and the selected model for the others'}` : 'the selected Copilot model'}.` : 'Sends nothing to a model.',
      ...(workflowSkills(workflow).length ? [`Steps follow ${workflowSkills(workflow).length} skill${workflowSkills(workflow).length === 1 ? '' : 's'} from ${skillSources(workflowSkills(workflow)).map(source => `github.com/${source}`).join(', ')} (instructions only; their scripts are not run).`] : []),
      ...effects.effects.map(item => `Asks you before ${item.node} (${item.type}) ${item.effect === 'write' ? 'writes files' : item.effect === 'command' ? 'runs a command' : 'sends to another system'}.`),
      ...effects.gates.map(gate => `Stops for your answer at ${gate}.`),
      ...(workflow.nodes.some(node => node.type === 'code') ? ['Code steps change files of this repository on the branch it is on (or a new branch the plan names), and wait for you to review each change (Accept, Retry or Stop).'] : [])
    ];
  };

  /** What the run will send and change, asked once before it starts. */
  const consent = async (workflow: Workflow, models: Record<string, string>): Promise<boolean> => {
    const lines = describe(workflow, models);
    const run = 'Run';
    return await vscode.window.showInformationMessage(`Run "${workflow.title}" (${workflow.version})?`, { modal: true, detail: lines.join('\n') }, run) === run;
  };

  /** Runs on, asking at each gate, until the run is done, stopped, failed, or left waiting. */
  const drive = async (workflow: Workflow, state: RunState, onUpdate?: (state: RunState) => void, options?: RunOptions): Promise<RunState> => {
    await recovered();
    let current = state;
    // The notification names the step running and what it is doing; the caller gets the entries.
    const order = runOrder(workflow);
    const titles = new Map(workflow.nodes.map(node => [node.id, node.title ?? node.id]));
    let report: ((message: string) => void) | undefined;
    let step: string | undefined;
    let activity: string | undefined;
    const announce = () => {
      if (!step || !report) { return; }
      report(`Step ${order.indexOf(step) + 1}/${order.length}: ${titles.get(step) ?? step}${activity ? ` — ${activity}` : ''}`);
    };
    const subscription = store.onLog((runId, entry) => {
      if (runId !== state.id) { return; }
      // `skills` is logged before its step's `node`: both name the step that is starting.
      if ((entry.type === 'node' || entry.type === 'skills') && typeof entry.node === 'string' && entry.node !== step) { step = entry.node; activity = undefined; announce(); }
      const line = activityLine(entry);
      // A late line of a step that has finished is not the notification's latest activity.
      if (line && (typeof entry.node !== 'string' || entry.node === step)) { activity = line.text; announce(); }
      try { options?.onLog?.(entry); } catch (error) { console.error('[RepositoryManager] Studio run listener:', error); }
    });
    try {
      onUpdate?.(current);
      // A run reopened from Show Workflow Runs may already be waiting: ask first, then go on.
      while (current.status === 'running' || current.status === 'waiting') {
        if (current.status === 'running') {
          current = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${workflow.title}`, cancellable: true },
            async (progress, token) => {
              report = message => progress.report({ message });
              try {
                return await engine.continue(workflow, current, { get cancelled() { return token.isCancellationRequested || Boolean(options?.signal?.cancelled); } });
              } finally { report = undefined; }
            });
          onUpdate?.(current);
          continue;
        }
        if (!current.waiting) { break; }
        const waiting = current.waiting;
        const review = waiting.kind === 'review';
        // Stop acts at once (plan 3, Decision 7), also at an approval: the engine's own stop path, so a
        // reviewed step's changes are undone and nothing is approved.
        const stopWaiting = async () => { current = await engine.answer(current, review ? 'stop' : false, workflow); onUpdate?.(current); };
        if (options?.signal?.cancelled) { await stopWaiting(); continue; }
        // A review's Accept says what it accepts: a failed or unverified change is never plain "Accept".
        const approve = !review ? (waiting.kind === 'gate' ? 'Continue' : 'Approve')
          : waiting.verdict === 'failed' ? 'Accept Anyway' : waiting.verdict === 'unverified' ? 'Accept as Unverified' : 'Accept';
        const retry = review && (waiting.attempts ?? 0) < (waiting.maxAttempts ?? 0) ? `Retry (${(waiting.attempts ?? 0) + 1}/${waiting.maxAttempts})` : undefined;
        const show = 'Show in Editor';
        const stop = 'Stop Run';
        let answer: string | undefined;
        do {
          answer = await vscode.window.showWarningMessage(waiting.title, { modal: true,
            detail: waiting.preview.length > 1500 ? `${waiting.preview.slice(0, 1500)}\n… (Show in Editor for all of it)` : waiting.preview },
            ...[approve, retry, show, stop].filter((item): item is string => Boolean(item)));
          if (answer === show) {
            const document = await vscode.workspace.openTextDocument({ content: waiting.preview, language: 'markdown' });
            await vscode.window.showTextDocument(document, { preview: true });
          }
        } while (answer === show);
        // Stop pressed while the dialog was open wins over any answer, closing it included.
        if (options?.signal?.cancelled) { await stopWaiting(); continue; }
        // Closing the dialog leaves the run waiting (Show Workflow Runs takes it up again).
        if (answer === undefined) { return current; }
        current = review
          ? await engine.answer(current, answer === approve ? 'accept' : answer === retry ? 'retry' : 'stop', workflow)
          : await engine.answer(current, answer === approve);
        onUpdate?.(current);
      }
      if (current.status === 'done') {
        const written = Object.values(current.nodes).map(node => node.output).filter((output): output is { path: string } =>
          Boolean(output) && typeof (output as { path?: unknown }).path === 'string');
        const open = 'Open Result';
        // The path is taken now, so a later click opens this run's file even if another run finished since.
        const result = written.length ? path.join(workspaceRoot, written[written.length - 1].path) : undefined;
        // Not awaited: the person may leave the notification open, and the run (and the chat) must not wait for it.
        void Promise.resolve(vscode.window.showInformationMessage(`${workflow.title}: done.`, ...(result ? [open] : [])))
          .then(async answer => { if (answer === open && result) { await vscode.window.showTextDocument(vscode.Uri.file(result)); } })
          .catch(() => undefined);
      } else if (current.status === 'failed') {
        void vscode.window.showErrorMessage(`${workflow.title} failed: ${current.error ?? 'unknown error'}`);
      } else if (current.status === 'stopped') {
        void vscode.window.showInformationMessage(`${workflow.title} stopped: ${current.error ?? ''}`);
      }
      return current;
    } finally {
      subscription.dispose();
    }
  };

  const run = async (workflow: Workflow, hash: string, onUpdate?: (state: RunState) => void, options?: RunOptions): Promise<RunState | undefined> => {
    await recovered();
    const inputs = await askInputs(workflow);
    if (!inputs) { return undefined; }
    const models = await replacements(workflow);
    if (!models) { return undefined; }
    // The checks code steps will run are approved first, as the agent asks.
    const checks = workflow.nodes.filter(node => node.type === 'code').flatMap(node => Array.isArray(node.with?.checks) ? node.with!.checks.filter((check): check is string => typeof check === 'string') : []);
    if (checks.length && !await approveChecks(context, workspaceRoot, checks)) { return undefined; }
    // Skills from a source not trusted yet (a workflow someone shared) are asked about first.
    if (!await skills.ensureTrusted(skillSources(workflowSkills(workflow)))) { return undefined; }
    if (!await consent(workflow, models)) { return undefined; }
    try {
      return await drive(workflow, await engine.start(workflow, hash, inputs, models), onUpdate, options);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not run the workflow: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  // A waiting run goes on with the workflow as it was when it started, even after a restart.
  const resume = async (id: string): Promise<RunState | undefined> => {
    await recovered();
    const state = await store.load(id);
    if (state.status !== 'waiting') { return state; }
    return await drive(await store.loadWorkflow(id), state);
  };
  const openLog = async (id: string): Promise<void> => {
    const state = await store.load(id).catch(() => undefined);
    const log = (await store.readLog(id)).map(entry => JSON.stringify(entry)).join('\n');
    const document = await vscode.workspace.openTextDocument({ content: `${state ? JSON.stringify(state, null, 2) : `// The state of ${id} could not be read.`}\n\n${log}\n`, language: 'json' });
    await vscode.window.showTextDocument(document, { preview: true });
  };

  context.subscriptions.push(
    // From the editor's Run, the workflow's file is given; from the Command Palette it is picked.
    vscode.commands.registerCommand('repositoryManager.studio.runWorkflow', async (given?: vscode.Uri) => {
      if (given?.fsPath) {
        const parsed = await load(given.fsPath);
        if (parsed) { await run(parsed.workflow, parsed.hash); }
        return;
      }
      const found = [
        ...await workflowFiles(path.join(workspaceRoot, REPOSITORY_FOLDER), 'This folder'),
        ...await workflowFiles(library, 'Library'),
        ...await workflowFiles(samples, 'Sample')
      ];
      const picked = await vscode.window.showQuickPick(found.map(item => ({ label: item.label, description: item.where, item })),
        { title: 'Run Workflow', placeHolder: `Workflows in ${REPOSITORY_FOLDER}, your library and the samples` });
      if (!picked) { return; }
      const parsed = await load(picked.item.file);
      if (parsed) { await run(parsed.workflow, parsed.hash); }
    }),
    // Sharing one workflow as a file (phase 3): Export writes it with its requirements, Import
    // checks it, says what it does and what is missing here, and keeps it in the library.
    vscode.commands.registerCommand('repositoryManager.studio.exportWorkflow', async (given?: vscode.Uri) => {
      let file = given?.fsPath;
      if (!file) {
        const found = [...await workflowFiles(path.join(workspaceRoot, REPOSITORY_FOLDER), 'This folder'), ...await workflowFiles(library, 'Library')];
        if (!found.length) { void vscode.window.showInformationMessage(`No workflow to export: save one in ${REPOSITORY_FOLDER} or import one first.`); return; }
        const picked = await vscode.window.showQuickPick(found.map(item => ({ label: item.label, description: item.where, item })),
          { title: 'Export Workflow', placeHolder: 'The workflow to share as a file' });
        if (!picked) { return; }
        file = picked.item.file;
      }
      const result = exportWorkflow(await fs.readFile(file, 'utf8'), steps, extensionVersion);
      if (!result.text) {
        void vscode.window.showErrorMessage(`${path.basename(file)} cannot be exported.`, { modal: true, detail: result.problems.slice(0, 8).map(problem => `• ${problem.where}: ${problem.message}`).join('\n') });
        return;
      }
      const target = await vscode.window.showSaveDialog({ title: 'Export Workflow', saveLabel: 'Export',
        defaultUri: vscode.Uri.file(path.join(os.homedir(), path.basename(file))), filters: { Workflow: ['json'] } });
      if (!target) { return; }
      await fs.writeFile(target.fsPath, result.text, 'utf8');
      void vscode.window.showInformationMessage(`Exported to ${target.fsPath}. It lists what it needs (requires); the person who imports it sees that and what it does.`);
    }),
    vscode.commands.registerCommand('repositoryManager.studio.importWorkflow', async (given?: vscode.Uri | string) => {
      // A file (given, or picked) or an https URL: both go through the same checks and question.
      let address = typeof given === 'string' ? given : undefined;
      let file = typeof given === 'object' ? given.fsPath : undefined;
      if (!address && !file) {
        const fromFile = 'From a file…';
        const fromUrl = 'From a URL…';
        const way = await vscode.window.showQuickPick([fromFile, fromUrl], { title: 'Import Workflow', placeHolder: 'Where is the .workflow.json?' });
        if (!way) { return; }
        if (way === fromUrl) {
          address = await vscode.window.showInputBox({ title: 'Import Workflow from a URL', prompt: `An https:// address of a .workflow.json (at most ${MAX_SHARED_BYTES / 1024} KB). Nothing runs on import.`,
            placeHolder: 'https://…/name.workflow.json', ignoreFocusOut: true,
            validateInput: value => /^https:\/\/\S+$/i.test(value.trim()) ? undefined : 'Enter an https:// address.' });
          if (!address) { return; }
        } else {
          file = (await vscode.window.showOpenDialog({ title: 'Import Workflow', openLabel: 'Import', canSelectMany: false, filters: { Workflow: ['json'] } }))?.[0]?.fsPath;
          if (!file) { return; }
        }
      }
      let incoming: string;
      let origin: string;
      if (address) {
        try {
          const fetched = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Fetching ${address}` }, () => fetchSharedWorkflow(address!));
          incoming = fetched.text;
          origin = fetched.url;
        } catch (error) {
          void vscode.window.showErrorMessage(`Could not import from ${address}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      } else {
        incoming = await fs.readFile(file!, 'utf8');
        origin = file!;
      }
      const check = checkImport(incoming, steps, { extensionVersion, scripts: Object.keys(readScripts(workspaceRoot)) });
      if (!check.workflow || !check.text) {
        void vscode.window.showErrorMessage(`${address ? origin : path.basename(origin)} cannot be imported.`, { modal: true,
          detail: check.problems.slice(0, 8).map(problem => `• ${problem.where}: ${problem.message}`).join('\n') });
        return;
      }
      const workflow = check.workflow;
      const about = workflow.about;
      const detail = [
        `${workflow.title} ${workflow.version}${about?.authors?.length ? ` by ${about.authors.join(', ')}` : ''}${about?.license ? ` · ${about.license}` : ''}`,
        ...(address ? [`From ${origin}`] : []),
        ...(about?.homepage ? [about.homepage] : []),
        ...(workflow.description ? [workflow.description] : []),
        '', 'When it runs, it:', ...describe(workflow, {}).map(line => `• ${line}`),
        ...(check.missing.length ? ['', 'Missing here:', ...check.missing.map(line => `• ${line}`)] : []),
        ...(check.warnings.length ? ['', 'Its "requires" did not match the workflow; the matching one is kept:', ...check.warnings.map(line => `• ${line}`)] : []),
        '', 'Importing runs nothing. Each run asks first, as for any workflow.'
      ].join('\n');
      const imported = 'Import';
      if (await vscode.window.showWarningMessage(`Import "${workflow.title}" into your library?`, { modal: true, detail }, imported) !== imported) { return; }
      await fs.mkdir(library, { recursive: true });
      const taken = new Set((await workflowFiles(library, 'Library')).map(item => item.label));
      let id = workflow.id;
      let text = check.text;
      if (taken.has(id)) {
        const existing = await fs.readFile(path.join(library, `${id}${SUFFIX}`), 'utf8').catch(() => '');
        if (existing !== text) {
          const replace = 'Replace';
          const both = 'Keep Both';
          const choice = await vscode.window.showWarningMessage(`Your library already has a workflow "${id}".`, { modal: true,
            detail: 'Replace overwrites it with this file. Keep Both imports this one under another id.' }, replace, both);
          if (!choice) { return; }
          if (choice === both) { id = freeId(id, taken); text = withId(text, id); }
        }
      }
      if (id === workflow.id) {
        await fs.writeFile(path.join(library, `${id}${SUFFIX}`), text, 'utf8');
      } else {
        // Keep Both creates a new file exclusively: another window may have taken this id meanwhile.
        for (;;) {
          try { await fs.writeFile(path.join(library, `${id}${SUFFIX}`), text, { encoding: 'utf8', flag: 'wx' }); break; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            taken.add(id);
            id = freeId(workflow.id, taken);
            text = withId(text, id);
          }
        }
      }
      void vscode.window.showInformationMessage(`Imported "${workflow.title}" into your library as ${id}. Run it from Run Workflow….`);
    }),
    vscode.commands.registerCommand('repositoryManager.studio.showRuns', async () => {
      await recovered();
      const runs = await store.list();
      const picked = await vscode.window.showQuickPick(runs.slice(0, 50).map(run => ({
        label: run.workflow.title, description: `${run.interrupted ? 'interrupted' : run.status}${run.waiting ? `: ${run.waiting.title}` : ''}`, detail: `${run.startedAt} · ${run.id}`, run
      })), { title: 'Workflow Runs', placeHolder: runs.length ? 'A waiting run goes on; others open their log' : 'No runs yet' });
      if (!picked) { return; }
      if (picked.run.status === 'waiting') { await resume(picked.run.id); return; }
      await openLog(picked.run.id);
    })
  );
  return { steps, skills, run, runs: async () => { await recovered(); return store; }, resume, openLog };
}
