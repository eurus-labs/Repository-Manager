/**
 * The repository's own scripts and Git, for the Studio's code steps (and, before 2.20.0, the agent's
 * tasks): reading package.json scripts, running one with npm, and the per-repository approval of
 * the scripts a step may run as checks (a changed command, or its pre/post hooks, asks again).
 */

import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { CancelToken } from './lmRouter';
import { CheckResult } from './types';

const APPROVED_SCRIPTS_KEY = 'repositoryManager.agent.approvedScripts';
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 8000;

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

/**
 * Asks once (through `ask`) for the scripts among `names` not approved yet, or whose command
 * changed since; true when every one is approved. A name that is not a script is left to the
 * caller (it cannot run).
 */
export async function approveScripts(approvals: ScriptApprovals, root: string, names: string[],
  ask: (question: string, detail: string) => Thenable<boolean> | Promise<boolean>): Promise<boolean> {
  const scripts = readScripts(root);
  const allowed = approvals.allowed(root, scripts);
  const needed = [...new Set(names)].filter(name => !allowed.includes(name) && scripts[name] !== undefined);
  if (!needed.length) { return true; }
  const detail = needed.map(name => describeScript(scripts, name)).join('\n');
  if (!await ask(`Allow these scripts of ${path.basename(root)} to run as checks? You are asked again only if a script's command changes.`, detail)) { return false; }
  await approvals.approve(root, scripts, needed);
  return true;
}
