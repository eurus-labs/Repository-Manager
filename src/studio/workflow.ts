/**
 * The workflow file (docs/agent-studio.md, "Workflow JSON") and its validation. A workflow is
 * shared as one file, so everything it uses is checked here before it runs: its steps exist,
 * its edges form no cycle, and each reference reads something that has run by then.
 * No `vscode` here.
 */
import { createHash } from 'crypto';
import * as path from 'path';
import { ExpressionError, parsePath, referencesIn } from './expressions';
import { JsonSchema, schemaProblems } from './jsonSchema';
import { MAX_NODE_SKILLS, SKILL_REF } from './skills';

export const WORKFLOW_FORMAT = 'repository-manager/workflow@1';

export type InputType = 'string' | 'folder' | 'repository';

export interface WorkflowInput {
  type: InputType;
  title?: string;
  description?: string;
  /** Used when the person gives no value. */
  default?: unknown;
}

export interface PromptSpec {
  /** What the model is asked to do. The node's resolved `with` is sent as the input. */
  instructions: string;
  /** The name of a type in `types` the reply must fit. */
  output?: string;
}

export interface WorkflowNode {
  id: string;
  type: string;
  title?: string;
  /** For `prompt` nodes: the name of a prompt in `prompts`. */
  prompt?: string;
  /** The step's settings; strings may hold `${…}` references. */
  with?: Record<string, unknown>;
  /** A reference to a list: the node runs once per item, with `${item}` and `${index}`. */
  forEach?: string;
  /** For steps that use a model: `<vendor>:<family>`, instead of the workflow's default. */
  model?: string;
  /** For steps that use a model: skills pinned to a commit (`github:<owner>/<repo>/<folder>@<commit>`). */
  skills?: string[];
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** The edge is followed only when this condition holds. */
  when?: string;
}

export interface Workflow {
  schema: typeof WORKFLOW_FORMAT;
  id: string;
  version: string;
  title: string;
  description?: string;
  inputs?: Record<string, WorkflowInput>;
  types?: Record<string, JsonSchema>;
  prompts?: Record<string, PromptSpec>;
  nodes: WorkflowNode[];
  edges?: WorkflowEdge[];
  /** Diagram positions only; running ignores them. */
  layout?: Record<string, [number, number]>;
  /** What "done" means, proposed with a plan and frozen when a run starts. */
  criteria?: string[];
  defaults?: { model?: string };
}

/** What validation needs to know of each step type. */
export interface StepShape {
  type: string;
  required: string[];
  optional?: string[];
  /** Settings that name a path and must stay inside the workspace when written in the file. */
  localPaths?: string[];
  /** Sends to a model: only such a step may name its own `model`. */
  usesModel?: boolean;
  /** Settings that are lists of paths that must each stay inside the workspace. */
  pathLists?: string[];
  /** Runs once: no `forEach` (a step a person reviews after it runs). */
  single?: boolean;
}

export interface Problem { where: string; message: string }

const NODE_ID = /^[a-z][a-z0-9-]*$/;
/** `<vendor>:<family>`, as vscode.lm names a model: matched on the machine that runs it. */
// The part after ":" is a family, or the id of a model that has none (custom endpoints: "org/model:tag").
export const MODEL_SELECTOR = /^[A-Za-z0-9_.-]{1,60}:[A-Za-z0-9_.:/@+-]{1,200}$/;
export const MAX_CRITERIA = 20;
const MAX_CRITERION_CHARS = 500;
const RESERVED = new Set(['inputs', 'item', 'index']);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A stable fingerprint of the file's content, recorded with each run. */
export function workflowHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The nodes in the order they run: each after every node it depends on, ties in file order. */
export function runOrder(workflow: Workflow): string[] {
  const ids = workflow.nodes.map(node => node.id);
  const incoming = new Map(ids.map(id => [id, new Set<string>()]));
  for (const edge of workflow.edges ?? []) { incoming.get(edge.to)?.add(edge.from); }
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < ids.length) {
    const next = ids.find(id => !placed.has(id) && [...incoming.get(id)!].every(from => placed.has(from)));
    if (!next) { break; } // a cycle; validation reports it
    order.push(next);
    placed.add(next);
  }
  return order;
}

/** Every node that runs before `id` along the edges. */
export function upstreamOf(workflow: Workflow, id: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of workflow.edges ?? []) { incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]); }
  const found = new Set<string>();
  const stack = [...(incoming.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (found.has(next)) { continue; }
    found.add(next);
    stack.push(...(incoming.get(next) ?? []));
  }
  return found;
}

