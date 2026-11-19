/**
 * Running a skill's scripts for a Studio code step (docs/plans/plan-6-studio-skill-scripts.md). The
 * scripts are the files cached at the skill's pinned commit (src/studio/skills.ts). They run in a
 * container when Docker or Podman answers, else directly on the machine; the person approved
 * which of the two with the step. A call is refused before anything runs (unknown skill, a path
 * outside the skill's script list, an unsupported extension, no interpreter, no engine). No
 * `vscode` here.
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { CancelToken } from '../agent/lmRouter';

export type SkillScriptSetting = 'auto' | 'container' | 'direct' | 'off';
export type ContainerEngine = 'docker' | 'podman';
/** `container` without an `engine`: no engine answered, so every call fails saying so (never run directly instead). */
export type ScriptRunner = { mode: 'container'; engine?: ContainerEngine } | { mode: 'direct' } | { mode: 'off' };

export const MAX_ARGS = 64;
export const MAX_ARG_CHARS = 4000;
export const SCRIPT_TIMEOUT_MS = 5 * 60_000;
export const PULL_TIMEOUT_MS = 10 * 60_000;
export const OUTPUT_BYTES = 64 * 1024;
const ENGINE_PROBE_MS = 5000;

/** Official slim images, pinned by digest (Decision 4); no packages are installed in them. */
export const IMAGES = {
  python: 'python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df',
  node: 'node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee',
  shell: 'debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc'
} as const;

export interface Interpreter { image: string; command: string }

/** The interpreter a script's extension is run with, or undefined for an extension that is not run. */
export function interpreterFor(script: string): Interpreter | undefined {
  switch (path.posix.extname(script).toLowerCase()) {
    case '.py': return { image: IMAGES.python, command: 'python3' };
    case '.js': case '.mjs': case '.cjs': return { image: IMAGES.node, command: 'node' };
    case '.sh': return { image: IMAGES.shell, command: 'bash' };
    default: return undefined;
  }
}

/** An image as people read it: without its digest. */
export const imageName = (image: string): string => image.split('@')[0];

/** Only a script's extensions the tool runs: what the preview lists as runnable. */
export const runnable = (script: string): boolean => interpreterFor(script) !== undefined;

export function parseSetting(value: unknown): SkillScriptSetting {
  return value === 'container' || value === 'direct' || value === 'off' ? value : 'auto';
}

/** Which engine answers `version` within the probe time: Docker first, then Podman. */
export async function detectEngine(timeoutMs = ENGINE_PROBE_MS): Promise<ContainerEngine | undefined> {
  for (const engine of ['docker', 'podman'] as const) {
    if (await answers(engine, timeoutMs)) { return engine; }
  }
  return undefined;
}

function answers(engine: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (value: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    let child: ChildProcess;
    try { child = spawn(engine, ['version'], { stdio: 'ignore' }); } catch { resolve(false); return; }
    const timer = setTimeout(() => { child.kill(); finish(false); }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', code => finish(code === 0));
  });
}

/** The runner a setting gives now (Decision 5). `detect` is the engine probe, given by tests. */
export async function chooseRunner(setting: SkillScriptSetting, detect: () => Promise<ContainerEngine | undefined> = detectEngine): Promise<ScriptRunner> {
  switch (setting) {
    case 'off': return { mode: 'off' };
    case 'direct': return { mode: 'direct' };
    case 'container': { const engine = await detect(); return engine ? { mode: 'container', engine } : { mode: 'container' }; }
    default: { const engine = await detect(); return engine ? { mode: 'container', engine } : { mode: 'direct' }; }
  }
}

/** The runner as the preview and the log say it. */
export function describeRunner(runner: ScriptRunner): string {
  if (runner.mode === 'off') { return 'turned off'; }
  if (runner.mode === 'direct') { return 'directly on this machine, not isolated: as you, with your files and network'; }
  return runner.engine
    ? `in a container (${runner.engine}): the repository is writable at /work, the skill is read-only, no network, no other files of yours`
    : 'in a container, but no container engine (Docker or Podman) answers: every script call will fail';
}

/** What is known of a skill's script files: `none` (SKILL.md mentions scripts, the folder has none) or why they are `unavailable`. */
export interface SkillScriptFiles { none?: boolean; unavailable?: string }

