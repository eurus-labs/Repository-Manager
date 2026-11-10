/**
 * Edits the visual editor makes to a workflow (docs/agent-studio.md, "Visual editor"). The page
 * sends an operation; the host applies it here to the parsed file and writes the result back
 * into the document, so the JSON stays the only source and VS Code's undo, save and the text
 * editor all see the same thing. No `vscode` here.
 */
import { parsePath, referencesIn } from './expressions';
import { Workflow, WorkflowEdge, WorkflowNode } from './workflow';

export class EditError extends Error {}

export type EditOperation =
  | { op: 'setWorkflow'; field: 'id' | 'version' | 'title' | 'description'; value: string }
  | { op: 'addNode'; type: string; at?: [number, number] }
  | { op: 'removeNode'; id: string }
  | { op: 'renameNode'; id: string; to: string }
  | { op: 'setNode'; id: string; field: 'title' | 'prompt' | 'forEach' | 'model'; value: string }
  | { op: 'setDefaultModel'; value: string }
  | { op: 'setCriteria'; criteria: string[] }
  | { op: 'setSetting'; id: string; key: string; value: string }
  | { op: 'move'; id: string; at: [number, number] }
  | { op: 'addEdge'; from: string; to: string }
  | { op: 'removeEdge'; index: number }
  | { op: 'setEdgeWhen'; index: number; value: string }
  | { op: 'setInput'; name: string; field: 'type' | 'title' | 'description' | 'default'; value: string }
  | { op: 'addInput'; name: string }
  | { op: 'removeInput'; name: string }
  | { op: 'setPrompt'; name: string; field: 'instructions' | 'output'; value: string }
  | { op: 'addPrompt'; name: string }
  | { op: 'removePrompt'; name: string }
  | { op: 'setType'; name: string; schema: string }
  | { op: 'addType'; name: string }
  | { op: 'removeType'; name: string }
  | { op: 'arrange' };

const NAME = /^[a-z][a-z0-9-]*$/;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const COLUMN = 260;
const ROW = 120;

/** The file as the editor writes it: two-space JSON and a final newline, keys in a stable order. */
export function serializeWorkflow(workflow: Workflow): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ['schema', 'id', 'version', 'title', 'description', 'criteria', 'defaults', 'inputs', 'types', 'prompts', 'nodes', 'edges', 'layout']) {
    const value = (workflow as unknown as Record<string, unknown>)[key];
    if (value !== undefined) { ordered[key] = value; }
  }
  for (const [key, value] of Object.entries(workflow)) { if (!(key in ordered)) { ordered[key] = value; } }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** A setting typed in a form: JSON when it reads as JSON (a list, an object, a number…), text otherwise. */
export function settingValue(text: string): unknown {
  const trimmed = text.trim();
  // A quoted value is text that would otherwise read as JSON ("12", "true").
  if (/^[[{]/.test(trimmed) || /^"[\s\S]*"$/.test(trimmed) || /^(-?\d+(\.\d+)?|true|false|null)$/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { if (/^[[{]/.test(trimmed)) { throw new EditError(`Not valid JSON: ${trimmed.slice(0, 60)}`); } }
  }
  return text;
}

/** How a setting is shown in a form field (the reverse of settingValue). */
export function settingText(value: unknown): string {
  if (typeof value === 'string') {
    // Text that would read as JSON, or fail to ("[note] hello"), is shown quoted so it stays text.
    let readsAs: unknown;
    try { readsAs = settingValue(value); } catch { readsAs = undefined; }
    if (readsAs === value) { return value; }
  }
  return JSON.stringify(value, null, 2);
}

/** Each node's position: the saved one, or a column by depth along the edges and a row in it. */
export function positions(workflow: Workflow): Record<string, [number, number]> {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const edge of workflow.edges ?? []) { incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]); }
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) { return depth.get(id)!; }
    if (seen.has(id)) { return 0; } // a cycle: validation reports it
    seen.add(id);
    const value = Math.max(-1, ...(incoming.get(id) ?? []).map(from => depthOf(from, seen))) + 1;
    depth.set(id, value);
    return value;
  };
  const rows = new Map<number, number>();
  const placed: Record<string, [number, number]> = {};
  for (const node of workflow.nodes ?? []) {
    const column = depthOf(node.id);
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    placed[node.id] = workflow.layout?.[node.id] ?? [column * COLUMN, row * ROW];
  }
  return placed;
}

/** `${old…}` references in a value, made to read `to` instead. */
function renameIn(value: unknown, old: string, to: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^{}]+)\}/g, (whole, reference: string) => {
      try { return String(parsePath(reference)[0]) === old ? `\${${to}${reference.trim().slice(old.length)}}` : whole; } catch { return whole; }
    });
  }
  if (Array.isArray(value)) { return value.map(item => renameIn(item, old, to)); }
  if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renameIn(item, old, to)])); }
  return value;
}

