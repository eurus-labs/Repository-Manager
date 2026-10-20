/**
 * Stash the uncommitted changes (Push), and Apply, Pop and Drop for a stash the dashboard shows.
 *
 * The webview names a stash by its commit hash, which never changes; its stash@{n} moves each time
 * another stash is pushed or dropped. Apply takes the hash itself. Pop and Drop only take a stash@{n},
 * so the hash is looked up in the stash reflog right before Git runs, and the actions in a repository
 * run one at a time: a second click cannot look up a position the first is about to change.
 *
 * Apply and Pop merge the stash into the working tree as Git does: they work on a dirty tree, and Git
 * refuses (changing nothing) when a file they touch has local edits or an untracked file is in the
 * way. A merge that conflicts leaves the conflicts to resolve in Source Control; Pop then keeps the
 * stash, as `git stash pop` does.
 */

import { CommandResult } from '../types';
import { GitCommandService } from './gitCommandService';
import { findStash, StashEntry } from './stashTarget';
import { HistoryActionService } from './historyActionService';

export interface StashPushOptions {
  /** Shown in the Stashes list; Git writes "WIP on <branch>" without one. */
  message?: string;
  /** Also stash new files (`--include-untracked`); ignored files are never stashed. */
  includeUntracked?: boolean;
}

export type StashOperation = 'apply' | 'pop' | 'drop';
export const STASH_OPERATIONS: readonly StashOperation[] = ['apply', 'pop', 'drop'];

export interface StashActionData {
  /** Whether the stash's changes reached the working tree (Apply and Pop, conflicts included). */
  changedWorkingTree: boolean;
  /** Paths left in conflict, when the merge did not apply cleanly. */
  conflicts?: string[];
  /** Whether the stash is gone (a Pop or Drop that succeeded), so a filter naming its stash@{n} is stale. */
  removedStash: boolean;
}

