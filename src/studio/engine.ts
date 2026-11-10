/**
 * Runs a workflow (docs/agent-studio.md, "Engine"). Nodes run one at a time in dependency order.
 * Before any step with an effect, and at every gate, the run stops and waits for a person; it
 * is saved after each node, so it resumes where it stopped, even after a restart.
 * No `vscode` here.
 */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { condition, resolve, Scope } from './expressions';
import { CancelSignal, StepContext, StepDefinition, StepError, StudioModel } from './steps';
import { runOrder, Workflow, WorkflowNode } from './workflow';

export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
export type NodeStatus = 'pending' | 'done' | 'skipped' | 'failed';

export interface Waiting {
  node: string;
  /** gate: the workflow's own gate. effect: the engine's, before a step that writes, runs or sends. */
  kind: 'gate' | 'effect';
  title: string;
  effect: string;
  /** Exactly what will happen, for the person to read before approving. */
  preview: string;
}

export interface RunState {
  id: string;
  workflow: { id: string; version: string; title: string; hash: string };
  startedAt: string;
  updatedAt: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  nodes: Record<string, { status: NodeStatus; output?: unknown; error?: string }>;
  waiting?: Waiting;
  /** A person's answer at each gate, by node id. */
  approvals: Record<string, 'approved' | 'rejected'>;
  /** The workflow's criteria as they were when the run started. */
  criteria?: string[];
  /** Models the workflow names that this machine lacks, and the one the person chose instead. */
  models?: Record<string, string>;
  error?: string;
}

export type RunLogEntry = Record<string, unknown> & { at: string; type: string };

/** Where runs are kept: one folder per run, its state and an append-only log. */
export class RunStore {
  constructor(readonly folder: string) {}

  private dir(id: string): string {
    if (!/^[\w-]+$/.test(id)) { throw new Error(`"${id}" is not a run id.`); }
    return path.join(this.folder, id);
  }

  async save(state: RunState): Promise<void> {
    const dir = this.dir(state.id);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    // Written whole, then renamed: a crash never leaves half a state.
    await fs.writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
    await fs.rename(`${file}.tmp`, file);
  }

  async load(id: string): Promise<RunState> {
    return JSON.parse(await fs.readFile(path.join(this.dir(id), 'state.json'), 'utf8')) as RunState;
  }