/**
 * What a skill chip and the skill picker say about a skill that uses scripts, by the step it is on and
 * the runner the setting gives now (`unknown` while the engine is being looked for).
 */
export function scriptsNote(stepType: string, mode: 'container' | 'direct' | 'off' | 'unknown', files?: SkillScriptFiles): string {
  if (mode === 'off') { return 'Uses scripts: turned off in settings'; }
  if (stepType !== 'code') { return 'Uses scripts: this step type has no tools, so they are not run here; use a code step'; }
  if (files?.unavailable) { return `Uses scripts: none could be loaded: ${files.unavailable}`; }
  if (files?.none) { return 'Mentions scripts but has none in its folder, so none are run'; }
  const where = mode === 'container' ? 'in a container' : mode === 'direct' ? 'directly on this machine' : 'in a container when Docker or Podman is available, else directly on this machine';
  return `Uses scripts: run in this step after your approval (${where})`;
}

export interface ScriptSkill {
  /** As the skill's prompt names it (`### Skill: <name>`). */
  name: string;
  ref: string;
  /** The skill's cache folder: the scripts are in its `scripts/`. */
  dir: string;
  /** Paths relative to `dir`, as SKILL.md writes them. */
  scripts: string[];
}

export class ScriptRefusal extends Error {}

export interface ScriptCall { skill: string; script: string; args: string[] }

/** The model's tool input as a call, or the reason it is refused. */
export function parseCall(input: Record<string, unknown>): ScriptCall {
  if (typeof input.skill !== 'string' || !input.skill.trim()) { throw new ScriptRefusal('skill is required: the name of a skill with scripts.'); }
  if (typeof input.script !== 'string' || !input.script.trim()) { throw new ScriptRefusal('script is required: a path in the skill\'s folder, such as scripts/pipeline.py.'); }
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) { throw new ScriptRefusal('args must be a list of text arguments.'); }
  if (args.length > MAX_ARGS) { throw new ScriptRefusal(`At most ${MAX_ARGS} arguments (got ${args.length}).`); }
  if (args.some(arg => (arg as string).length > MAX_ARG_CHARS || (arg as string).includes('\0'))) { throw new ScriptRefusal(`Each argument is at most ${MAX_ARG_CHARS} characters, without NUL characters.`); }
  return { skill: input.skill.trim(), script: input.script.trim(), args: args as string[] };
}

export interface PlannedCall { skill: ScriptSkill; script: string; interpreter: Interpreter; args: string[] }

/** Checks a call against the skills offered; throws the reason when it must not run. Nothing runs here. */
export function planCall(skills: ScriptSkill[], call: ScriptCall): PlannedCall {
  const named = skills.filter(skill => skill.name === call.skill);
  if (!named.length) { throw new ScriptRefusal(`No skill named "${call.skill}" with scripts in this step (skills with scripts: ${skills.map(skill => skill.name).join(', ') || 'none'}).`); }
  if (named.length > 1) { throw new ScriptRefusal(`More than one skill of this step is named "${call.skill}"; it cannot be told which to use.`); }
  const skill = named[0];
  let script = call.script.replace(/\\/g, '/');
  while (script.startsWith('./')) { script = script.slice(2); }
  if (path.isAbsolute(script) || path.posix.isAbsolute(script) || /^[a-zA-Z]:/.test(script)) { throw new ScriptRefusal(`Use a path relative to the skill's folder, as its SKILL.md writes it (such as scripts/pipeline.py): ${call.script}`); }
  if (script.split('/').includes('..') || script.includes('\0')) { throw new ScriptRefusal(`Paths may not leave the skill's folder: ${call.script}`); }
  if (!skill.scripts.includes(script)) {
    throw new ScriptRefusal(`${call.script} is not one of the scripts of ${skill.name} (${skill.scripts.filter(runnable).join(', ') || 'none that can run'}).`);
  }
  const interpreter = interpreterFor(script);
  if (!interpreter) { throw new ScriptRefusal(`${script}: files with the extension "${path.posix.extname(script) || 'none'}" are not run (only .py, .js, .mjs, .cjs and .sh).`); }
  return { skill, script, interpreter, args: call.args };
}

