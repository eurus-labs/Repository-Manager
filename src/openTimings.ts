/**
 * How long opening the dashboard takes, written to the "Repository Manager Timings" output channel
 * when repositoryManager.debug.timings is on (off by default; nothing is measured then).
 *
 * Each line is milliseconds since the panel was created: the steps of opening (page shown, history
 * asked and sent, repositories listed, history drawn in the page) and every Git process with its
 * duration and folder, for the first MAX_GIT_LOG_MS. On a slow machine this shows which step, and
 * which Git command, the time goes to.
 *
 * A branch switch writes its own block: a header, then the steps (click arrived, checkout done, result
 * posted, history drawn in the page, update ended with its outcome) and its Git processes, in
 * milliseconds since the click.
 */

import * as vscode from 'vscode';
import { GitCommandService, GitCommandTiming } from './services/gitCommandService';

const MAX_GIT_LOG_MS = 30000;
let channel: vscode.OutputChannel | undefined;

export class OpenTimings {
  private started = Date.now();
  private gitLogUntil = this.started + MAX_GIT_LOG_MS;
  private readonly seen = new Set<string>();

  /** A recorder when the setting is on; undefined (and no cost) when it is off. */
  static fromSettings(): OpenTimings | undefined {
    const enabled = vscode.workspace.getConfiguration('repositoryManager').get<boolean>('debug.timings', false);
    if (!enabled) { return undefined; }
    channel = channel || vscode.window.createOutputChannel('Repository Manager Timings');
    const output = channel;
    return new OpenTimings(line => output.appendLine(line));
  }

  constructor(private readonly write: (line: string) => void) {
    this.write(`--- Opening the dashboard (${new Date().toISOString()})`);
    GitCommandService.observer = timing => this.git(timing);
  }

  /** A branch click arrived: a new block, timed from now. */
  beginSwitch(branch: string): void {
    this.started = Date.now();
    this.gitLogUntil = this.started + MAX_GIT_LOG_MS;
    this.write(`--- Switching to ${branch} (${new Date().toISOString()})`);
    this.mark('click arrived');
  }

  /** A step, each time it happens. */
  mark(name: string): void {
    this.write(`${this.elapsed()} ${name}`);
  }

  /** A step, the first time only. */
  markOnce(name: string): void {
    if (this.seen.has(name)) { return; }
    this.seen.add(name);
    this.mark(name);
  }

  dispose(): void {
    if (GitCommandService.observer) { GitCommandService.observer = undefined; }
  }

  private git(timing: GitCommandTiming): void {
    if (Date.now() > this.gitLogUntil) { return; }
    const command = timing.args.filter(arg => !arg.startsWith('--format=')).join(' ');
    this.write(`${this.elapsed()}   git ${command.length > 120 ? `${command.slice(0, 120)}…` : command} ` +
      `(${timing.ms} ms${timing.ok ? '' : ', failed'}) in ${timing.cwd}`);
  }

  private elapsed(): string {
    return `+${String(Date.now() - this.started).padStart(6)} ms`;
  }
}
