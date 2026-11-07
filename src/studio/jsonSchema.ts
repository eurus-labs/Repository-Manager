/**
 * The part of JSON Schema a workflow's types use: type, properties, required, items, enum,
 * description. Enough to check a model's output and to tell a person what is wrong, without a
 * dependency. No `vscode` here.
 */

export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
};

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Problems in a schema itself, at `where`. */
export function schemaProblems(schema: unknown, where: string): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { return [`${where} is not a schema object.`]; }
  const value = schema as Record<string, unknown>;
  const problems: string[] = [];
  if (value.type !== undefined && !TYPES.has(value.type as string)) { problems.push(`${where}.type "${String(value.type)}" is not a JSON type.`); }
  if (value.properties !== undefined) {
    if (!value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties)) { problems.push(`${where}.properties is not an object.`); }
    else { for (const [name, child] of Object.entries(value.properties)) { problems.push(...schemaProblems(child, `${where}.properties.${name}`)); } }
  }
  if (value.required !== undefined && !(Array.isArray(value.required) && value.required.every(item => typeof item === 'string'))) {
    problems.push(`${where}.required is not a list of names.`);
  }
  if (value.items !== undefined) { problems.push(...schemaProblems(value.items, `${where}.items`)); }
  if (value.enum !== undefined && !Array.isArray(value.enum)) { problems.push(`${where}.enum is not a list.`); }
  return problems;
}

function typeOf(value: unknown): string {
  if (value === null) { return 'null'; }
  if (Array.isArray(value)) { return 'array'; }
  return typeof value;
}

/** Equal as JSON values: lists in order, objects whatever the order of their keys. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (typeOf(a) !== typeOf(b) || typeof a !== 'object' || a === null) { return false; }
  if (Array.isArray(a)) { return a.length === (b as unknown[]).length && a.every((item, index) => sameJson(item, (b as unknown[])[index])); }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]));
}

/** Where `value` does not fit `schema`, at most `limit` problems, each with its path. */
export function checkValue(value: unknown, schema: JsonSchema, where = 'output', limit = 20): string[] {
  const problems: string[] = [];
  const visit = (current: unknown, rule: JsonSchema, at: string) => {
    if (problems.length >= limit) { return; }
    if (rule.enum && !rule.enum.some(option => sameJson(option, current))) {
      problems.push(`${at} must be one of ${rule.enum.map(option => JSON.stringify(option)).join(', ')}.`);
      return;
    }
    if (rule.type) {
      const actual = typeOf(current);
      const fits = rule.type === actual || (rule.type === 'integer' && Number.isInteger(current)) || (rule.type === 'number' && actual === 'number');
      if (!fits) { problems.push(`${at} must be ${rule.type === 'array' || rule.type === 'object' ? 'an' : 'a'} ${rule.type}, not ${actual}.`); return; }
    }
    if (rule.properties || rule.required) {
      if (typeOf(current) !== 'object') { return; }
      const object = current as Record<string, unknown>;
      for (const name of rule.required ?? []) { if (!(name in object)) { problems.push(`${at}.${name} is missing.`); } }
      for (const [name, child] of Object.entries(rule.properties ?? {})) {
        if (name in object) { visit(object[name], child, `${at}.${name}`); }
      }
    }
    if (rule.items && Array.isArray(current)) { current.forEach((item, index) => visit(item, rule.items!, `${at}[${index}]`)); }
  };
  visit(value, schema, where);
  return problems;
}