const nodeOf = (workflow: Workflow, id: string): WorkflowNode => {
  const node = workflow.nodes.find(candidate => candidate.id === id);
  if (!node) { throw new EditError(`No node "${id}".`); }
  return node;
};

const freeId = (workflow: Workflow, type: string) => {
  const stem = type.split('.').pop()!.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'node';
  for (let n = 1; ; n++) { const id = `${stem}-${n}`; if (!workflow.nodes.some(node => node.id === id)) { return id; } }
};

const checkName = (name: string, pattern: RegExp, what: string) => {
  if (!pattern.test(name)) { throw new EditError(`"${name}" is not a valid ${what} name.`); }
};

/** The workflow after one edit. The input is not changed. */
export function applyEdit(source: Workflow, operation: EditOperation, settings: (type: string) => string[] = () => []): Workflow {
  const workflow = JSON.parse(JSON.stringify(source)) as Workflow;
  workflow.nodes = workflow.nodes ?? [];
  const edges = (): WorkflowEdge[] => (workflow.edges = workflow.edges ?? []);
  const layout = () => (workflow.layout = workflow.layout ?? {});
  switch (operation.op) {
    case 'setWorkflow':
      if (operation.field === 'description' && !operation.value) { delete workflow.description; } else { workflow[operation.field] = operation.value; }
      break;
    case 'addNode': {
      const id = freeId(workflow, operation.type);
      const node: WorkflowNode = { id, type: operation.type };
      // The settings a step needs are there to fill in.
      const required = settings(operation.type);
      if (required.length) { node.with = Object.fromEntries(required.map(key => [key, ''])); }
      workflow.nodes.push(node);
      layout()[id] = operation.at ?? positions(workflow)[id];
      break;
    }
    case 'removeNode':
      nodeOf(workflow, operation.id);
      workflow.nodes = workflow.nodes.filter(node => node.id !== operation.id);
      workflow.edges = edges().filter(edge => edge.from !== operation.id && edge.to !== operation.id);
      delete layout()[operation.id];
      break;
    case 'renameNode': {
      const node = nodeOf(workflow, operation.id);
      checkName(operation.to, NAME, 'node');
      if (['inputs', 'item', 'index'].includes(operation.to)) { throw new EditError(`"${operation.to}" is reserved.`); }
      if (operation.to !== operation.id && workflow.nodes.some(other => other.id === operation.to)) { throw new EditError(`"${operation.to}" is already a node.`); }
      node.id = operation.to;
      // Everything that names it follows: edges, positions, and the references that read it.
      for (const edge of edges()) {
        if (edge.from === operation.id) { edge.from = operation.to; }
        if (edge.to === operation.id) { edge.to = operation.to; }
        if (edge.when) { edge.when = renameIn(edge.when, operation.id, operation.to) as string; }
      }
      for (const other of workflow.nodes) {
        if (other.with) { other.with = renameIn(other.with, operation.id, operation.to) as Record<string, unknown>; }
        if (other.forEach) { other.forEach = renameIn(other.forEach, operation.id, operation.to) as string; }
      }
      if (workflow.layout && operation.id in workflow.layout) {
        workflow.layout[operation.to] = workflow.layout[operation.id];
        if (operation.to !== operation.id) { delete workflow.layout[operation.id]; }
      }
      break;
    }
    case 'setNode': {
      const node = nodeOf(workflow, operation.id);
      if (operation.value.trim()) { node[operation.field] = operation.value; } else { delete node[operation.field]; }
      break;
    }
    case 'setDefaultModel':
      if (operation.value.trim()) { workflow.defaults = { ...workflow.defaults, model: operation.value.trim() }; }
      else if (workflow.defaults) { delete workflow.defaults.model; if (!Object.keys(workflow.defaults).length) { delete workflow.defaults; } }
      break;
    case 'setCriteria': {
      if (!Array.isArray(operation.criteria)) { throw new EditError('Criteria are a list.'); }
      const criteria = operation.criteria.map(item => String(item).trim()).filter(Boolean);
      if (criteria.length) { workflow.criteria = criteria; } else { delete workflow.criteria; }
      break;
    }
    case 'setSetting': {
      const node = nodeOf(workflow, operation.id);
      node.with = node.with ?? {};
      if (operation.value === '' && !settings(node.type).includes(operation.key)) { delete node.with[operation.key]; }
      else { node.with[operation.key] = settingValue(operation.value); }
      if (!Object.keys(node.with).length) { delete node.with; }
      break;
    }
    case 'move':
      nodeOf(workflow, operation.id);
      layout()[operation.id] = [Math.round(operation.at[0]), Math.round(operation.at[1])];
      break;
    case 'addEdge':
      nodeOf(workflow, operation.from);
      nodeOf(workflow, operation.to);
      if (operation.from === operation.to) { throw new EditError('A node cannot follow itself.'); }
      if (!edges().some(edge => edge.from === operation.from && edge.to === operation.to)) { edges().push({ from: operation.from, to: operation.to }); }
      break;
    case 'removeEdge':
      if (!edges()[operation.index]) { throw new EditError('No such edge.'); }
      edges().splice(operation.index, 1);
      break;
    case 'setEdgeWhen': {
      const edge = edges()[operation.index];
      if (!edge) { throw new EditError('No such edge.'); }
      if (operation.value.trim()) { edge.when = operation.value; } else { delete edge.when; }
      break;
    }
    case 'addInput':
      checkName(operation.name, TYPE_NAME, 'input');
      workflow.inputs = { ...(workflow.inputs ?? {}) };
      if (operation.name in workflow.inputs) { throw new EditError(`"${operation.name}" is already an input.`); }
      workflow.inputs[operation.name] = { type: 'string', title: operation.name };
      break;
    case 'removeInput':
      if (workflow.inputs) { delete workflow.inputs[operation.name]; }
      break;
    case 'setInput': {
      const input = workflow.inputs?.[operation.name];
      if (!input) { throw new EditError(`No input "${operation.name}".`); }
      if (operation.field === 'type') {
        if (!['string', 'folder', 'repository'].includes(operation.value)) { throw new EditError('An input is string, folder or repository.'); }
        input.type = operation.value as 'string' | 'folder' | 'repository';
      } else if (!operation.value) { delete input[operation.field]; }
      else { input[operation.field] = operation.field === 'default' ? settingValue(operation.value) as string : operation.value; }
      break;
    }
    case 'addPrompt':
      checkName(operation.name, NAME, 'prompt');
      workflow.prompts = { ...(workflow.prompts ?? {}) };
      if (operation.name in workflow.prompts) { throw new EditError(`"${operation.name}" is already a prompt.`); }
      workflow.prompts[operation.name] = { instructions: 'Describe what the model should do with the input.' };
      break;
    case 'removePrompt':
      if (workflow.prompts) { delete workflow.prompts[operation.name]; }
      break;
    case 'setPrompt': {
      const prompt = workflow.prompts?.[operation.name];
      if (!prompt) { throw new EditError(`No prompt "${operation.name}".`); }
      if (operation.field === 'output' && !operation.value) { delete prompt.output; } else { prompt[operation.field] = operation.value; }
      break;
    }
    case 'addType':
      checkName(operation.name, TYPE_NAME, 'type');
      workflow.types = { ...(workflow.types ?? {}) };
      if (operation.name in workflow.types) { throw new EditError(`"${operation.name}" is already a type.`); }
      workflow.types[operation.name] = { type: 'object', properties: {}, required: [] };
      break;
    case 'removeType':
      if (workflow.types) { delete workflow.types[operation.name]; }
      break;
    case 'setType': {
      if (!workflow.types?.[operation.name]) { throw new EditError(`No type "${operation.name}".`); }
      let schema: unknown;
      try { schema = JSON.parse(operation.schema); } catch { throw new EditError('The schema is not valid JSON.'); }
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { throw new EditError('A schema is a JSON object.'); }
      workflow.types[operation.name] = schema;
      break;
    }
    case 'arrange': {
      delete workflow.layout;
      workflow.layout = positions(workflow);
      break;
    }
    default:
      throw new EditError(`Unknown edit "${(operation as { op?: unknown }).op}".`);
  }
  if (workflow.edges && !workflow.edges.length) { delete workflow.edges; }
  return workflow;
}

/** The node ids a validation problem is about, from its "nodes[i] (id)" or "edges[i]" place. */
export function problemNodes(workflow: Workflow, where: string): string[] {
  const node = /^nodes\[(\d+)\]/.exec(where);
  if (node) { const id = workflow.nodes?.[Number(node[1])]?.id; return id ? [id] : []; }
  const edge = /^edges\[(\d+)\]/.exec(where);
  if (edge) { const found = workflow.edges?.[Number(edge[1])]; return found ? [found.from, found.to] : []; }
  return [];
}

/** The references a node reads, for the side panel. */
export function nodeReferences(node: WorkflowNode): string[] {
  return [...new Set([...referencesIn(node.with ?? {}), ...referencesIn(node.forEach ?? '')])];
}