export interface ScriptOutcome {
  runner: 'container' | 'direct';
  engine?: ContainerEngine;
  /** What ran, inside the skill: interpreter, script path and arguments. */
  command: string;
  exitCode: number | null;
  /** The end of the combined output (at most OUTPUT_BYTES). */
  output: string;
  /** Earlier output was dropped. */
  cut: boolean;
  durationMs: number;
  stopped?: 'timeout' | 'cancelled';
}

export interface RunOptions {
  /** The repository root (a real path): the working directory. */
  root: string;
  runner: ScriptRunner;
  /** Names the container: repository-manager-<run>-<n>. */
  containerName: string;
  token?: CancelToken;
  /** Limits; shortened by tests. */
  timeoutMs?: number;
  pullTimeoutMs?: number;
  /** Told before an image is pulled, so Activity can say so. */
  onPull?(image: string): void;
}

const quote = (value: string): string => /^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);

/** The container's name for the n-th call of a run. */
export const containerNameFor = (runId: string, n: number): string => `repository-manager-${runId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40)}-${n}`;

interface Captured { code: number | null; output: string; cut: boolean; stopped?: 'timeout' | 'cancelled'; error?: NodeJS.ErrnoException }

/**
 * Runs one process without a shell, keeping the end of its combined output, and stops it at the
 * time limit or when the token is cancelled (`stop` kills what the process started: a container).
 */
function capture(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; token?: CancelToken; stop?(): Promise<void> }): Promise<Captured> {
  return new Promise(resolve => {
    let buffer = Buffer.alloc(0);
    let cut = false;
    let stopped: 'timeout' | 'cancelled' | undefined;
    let error: NodeJS.ErrnoException | undefined;
    const posix = process.platform !== 'win32';
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: posix });
    } catch (thrown) { resolve({ code: null, output: '', cut: false, error: thrown as NodeJS.ErrnoException }); return; }
    const add = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > OUTPUT_BYTES) { cut = true; buffer = buffer.subarray(buffer.length - OUTPUT_BYTES); }
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const kill = (why: 'timeout' | 'cancelled') => {
      if (stopped) { return; }
      stopped = why;
      void (async () => {
        // A container is removed by name: killing the CLI would leave it running.
        try { await options.stop?.(); } catch { /* removed or never started */ }
        try { if (posix && child.pid) { process.kill(-child.pid, 'SIGKILL'); } else { child.kill('SIGKILL'); } } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      })();
    };
    const timer = setTimeout(() => kill('timeout'), options.timeoutMs);
    if (options.token?.isCancellationRequested) { kill('cancelled'); }
    const listener = options.token?.onCancellationRequested?.(() => kill('cancelled'));
    child.on('error', thrown => { error = thrown as NodeJS.ErrnoException; });
    child.on('close', code => {
      clearTimeout(timer);
      listener?.dispose();
      resolve({ code, output: buffer.toString('utf8'), cut, stopped, error });
    });
  });
}

/** The environment of a direct run: nothing but what a script needs to start (Decision 6). */
function directEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'SystemRoot', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) { env[name] = process.env[name]; }
  }
  return env;
}

async function runDirect(plan: PlannedCall, options: RunOptions, command: string, timeoutMs: number): Promise<ScriptOutcome> {
  const started = Date.now();
  const script = path.join(plan.skill.dir, ...plan.script.split('/'));
  const candidates = process.platform === 'win32' && plan.interpreter.command === 'python3' ? ['python3', 'python'] : [plan.interpreter.command];
  for (const [index, interpreter] of candidates.entries()) {
    const result = await capture(interpreter, [script, ...plan.args], { cwd: options.root, env: directEnv(), timeoutMs, token: options.token });
    if (result.error?.code === 'ENOENT') {
      if (index < candidates.length - 1) { continue; }
      throw new ScriptRefusal(`${plan.interpreter.command} is not installed or not on PATH.`);
    }
    if (result.error && result.code === null && !result.stopped) { throw new ScriptRefusal(`${plan.interpreter.command} could not start: ${result.error.message}`); }
    return { runner: 'direct', command, exitCode: result.code, output: result.output, cut: result.cut, durationMs: Date.now() - started, stopped: result.stopped };
  }
  throw new ScriptRefusal(`${plan.interpreter.command} is not installed or not on PATH.`);
}

