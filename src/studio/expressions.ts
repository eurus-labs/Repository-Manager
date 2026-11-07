/**
 * `${…}` references in a workflow (docs/agent-studio.md): values from the run's inputs, earlier
 * nodes' outputs and the current loop item, and the conditions on edges. A small grammar parsed
 * here, never evaluated as JavaScript, so a shared workflow cannot run code. No `vscode` here.
 */

export class ExpressionError extends Error {}

/** What a reference may read: `inputs`, `item`, `index`, and each finished node by id. */
export interface Scope {
  inputs: Record<string, unknown>;
  nodes: Record<string, { output?: unknown }>;
  item?: unknown;
  index?: number;
}

const WHOLE = /^\$\{([^{}]+)\}$/;
const PART = /\$\{([^{}]+)\}/g;
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** `a.b[0].c` as segments: names and indexes. */
export function parsePath(text: string): Array<string | number> {
  const source = text.trim();
  const segments: Array<string | number> = [];
  for (const part of source.split('.')) {
    const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part.trim());
    if (!match || !SEGMENT.test(match[1])) { throw new ExpressionError(`"${source}" is not a reference (use names, dots and [n]).`); }
    segments.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) { segments.push(Number(index[1])); }
  }
  return segments;
}

/** The root a reference reads from: `inputs`, `item`, `index`, or a node id. */
export function referenceRoot(text: string): string {
  return String(parsePath(text)[0]);
}

function lookup(scope: Scope, text: string): unknown {
  const [root, ...rest] = parsePath(text);
  let value: unknown;
  if (root === 'inputs') { value = scope.inputs; }
  else if (root === 'item') { value = scope.item; }
  else if (root === 'index') { value = scope.index; }
  else if (Object.prototype.hasOwnProperty.call(scope.nodes, root as string)) { value = scope.nodes[root as string]; }
  else { throw new ExpressionError(`"${text}" names "${root}", which has not run.`); }
  for (const segment of rest) {
    if (value === null || value === undefined) { return undefined; }
    if (typeof segment === 'number') { value = Array.isArray(value) ? value[segment] : undefined; continue; }
    // Only own data, and the length of a list or text: nothing from the prototype.
    if (segment === 'length' && (Array.isArray(value) || typeof value === 'string')) { value = value.length; continue; }
    value = typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, segment) ? (value as Record<string, unknown>)[segment] : undefined;
  }
  return value;
}

/** The references in a value (for validation), as written between `${` and `}`. */
export function referencesIn(value: unknown): string[] {
  if (typeof value === 'string') { return [...value.matchAll(PART)].map(match => match[1].trim()); }
  if (Array.isArray(value)) { return value.flatMap(referencesIn); }
  if (value && typeof value === 'object') { return Object.values(value).flatMap(referencesIn); }
  return [];
}

/**
 * A value with its references filled in. A string that is only `${x}` takes x's value as it is
 * (a list stays a list); a string with text around references becomes text.
 */
export function resolve(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value.trim());
    if (whole) { return lookup(scope, whole[1]); }
    return value.replace(PART, (_, reference: string) => {
      const found = lookup(scope, reference);
      return found === undefined || found === null ? '' : typeof found === 'object' ? JSON.stringify(found) : String(found);
    });
  }
  if (Array.isArray(value)) { return value.map(item => resolve(item, scope)); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, scope)]));
  }
  return value;
}

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<'] as const;
type Operator = typeof OPERATORS[number];

function operand(text: string, scope: Scope): unknown {
  const source = text.trim();
  const reference = WHOLE.exec(source);
  if (reference) { return lookup(scope, reference[1]); }
  if (/^-?\d+(\.\d+)?$/.test(source)) { return Number(source); }
  if (source === 'true' || source === 'false') { return source === 'true'; }
  if (source === 'null') { return null; }
  const quoted = /^'([^']*)'$|^"([^"]*)"$/.exec(source);
  if (quoted) { return quoted[1] ?? quoted[2]; }
  throw new ExpressionError(`"${source}" is not a value: use \${reference}, a number, true, false, null or 'text'.`);
}

/** Splits `left op right` at the operator outside `${…}` and quotes. */
function split(text: string): [string, Operator, string] | undefined {
  let depth = 0;
  let quote = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote) { if (char === quote) { quote = ''; } continue; }
    if (char === '\'' || char === '"') { quote = char; continue; }
    if (char === '{') { depth++; continue; }
    if (char === '}') { depth--; continue; }
    if (depth > 0) { continue; }
    const op = OPERATORS.find(candidate => text.startsWith(candidate, at));
    if (op) { return [text.slice(0, at), op, text.slice(at + op.length)]; }
  }
  return undefined;
}

const truthy = (value: unknown) => Array.isArray(value) ? value.length > 0 : Boolean(value);

/** An edge's condition: `${a} > 0`, `${a} == 'x'`, `${a}` (truthy; an empty list is false), `!${a}`. */
export function condition(text: string, scope: Scope): boolean {
  const source = text.trim();
  if (source.startsWith('!') && !source.startsWith('!=')) { return !condition(source.slice(1), scope); }
  const parts = split(source);
  if (!parts) { return truthy(operand(source, scope)); }
  const [leftText, op, rightText] = parts;
  const left = operand(leftText, scope);
  const right = operand(rightText, scope);
  switch (op) {
    case '==': return left === right;
    case '!=': return left !== right;
    default: {
      if (typeof left !== 'number' || typeof right !== 'number') { throw new ExpressionError(`"${source}" compares values that are not numbers.`); }
      return op === '>' ? left > right : op === '>=' ? left >= right : op === '<' ? left < right : left <= right;
    }
  }
}

/** Every reference a condition reads, for validation. */
export function conditionReferences(text: string): string[] {
  return referencesIn(text);
}