/** A path written in the workflow file must be relative and stay inside the workspace. */
export function isLocalPath(value: string): boolean {
  if (!value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\0')) { return false; }
  const normal = path.posix.normalize(value.replace(/\\/g, '/'));
  return normal !== '..' && !normal.startsWith('../');
}

/** Parses the file's text; problems instead of a workflow when it cannot be used. */
export function parseWorkflow(text: string, steps: Map<string, StepShape>): { workflow?: Workflow; problems: Problem[] } {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    return { problems: [{ where: 'file', message: `Not JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const problems = validateWorkflow(value, steps);
  return problems.length ? { problems } : { workflow: value as Workflow, problems };
}

export function validateWorkflow(value: unknown, steps: Map<string, StepShape>): Problem[] {
  const problems: Problem[] = [];
  const add = (where: string, message: string) => problems.push({ where, message });
  if (!record(value)) { return [{ where: 'file', message: 'A workflow is a JSON object.' }]; }
  if (value.schema !== WORKFLOW_FORMAT) { add('schema', `Expected "${WORKFLOW_FORMAT}"${typeof value.schema === 'string' ? `, found "${value.schema}"` : ''}.`); }
  for (const key of ['id', 'version', 'title'] as const) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim()) { add(key, `"${key}" is required text.`); }
  }
  if (typeof value.id === 'string' && !NODE_ID.test(value.id)) { add('id', 'Use lowercase letters, digits and dashes, starting with a letter.'); }

  const inputs = record(value.inputs) ? value.inputs : {};
  if (value.inputs !== undefined && !record(value.inputs)) { add('inputs', '"inputs" is an object of named inputs.'); }
  for (const [name, input] of Object.entries(inputs)) {
    if (!record(input) || !['string', 'folder', 'repository'].includes(input.type as string)) {
      add(`inputs.${name}`, 'Each input has a type: string, folder or repository.');
    }
  }
  if (value.criteria !== undefined) {
    if (!Array.isArray(value.criteria) || value.criteria.some(item => typeof item !== 'string' || !item.trim() || item.length > MAX_CRITERION_CHARS)) {
      add('criteria', `"criteria" is a list of text, each at most ${MAX_CRITERION_CHARS} characters.`);
    } else if (value.criteria.length > MAX_CRITERIA) { add('criteria', `At most ${MAX_CRITERIA} criteria.`); }
  }
  if (value.defaults !== undefined) {
    if (!record(value.defaults)) { add('defaults', '"defaults" is an object.'); }
    else {
      for (const key of Object.keys(value.defaults)) { if (key !== 'model') { add(`defaults.${key}`, `"defaults" has no setting "${key}".`); } }
      if (value.defaults.model !== undefined && !(typeof value.defaults.model === 'string' && MODEL_SELECTOR.test(value.defaults.model))) {
        add('defaults.model', 'Name a model as "<vendor>:<family>", such as "copilot:gpt-4o".');
      }
    }
  }
  const types = record(value.types) ? value.types : {};
  for (const [name, schema] of Object.entries(types)) {
    for (const message of schemaProblems(schema, `types.${name}`)) { add(`types.${name}`, message); }
  }
  const prompts = record(value.prompts) ? value.prompts : {};
  for (const [name, prompt] of Object.entries(prompts)) {
    if (!record(prompt) || typeof prompt.instructions !== 'string' || !prompt.instructions.trim()) { add(`prompts.${name}`, 'A prompt needs "instructions".'); continue; }
    if (prompt.output !== undefined && !(typeof prompt.output === 'string' && prompt.output in types)) {
      add(`prompts.${name}.output`, `"${String(prompt.output)}" is not one of the workflow's types.`);
    }
  }

  if (!Array.isArray(value.nodes) || !value.nodes.length) { add('nodes', 'A workflow has at least one node.'); return problems; }
  const nodes = value.nodes as unknown[];
  const ids = new Set<string>();
  // Only problems that make the graph unreadable stop the checks below.
  let unreadable = false;
  for (const [index, node] of nodes.entries()) {
    const where = `nodes[${index}]`;
    if (!record(node) || typeof node.id !== 'string' || typeof node.type !== 'string') { add(where, 'Each node has an "id" and a "type".'); unreadable = true; continue; }
    if (!NODE_ID.test(node.id) || RESERVED.has(node.id)) { add(`${where}.id`, `"${node.id}": use lowercase letters, digits and dashes; inputs, item and index are reserved.`); }
    if (ids.has(node.id)) { add(`${where}.id`, `"${node.id}" is used twice.`); unreadable = true; }
    ids.add(node.id);
  }
  const edges = Array.isArray(value.edges) ? value.edges as unknown[] : [];
  if (value.edges !== undefined && !Array.isArray(value.edges)) { add('edges', '"edges" is a list.'); }
  for (const [index, edge] of edges.entries()) {
    if (!record(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string') { add(`edges[${index}]`, 'Each edge has "from" and "to".'); unreadable = true; continue; }
    if (!ids.has(edge.from)) { add(`edges[${index}].from`, `No node "${edge.from}".`); unreadable = true; }
    if (!ids.has(edge.to)) { add(`edges[${index}].to`, `No node "${edge.to}".`); unreadable = true; }
    if (edge.when !== undefined && typeof edge.when !== 'string') { add(`edges[${index}].when`, 'A condition is text.'); }
  }
  if (unreadable) { return problems; }

  const workflow = value as unknown as Workflow;
  if (runOrder(workflow).length < workflow.nodes.length) {
    add('edges', 'The edges form a cycle. Use "forEach" on a node to repeat it.');
    return problems;
  }

  // Each reference must read an input, the loop item, or a node that runs before it.
  const checkReference = (where: string, reference: string, node: WorkflowNode | undefined, upstream: Set<string>) => {
    let segments: Array<string | number>;
    try { segments = parsePath(reference); } catch (error) { add(where, (error as ExpressionError).message); return; }
    const root = String(segments[0]);
    if (root === 'inputs') {
      if (segments.length < 2 || !(String(segments[1]) in inputs)) { add(where, `"\${${reference}}": no input "${String(segments[1] ?? '')}".`); }
    } else if (root === 'item' || root === 'index') {
      if (!node?.forEach) { add(where, `"\${${reference}}": only a node with "forEach" has ${root}.`); }
    } else if (!ids.has(root)) {
      add(where, `"\${${reference}}": no node "${root}".`);
    } else if (!upstream.has(root)) {
      add(where, `"\${${reference}}": "${root}" does not run before this. Add an edge from it.`);
    } else if (segments[1] !== 'output') {
      add(where, `"\${${reference}}": read a node's result as ${root}.output.`);
    }
  };

  for (const [index, node] of workflow.nodes.entries()) {
    const where = `nodes[${index}] (${node.id})`;
    const shape = steps.get(node.type);
    if (!shape) { add(where, `Unknown step type "${node.type}".`); continue; }
    const settings = node.with ?? {};
    if (!record(settings)) { add(`${where}.with`, '"with" is an object.'); continue; }
    for (const key of shape.required) { if (!(key in settings)) { add(`${where}.with.${key}`, `"${node.type}" needs "${key}".`); } }
    const known = new Set([...shape.required, ...(shape.optional ?? [])]);
    for (const key of Object.keys(settings)) { if (!known.has(key)) { add(`${where}.with.${key}`, `"${node.type}" has no setting "${key}".`); } }
    for (const key of shape.localPaths ?? []) {
      const setting = settings[key];
      const literal = typeof setting === 'string' ? setting : record(setting) && typeof setting.path === 'string' ? setting.path : undefined;
      if (literal !== undefined && !literal.includes('${') && !isLocalPath(literal)) {
        add(`${where}.with.${key}`, `"${literal}" must be a path inside the workspace (relative, no "..").`);
      }
    }
    for (const key of shape.pathLists ?? []) {
      const setting = settings[key];
      if (setting === undefined || (typeof setting === 'string' && setting.includes('${'))) { continue; }
      if (!Array.isArray(setting) || !setting.length || setting.some(item => typeof item !== 'string' || (!item.includes('${') && !isLocalPath(item.replace(/\/$/, ''))))) {
        add(`${where}.with.${key}`, `"${key}" is a list of paths inside the workspace (relative, no ".."; a folder ends with "/").`);
      }
    }
    if (shape.single && node.forEach !== undefined) { add(`${where}.forEach`, `"${node.type}" is reviewed after it runs, so it cannot loop.`); }
    if (node.model !== undefined) {
      if (!(typeof node.model === 'string' && MODEL_SELECTOR.test(node.model))) { add(`${where}.model`, 'Name a model as "<vendor>:<family>", such as "copilot:gpt-4o".'); }
      else if (!shape.usesModel) { add(`${where}.model`, `"${node.type}" does not use a model.`); }
    }
    if (node.skills !== undefined) {
      if (!Array.isArray(node.skills) || node.skills.some(ref => typeof ref !== 'string' || !SKILL_REF.test(ref))) {
        add(`${where}.skills`, 'Skills are a list of references: github:<owner>/<repo>/<folder>@<40-character commit>.');
      } else if (node.skills.length > MAX_NODE_SKILLS) { add(`${where}.skills`, `At most ${MAX_NODE_SKILLS} skills on a step.`); }
      else if (!shape.usesModel) { add(`${where}.skills`, `"${node.type}" does not use a model, so it cannot follow skills.`); }
    }
    if (node.type === 'prompt' && !(typeof node.prompt === 'string' && node.prompt in prompts)) {
      add(`${where}.prompt`, `"${String(node.prompt)}" is not one of the workflow's prompts.`);
    }
    const upstream = upstreamOf(workflow, node.id);
    for (const reference of referencesIn(settings)) { checkReference(`${where}.with`, reference, node, upstream); }
    if (node.forEach !== undefined) {
      const match = typeof node.forEach === 'string' ? /^\$\{([^{}]+)\}$/.exec(node.forEach.trim()) : null;
      if (!match) { add(`${where}.forEach`, 'Write "forEach" as one reference, such as "${compare.output.changes}".'); }
      else if (/^(item|index)\b/.test(match[1].trim())) { add(`${where}.forEach`, 'A loop cannot loop over its own item.'); }
      else { checkReference(`${where}.forEach`, match[1], undefined, upstream); }
    }
  }
  for (const [index, edge] of workflow.edges?.entries() ?? []) {
    if (!edge.when) { continue; }
    const upstream = new Set([...upstreamOf(workflow, edge.from), edge.from]);
    for (const reference of referencesIn(edge.when)) { checkReference(`edges[${index}].when`, reference, undefined, upstream); }
  }
  return problems;
}