export class StashActionService {
  /** The last action queued in each repository; the next one starts when it ends. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(private git: GitCommandService) {}

  /** The stash `hash` names, or an error saying it is gone. */
  async describe(repositoryPath: string, hash: string): Promise<StashEntry> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const stash = await findStash(this.git, cwd, hash);
    if (!stash) {
      throw new Error('This stash no longer exists. It may have been popped or dropped elsewhere.');
    }
    return stash;
  }

  async run(repositoryPath: string, hash: string, operation: StashOperation): Promise<CommandResult> {
    if (!STASH_OPERATIONS.includes(operation)) {
      return { success: false, message: 'Unsupported stash action' };
    }
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const previous = this.queues.get(cwd) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.runNow(cwd, repositoryPath, hash, operation));
    this.queues.set(cwd, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(cwd) === next) { this.queues.delete(cwd); }
    }
  }

  /**
   * Stashes the uncommitted changes, staged and unstaged, and new files when asked: the working tree
   * then matches HEAD. Queued with the other stash actions of the repository.
   */
  async push(repositoryPath: string, options: StashPushOptions = {}): Promise<CommandResult> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const previous = this.queues.get(cwd) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.pushNow(cwd, repositoryPath, options));
    this.queues.set(cwd, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(cwd) === next) { this.queues.delete(cwd); }
    }
  }

  private async pushNow(cwd: string, repositoryPath: string, options: StashPushOptions): Promise<CommandResult> {
    const unchanged: StashActionData = { changedWorkingTree: false, removedStash: false };
    const message = (options.message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    try {
      // A paused merge, rebase, pick or revert keeps state Git would mix up with the stash.
      const pending = await new HistoryActionService(this.git).pendingOperation(repositoryPath);
      if (pending) { throw new Error(`A ${pending} is in progress. Finish or abort it before stashing.`); }
      if ((await this.unmergedPaths(cwd)).length) { throw new Error('Resolve the conflicted files in Source Control before stashing.'); }
      const status = await this.git.execGitRaw(['status', '--porcelain=v1', '-z', options.includeUntracked ? '--untracked-files=all' : '--untracked-files=no'], cwd, 30000);
      if (!status) {
        throw new Error(options.includeUntracked ? 'Nothing to stash: there are no changes.' : 'Nothing to stash: there are no changes to tracked files (new files were not included).');
      }
      const before = await this.git.execGit(['rev-parse', '-q', '--verify', 'refs/stash'], cwd, 5000).catch(() => '');
      await this.git.execGit(['stash', 'push', ...(options.includeUntracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])], cwd, 120000);
      const after = await this.git.execGit(['rev-parse', '-q', '--verify', 'refs/stash'], cwd, 5000).catch(() => '');
      if (!after || after === before) { throw new Error('Git made no stash.'); }
      const name = message ? `stash@{0} (${message})` : 'stash@{0}';
      return { success: true, data: { changedWorkingTree: true, removedStash: false } as StashActionData,
        message: `Stashed the changes${options.includeUntracked ? ', new files included,' : ''} as ${name}. Apply or Pop it from the Stashes list.` };
    } catch (error) {
      return { success: false, data: unchanged, message: `Stash failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async runNow(cwd: string, repositoryPath: string, hash: string, operation: StashOperation): Promise<CommandResult> {
    const unchanged: StashActionData = { changedWorkingTree: false, removedStash: false };
    // Conflicts found after a failed Apply are the stash's own only if there were none before.
    const conflictedBefore = operation !== 'drop' && (await this.unmergedPaths(cwd)).length > 0;
    // What a failed Apply or Pop is compared with, to tell a partial apply from a refusal.
    const statusBefore = operation === 'drop' ? '' : await this.status(cwd);
    // Looked up last, so the stash@{n} is as fresh as it can be when Git runs.
    let stash: StashEntry;
    try {
      stash = await this.describe(repositoryPath, hash);
    } catch (error) {
      return { success: false, data: unchanged, message: error instanceof Error ? error.message : String(error) };
    }
    const name = `${stash.ref}${stash.message ? ` (${stash.message})` : ''}`;
    if (conflictedBefore) {
      return { success: false, data: unchanged, message: `Resolve the conflicts in Source Control before applying ${name}.` };
    }
    try {
      await this.git.execGit(['stash', operation, operation === 'apply' ? stash.hash : stash.ref], cwd, 120000);
      const data: StashActionData = { changedWorkingTree: operation !== 'drop', removedStash: operation !== 'apply' };
      const done = operation === 'apply' ? `Applied ${name}.`
        : operation === 'pop' ? `Popped ${name}: its changes are in the working tree and the stash is removed.`
          : `Dropped ${name}. Until Git cleans up, git stash store ${stash.hash} brings it back.`;
      return { success: true, data, message: done };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const conflicts = operation === 'drop' ? [] : await this.unmergedPaths(cwd);
      if (conflicts.length) {
        const data: StashActionData = { changedWorkingTree: true, conflicts, removedStash: false };
        const kept = operation === 'pop' ? ' The stash is kept; drop it once the conflicts are resolved.' : '';
        return { success: false, data, message: `${name} applied with conflicts in ${conflicts.length} file${conflicts.length > 1 ? 's' : ''}: resolve them in Source Control.${kept}` };
      }
      const verb = operation === 'apply' ? 'Apply' : operation === 'pop' ? 'Pop' : 'Drop';
      // Git can stop partway without a conflict: a -u stash restores its tracked changes before
      // finding an untracked file already in the way. The stash is kept either way.
      if (operation !== 'drop' && await this.status(cwd) !== statusBefore) {
        return { success: false, data: { changedWorkingTree: true, removedStash: false },
          message: `${verb} ${name} stopped partway: ${detail} Some of its changes are in the working tree; the stash is kept.` };
      }
      return { success: false, data: unchanged, message: `${verb} ${name} failed: ${detail}` };
    }
  }

  private async status(cwd: string): Promise<string> {
    return this.git.execGitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, 30000).catch(() => '');
  }

  private async unmergedPaths(cwd: string): Promise<string[]> {
    const output = await this.git.execGit(['diff', '--name-only', '--diff-filter=U'], cwd, 10000).catch(() => '');
    return output.split('\n').filter(Boolean);
  }
}
