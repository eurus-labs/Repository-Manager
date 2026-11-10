/**
 * The Studio in VS Code, phase 1 (docs/agent-studio.md): Run Workflow… picks a workflow from the
 * library, the folder or the samples, asks its inputs and the consent to send to Copilot, runs it,
 * and asks at each gate with exactly what will happen. Show Workflow Runs reopens a run waiting
 * for an answer. The engine itself has no `vscode` (src/studio/engine.ts).
 */
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { RunState, RunStore, WorkflowEngine, workflowEffects, workflowModels } from './engine';
import { StepDefinition, stepRegistry } from './steps';
import { listModels, resolveSelector, studioModel } from './studioModels';
import { parseWorkflow, Workflow, workflowHash } from './workflow';

const REPOSITORY_FOLDER = path.join('.repository-manager', 'workflows');
const SUFFIX = '.workflow.json';

interface Found { label: string; where: string; file: string }

async function workflowFiles(folder: string, where: string): Promise<Found[]> {
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  return names.filter(name => name.endsWith(SUFFIX)).sort().map(name => ({ label: name.slice(0, -SUFFIX.length), where, file: path.join(folder, name) }));
}

/** What the Studio Chat uses to run a plan the way Run Workflow… runs a file. */
export interface StudioRuns {
  steps: Map<string, StepDefinition>;
  /** Asks the inputs, the models to use instead of missing ones, and the consent; then runs. Undefined when the person cancelled first. */
  run(workflow: Workflow, hash: string, onUpdate?: (state: RunState) => void): Promise<RunState | undefined>;
}

export function registerStudio(context: vscode.ExtensionContext, workspaceRoot: string): StudioRuns {
  const steps = stepRegistry();
  const library = path.join(context.globalStorageUri.fsPath, 'studio', 'workflows');
  const store = new RunStore(path.join(context.storageUri?.fsPath ?? context.globalStorageUri.fsPath, 'studio', 'runs'));
  const engine = new WorkflowEngine({ root: workspaceRoot, steps, store, model: studioModel(context) });
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

  /** What the run will send and change, asked once before it starts. */
  const consent = async (workflow: Workflow, models: Record<string, string>): Promise<boolean> => {
    const effects = workflowEffects(workflow, steps as Map<string, StepDefinition>);
    const named = workflowModels(workflow).map(selector => models[selector] ? `${selector} (instead: ${models[selector]})` : selector);
    const lines = [
      effects.promptNodes.length ? `Sends the input of ${effects.promptNodes.length} prompt step${effects.promptNodes.length === 1 ? '' : 's'} (${effects.promptNodes.join(', ')}) to ${named.length ? `Copilot: ${named.join(', ')}${workflow.defaults?.model ? '' : ', and the selected model for the others'}` : 'the selected Copilot model'}.` : 'Sends nothing to a model.',
      ...effects.effects.map(item => `Asks you before ${item.node} (${item.type}) ${item.effect === 'write' ? 'writes files' : item.effect === 'command' ? 'runs a command' : 'sends to another system'}.`),
      ...effects.gates.map(gate => `Stops for your answer at ${gate}.`)
    ];
    const run = 'Run';
    return await vscode.window.showInformationMessage(`Run "${workflow.title}" (${workflow.version})?`, { modal: true, detail: lines.join('\n') }, run) === run;
  };

  /** Runs on, asking at each gate, until the run is done, stopped, failed, or left waiting. */
  const drive = async (workflow: Workflow, state: RunState, onUpdate?: (state: RunState) => void): Promise<RunState> => {
    let current = state;
    onUpdate?.(current);
    // A run reopened from Show Workflow Runs may already be waiting: ask first, then go on.
    while (current.status === 'running' || current.status === 'waiting') {
      if (current.status === 'running') {
        current = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${workflow.title}`, cancellable: true },
          async (_progress, token) => engine.continue(workflow, current, { get cancelled() { return token.isCancellationRequested; } }));
        onUpdate?.(current);
        continue;
      }
      if (!current.waiting) { break; }
      const approve = current.waiting.kind === 'gate' ? 'Continue' : 'Approve';
      const show = 'Show in Editor';
      const stop = 'Stop Run';
      let answer: string | undefined;
      do {
        answer = await vscode.window.showWarningMessage(current.waiting.title, { modal: true,
          detail: current.waiting.preview.length > 1500 ? `${current.waiting.preview.slice(0, 1500)}\n… (Show in Editor for all of it)` : current.waiting.preview }, approve, show, stop);
        if (answer === show) {
          const document = await vscode.workspace.openTextDocument({ content: current.waiting.preview, language: 'markdown' });
          await vscode.window.showTextDocument(document, { preview: true });
        }
      } while (answer === show);
      // Closing the dialog leaves the run waiting (Show Workflow Runs takes it up again).
      if (answer === undefined) { return current; }
      current = await engine.answer(current, answer === approve);
      onUpdate?.(current);
    }
    if (current.status === 'done') {
      const written = Object.values(current.nodes).map(node => node.output).filter((output): output is { path: string } =>
        Boolean(output) && typeof (output as { path?: unknown }).path === 'string');
      const open = 'Open Result';
      if (await vscode.window.showInformationMessage(`${workflow.title}: done.`, ...(written.length ? [open] : [])) === open) {
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(workspaceRoot, written[written.length - 1].path)));
      }
    } else if (current.status === 'failed') {
      void vscode.window.showErrorMessage(`${workflow.title} failed: ${current.error ?? 'unknown error'}`);
    } else if (current.status === 'stopped') {
      void vscode.window.showInformationMessage(`${workflow.title} stopped: ${current.error ?? ''}`);
    }
    return current;
  };

  const run = async (workflow: Workflow, hash: string, onUpdate?: (state: RunState) => void): Promise<RunState | undefined> => {
    const inputs = await askInputs(workflow);
    if (!inputs) { return undefined; }
    const models = await replacements(workflow);
    if (!models || !await consent(workflow, models)) { return undefined; }
    try {
      return await drive(workflow, await engine.start(workflow, hash, inputs, models), onUpdate);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not run the workflow: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
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
    vscode.commands.registerCommand('repositoryManager.studio.showRuns', async () => {
      const runs = await store.list();
      const picked = await vscode.window.showQuickPick(runs.slice(0, 50).map(run => ({
        label: run.workflow.title, description: `${run.status}${run.waiting ? `: ${run.waiting.title}` : ''}`, detail: `${run.startedAt} · ${run.id}`, run
      })), { title: 'Workflow Runs', placeHolder: runs.length ? 'A waiting run goes on; others open their log' : 'No runs yet' });
      if (!picked) { return; }
      // A waiting run goes on with the workflow as it was when it started, even after a restart.
      if (picked.run.status === 'waiting') { await drive(await store.loadWorkflow(picked.run.id), picked.run); return; }
      const log = (await store.readLog(picked.run.id)).map(entry => JSON.stringify(entry)).join('\n');
      const document = await vscode.workspace.openTextDocument({ content: `${JSON.stringify(picked.run, null, 2)}\n\n${log}\n`, language: 'json' });
      await vscode.window.showTextDocument(document, { preview: true });
    })
  );
  return { steps, run };
}
