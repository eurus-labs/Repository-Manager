/**
 * Sharing one workflow as a file (docs/agent-studio.md, phase 3). Export writes the workflow with a
 * `requires` block computed from it; Import checks the file, computes `requires` again, warns when
 * the file's block says something else and keeps the computed one, and lists what this machine and
 * the open repository still lack. No `vscode` here.
 */
import { workflowModels, workflowSkills } from './engine';
import { parseWorkflow, Problem, StepShape, Workflow, WorkflowRequirements } from './workflow';

/** A shared file larger than this is refused before it is parsed. */
export const MAX_SHARED_BYTES = 1024 * 1024;
const LISTS = ['steps', 'models', 'skills', 'scripts'] as const;

/** What the workflow needs, read from the workflow itself. */
export function computeRequirements(workflow: Workflow, extensionVersion: string): WorkflowRequirements {
  const sorted = (values: string[]) => [...new Set(values)].sort();
  // Only checks written as names: a `${…}` reference is resolved at run time and cannot be listed.
  const scripts = workflow.nodes.filter(node => node.type === 'code').flatMap(node => {
    const checks = node.with?.checks;
    return Array.isArray(checks) ? checks.filter((check): check is string => typeof check === 'string' && !check.includes('${')) : [];
  });
  return {
    extension: `>=${extensionVersion}`,
    steps: sorted(workflow.nodes.map(node => node.type)),
    models: sorted(workflowModels(workflow)),
    skills: sorted(workflowSkills(workflow)),
    scripts: sorted(scripts)
  };
}

/**
 * Where the file's lists in `requires` say something other than the workflow: one line each. The
 * extension version is not compared here: the workflow cannot tell it (see checkImport).
 */
export function requirementDifferences(declared: unknown, computed: WorkflowRequirements): string[] {
  if (declared === undefined) { return ['The file lists no requirements; they were read from the workflow.']; }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) { return ['"requires" is not an object; the requirements were read from the workflow.']; }
  const given = declared as Record<string, unknown>;
  const differences: string[] = [];
  for (const key of LISTS) {
    const list = Array.isArray(given[key]) ? [...new Set((given[key] as unknown[]).map(String))].sort() : undefined;
    if (!list || list.join('\n') !== computed[key].join('\n')) {
      const missing = computed[key].filter(item => !list?.includes(item));
      const extra = (list ?? []).filter(item => !computed[key].includes(item));
      differences.push(`"requires.${key}" does not match the workflow${missing.length ? `; it uses ${missing.join(', ')}` : ''}${extra.length ? `; it does not use ${extra.join(', ')}` : ''}.`);
    }
  }
  return differences;
}

/** `a` compared with `b`, both "X.Y.Z": negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split('.').map(part => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) {
    if ((x[index] ?? 0) !== (y[index] ?? 0)) { return (x[index] ?? 0) - (y[index] ?? 0); }
  }
  return 0;
}

/** The workflow as a file to share: its text with `requires` written from the workflow. */
export function exportWorkflow(text: string, steps: Map<string, StepShape>, extensionVersion: string): { text?: string; problems: Problem[] } {
  const { workflow, problems } = parseWorkflow(text, steps);
  if (!workflow) { return { problems }; }
  const value = JSON.parse(text) as Record<string, unknown>;
  value.requires = computeRequirements(workflow, extensionVersion);
  return { text: `${JSON.stringify(value, null, 2)}\n`, problems: [] };
}

/** What this machine and the open repository have, to tell the person what is missing. */
export interface ImportEnvironment {
  extensionVersion: string;
  /** Scripts of the open repository (empty without one). */
  scripts: string[];
}

export interface ImportCheck {
  workflow?: Workflow;
  /** The text to keep: the file with `requires` computed again. */
  text?: string;
  /** Why the file cannot be imported. */
  problems: Problem[];
  /** Where the file's `requires` was wrong (replaced by the computed one). */
  warnings: string[];
  /** What this machine or repository lacks to run it. */
  missing: string[];
}

export function checkImport(text: string, steps: Map<string, StepShape>, environment: ImportEnvironment): ImportCheck {
  if (Buffer.byteLength(text, 'utf8') > MAX_SHARED_BYTES) {
    return { problems: [{ where: 'file', message: `The file is larger than ${MAX_SHARED_BYTES / 1024} KB.` }], warnings: [], missing: [] };
  }
  const { workflow, problems } = parseWorkflow(text, steps);
  if (!workflow) { return { problems, warnings: [], missing: [] }; }
  const value = JSON.parse(text) as Record<string, unknown>;
  const declared = value.requires;
  const computed = computeRequirements(workflow, environment.extensionVersion);
  // The version the author's extension needed is the one fact the workflow cannot tell; it is kept when it reads as one.
  const declaredVersion = declared && typeof declared === 'object' && typeof (declared as Record<string, unknown>).extension === 'string'
    ? /^>=(\d+\.\d+\.\d+)$/.exec((declared as Record<string, string>).extension)?.[1] : undefined;
  const warnings = requirementDifferences(declared, computed);
  if (declaredVersion) { computed.extension = `>=${declaredVersion}`; }
  else if (declared !== undefined) { warnings.push(`"requires.extension" is not ">=X.Y.Z"; this version (${environment.extensionVersion}) was written instead.`); }
  const missing: string[] = [];
  if (declaredVersion && compareVersions(environment.extensionVersion, declaredVersion) < 0) {
    missing.push(`Repository Manager ${declaredVersion} or later (this is ${environment.extensionVersion}).`);
  }
  const absentScripts = computed.scripts.filter(script => !environment.scripts.includes(script));
  if (absentScripts.length) { missing.push(`Scripts the open repository does not have: ${absentScripts.join(', ')}.`); }
  value.requires = computed;
  return { workflow: { ...workflow, requires: computed }, text: `${JSON.stringify(value, null, 2)}\n`, problems: [], warnings, missing };
}

/** An id not in `taken`: the same one, else `<id>-2`, `<id>-3`, … */
export function freeId(id: string, taken: Set<string>): string {
  if (!taken.has(id)) { return id; }
  for (let count = 2; ; count++) { if (!taken.has(`${id}-${count}`)) { return `${id}-${count}`; } }
}

/** The file's text with another id (Keep both). */
export function withId(text: string, id: string): string {
  const value = JSON.parse(text) as Record<string, unknown>;
  value.id = id;
  return `${JSON.stringify(value, null, 2)}\n`;
}