  /** The workflow as it was when the run started, so the run can go on after a restart. */
  async saveWorkflow(id: string, workflow: Workflow): Promise<void> {
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'workflow.json'), JSON.stringify(workflow, null, 2));
  }

  async loadWorkflow(id: string): Promise<Workflow> {
    return JSON.parse(await fs.readFile(path.join(this.dir(id), 'workflow.json'), 'utf8')) as Workflow;
  }

  async log(id: string, entry: Record<string, unknown>): Promise<void> {
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  }

  async readLog(id: string): Promise<RunLogEntry[]> {
    const text = await fs.readFile(path.join(this.dir(id), 'log.jsonl'), 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as RunLogEntry]; } catch { return []; } });
  }

  async list(): Promise<RunState[]> {
    const names = await fs.readdir(this.folder).catch(() => [] as string[]);
    const states = await Promise.all(names.map(name => this.load(name).catch(() => undefined)));
    return states.filter((state): state is RunState => Boolean(state)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

export interface EngineOptions {
  root: string;
  steps: Map<string, StepDefinition>;
  store: RunStore;
  model?: StudioModel;
}

/** What a run sends or changes, for the consent asked before it starts. */
export interface WorkflowEffects { promptNodes: string[]; effects: Array<{ node: string; type: string; effect: string }>; gates: string[] }

/** Every model selector the workflow names (its default and its nodes'), each once. */
export function workflowModels(workflow: Workflow): string[] {
  return [...new Set([workflow.defaults?.model, ...workflow.nodes.map(node => node.model)].filter((model): model is string => Boolean(model)))];
}

export function workflowEffects(workflow: Workflow, steps: Map<string, StepDefinition>): WorkflowEffects {
  const promptNodes: string[] = [];
  const effects: WorkflowEffects['effects'] = [];
  const gates: string[] = [];
  for (const node of workflow.nodes) {
    const step = steps.get(node.type);
    if (!step) { continue; }
    if (step.usesModel) { promptNodes.push(node.id); }
    if (step.effect !== 'read') { effects.push({ node: node.id, type: node.type, effect: step.effect }); }
    if (node.type === 'gate') { gates.push(node.id); }
  }
  return { promptNodes, effects, gates };
}

export class WorkflowEngine {
  constructor(private readonly options: EngineOptions) {}

  /** A new run, saved before anything runs. Inputs left out take their defaults. */
  async start(workflow: Workflow, hash: string, inputs: Record<string, unknown>, models: Record<string, string> = {}): Promise<RunState> {
    const now = new Date().toISOString();
    const given: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(workflow.inputs ?? {})) {
      const value = inputs[name] ?? spec.default;
      if (value === undefined || value === '') { throw new StepError(`The input "${spec.title ?? name}" has no value.`); }
      given[name] = value;
    }
    const state: RunState = {
      id: `${now.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
      workflow: { id: workflow.id, version: workflow.version, title: workflow.title, hash },
      startedAt: now, updatedAt: now, status: 'running', inputs: given,
      nodes: Object.fromEntries(workflow.nodes.map(node => [node.id, { status: 'pending' as NodeStatus }])),
      approvals: {},
      ...(workflow.criteria?.length ? { criteria: [...workflow.criteria] } : {}),
      ...(Object.keys(models).length ? { models: { ...models } } : {})
    };
    await this.options.store.saveWorkflow(state.id, workflow);
    await this.options.store.save(state);
    await this.options.store.log(state.id, { type: 'start', workflow: state.workflow, inputs: Object.keys(given), ...(state.models ? { models: state.models } : {}) });
    return state;
  }

  /** The person's answer to what the run waits for; continue() then goes on (or stops). */
  async answer(state: RunState, approved: boolean): Promise<RunState> {
    if (state.status !== 'waiting' || !state.waiting) { return state; }
    const node = state.waiting.node;
    state.approvals[node] = approved ? 'approved' : 'rejected';
    await this.options.store.log(state.id, { type: 'approval', node, kind: state.waiting.kind, approved });
    state.waiting = undefined;
    if (approved) { state.status = 'running'; } else { state.status = 'stopped'; state.error = `Not approved at "${node}".`; }
    await this.save(state);
    return state;
  }

  /** Runs until the workflow is done, a person must answer, a node fails, or it is cancelled. */
  async continue(workflow: Workflow, state: RunState, signal: CancelSignal): Promise<RunState> {
    if (state.status !== 'running') { return state; }
    const { steps, store } = this.options;
    const scope = (): Scope => ({
      inputs: state.inputs,
      nodes: Object.fromEntries(Object.entries(state.nodes).filter(([, node]) => node.status === 'done').map(([id, node]) => [id, { output: node.output }]))
    });
    try {
      for (const id of runOrder(workflow)) {
        if (state.nodes[id]?.status !== 'pending') { continue; }
        if (signal.cancelled) { return await this.stop(state, 'Cancelled'); }
        const node = workflow.nodes.find(candidate => candidate.id === id)!;
        const step = steps.get(node.type);
        if (!step) { return await this.fail(state, id, `Unknown step type "${node.type}".`); }

        // A node with incoming edges runs if at least one of them is taken.
        const incoming = (workflow.edges ?? []).filter(edge => edge.to === id);
        if (incoming.length) {
          const taken = incoming.some(edge => state.nodes[edge.from]?.status === 'done' && (!edge.when || condition(edge.when, scope())));
          if (!taken) {
            state.nodes[id] = { status: 'skipped' };
            await store.log(state.id, { type: 'skip', node: id });
            await this.save(state);
            continue;
          }
        }

        // One input per run of the step: once, or once per item of forEach.
        const base = scope();
        const looped = node.forEach === undefined ? undefined : resolve(node.forEach, base);
        // A declared loop needs a list: a missing value is an error, not one run.
        if (node.forEach !== undefined && !Array.isArray(looped)) {
          return await this.fail(state, id, `"forEach" (${node.forEach}) did not give a list (${looped === null ? 'null' : typeof looped}).`);
        }
        const items = looped as unknown[] | undefined;
        const runs = (items ?? [undefined]).map((item, index) => ({
          item, index, input: resolve(node.with ?? {}, items ? { ...base, item, index } : base) as Record<string, unknown>
        }));

        // An empty list: nothing to run, and nothing to ask.
        if (items && !items.length) {
          state.nodes[id] = { status: 'done', output: [] };
          await store.log(state.id, { type: 'done', node: id, runs: 0 });
          await this.save(state);
          continue;
        }

        const context = this.context(workflow, node, state, signal);
        // The engine's gate: before a step that writes, runs a command or sends; and at every gate node.
        const asks = node.type === 'gate' || step.effect !== 'read';
        if (asks && state.approvals[id] !== 'approved') {
          const previews = await Promise.all(runs.map(run => step.preview ? step.preview(run.input, context) : Promise.resolve(JSON.stringify(run.input, null, 2))));
          state.status = 'waiting';
          state.waiting = {
            node: id,
            kind: node.type === 'gate' ? 'gate' : 'effect',
            title: node.type === 'gate' ? String(runs[0].input.title ?? node.title ?? id) : `${step.title}: ${node.title ?? id}`,
            effect: step.effect,
            preview: previews.length > 1 ? previews.map((text, index) => `[${index + 1}/${previews.length}]\n${text}`).join('\n\n') : previews[0]
          };
          await store.log(state.id, { type: 'waiting', node: id, kind: state.waiting.kind, effect: step.effect });
          await this.save(state);
          return state;
        }

        await store.log(state.id, { type: 'node', node: id, step: node.type, runs: runs.length });
        const outputs: unknown[] = [];
        for (const run of runs) {
          if (signal.cancelled) { return await this.stop(state, 'Cancelled'); }
          try {
            outputs.push(await step.run(run.input, context));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (signal.cancelled || message === 'Cancelled') { return await this.stop(state, 'Cancelled'); }
            return await this.fail(state, id, items ? `Item ${run.index + 1}: ${message}` : message);
          }
        }
        state.nodes[id] = { status: 'done', output: items ? outputs : outputs[0] };
        await store.log(state.id, { type: 'done', node: id });
        await this.save(state);
      }
    } catch (error) {
      // A condition or reference that cannot be read at run time.
      const current = Object.entries(state.nodes).find(([, node]) => node.status === 'pending');
      return await this.fail(state, current?.[0] ?? '', error instanceof Error ? error.message : String(error));
    }
    state.status = 'done';
    await store.log(state.id, { type: 'finish', status: 'done' });
    await this.save(state);
    return state;
  }

  private context(workflow: Workflow, node: WorkflowNode, state: RunState, signal: CancelSignal): StepContext {
    const named = node.model ?? workflow.defaults?.model;
    return {
      root: this.options.root, model: this.options.model, signal, workflow, node,
      modelSelector: named ? state.models?.[named] ?? named : undefined,
      log: event => { void this.options.store.log(state.id, event); }
    };
  }

  private async save(state: RunState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await this.options.store.save(state);
  }

  private async fail(state: RunState, node: string, message: string): Promise<RunState> {
    if (node && state.nodes[node]) { state.nodes[node] = { status: 'failed', error: message }; }
    state.status = 'failed';
    state.error = node ? `${node}: ${message}` : message;
    await this.options.store.log(state.id, { type: 'finish', status: 'failed', node, error: message });
    await this.save(state);
    return state;
  }

  private async stop(state: RunState, reason: string): Promise<RunState> {
    state.status = 'stopped';
    state.error = reason;
    await this.options.store.log(state.id, { type: 'finish', status: 'stopped', reason });
    await this.save(state);
    return state;
  }
}