/** Runs a planned call. Refusals were made by `planCall`; what fails here (no engine, no interpreter, a failed pull) throws a ScriptRefusal. */
export async function runSkillScript(plan: PlannedCall, options: RunOptions): Promise<ScriptOutcome> {
  const { runner } = options;
  if (runner.mode === 'off') { throw new ScriptRefusal('Skill scripts are turned off in the settings (repositoryManager.studio.skillScripts).'); }
  const command = [plan.interpreter.command, plan.script, ...plan.args].map(quote).join(' ');
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  if (runner.mode === 'direct') { return runDirect(plan, options, command, timeoutMs); }
  if (!runner.engine) { throw new ScriptRefusal('No container engine (Docker or Podman) answers, and the setting is "container", so the script is not run. Start the engine, or set repositoryManager.studio.skillScripts to "auto" or "direct".'); }
  const engine = runner.engine;
  if (process.platform !== 'win32' && [options.root, plan.skill.dir].some(folder => folder.includes(':'))) {
    throw new ScriptRefusal('A folder name with ":" cannot be mounted into a container.');
  }
  await ensureImage(engine, plan.interpreter.image, options);
  const name = options.containerName;
  const user = typeof process.getuid === 'function' && typeof process.getgid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
  const args = ['run', '--rm', '--name', name, '--network', 'none', ...user, '--pids-limit', '256', '--memory', '1g', '--read-only', '--tmpfs', '/tmp', '-e', 'HOME=/tmp',
    '-v', `${options.root}:/work`, '-v', `${plan.skill.dir}:/skill:ro`, '-w', '/work', plan.interpreter.image, plan.interpreter.command, `/skill/${plan.script}`, ...plan.args];
  const remove = () => capture(engine, ['rm', '-f', name], { timeoutMs: 60_000 }).then(() => undefined);
  const runStarted = Date.now();
  let result: Captured;
  try {
    result = await capture(engine, args, { env: process.env, timeoutMs, token: options.token, stop: remove });
  } finally {
    // The container is gone before the call returns, so the diff, a revert and `ps` see the end state.
    await remove();
  }
  if (result.error?.code === 'ENOENT') { throw new ScriptRefusal(`${engine} is not installed or not on PATH.`); }
  return { runner: 'container', engine, command, exitCode: result.code, output: result.output, cut: result.cut, durationMs: Date.now() - runStarted, stopped: result.stopped };
}

/** Pulls the image when the engine does not have it, with its own limit; a failure ends the call with the engine's message. */
async function ensureImage(engine: ContainerEngine, image: string, options: RunOptions): Promise<void> {
  const have = await capture(engine, ['image', 'inspect', image], { timeoutMs: 60_000, token: options.token });
  if (have.error?.code === 'ENOENT') { throw new ScriptRefusal(`${engine} is not installed or not on PATH.`); }
  if (have.code === 0) { return; }
  options.onPull?.(image);
  const pulled = await capture(engine, ['pull', image], { timeoutMs: options.pullTimeoutMs ?? PULL_TIMEOUT_MS, token: options.token });
  if (pulled.stopped === 'cancelled') { throw new ScriptRefusal('Cancelled'); }
  if (pulled.code !== 0) {
    const reason = pulled.stopped === 'timeout' ? 'it took more than 10 minutes' : pulled.output.trim().split('\n').slice(-3).join(' ');
    throw new ScriptRefusal(`Could not pull ${imageName(image)}: ${reason || `${engine} exited with ${pulled.code}`}`);
  }
}

/** The files and sizes the tool result shows: what the model is told after a call. */
export function describeOutcome(outcome: ScriptOutcome, changed: string[]): string {
  const how = outcome.runner === 'container' ? `container, ${outcome.engine}` : 'directly on this machine';
  const status = outcome.stopped === 'timeout' ? 'stopped: it ran past its time limit' : outcome.stopped === 'cancelled' ? 'stopped: cancelled' : `exit code ${outcome.exitCode}`;
  return [
    `${status} (${(outcome.durationMs / 1000).toFixed(1)} s, ${how})`,
    outcome.cut ? `Output (only the last ${OUTPUT_BYTES / 1024} KB; earlier output was cut):` : 'Output:',
    outcome.output.trim() ? outcome.output : '(none)',
    changed.length ? `Files changed in the repository: ${changed.join(', ')}` : 'No file of the repository changed.'
  ].join('\n');
}
