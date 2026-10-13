/**
 * Apply, Pop and Drop for a stash the dashboard shows.
 *
 * The webview names a stash by its commit hash, which never changes; its stash@{n} moves each time
 * another stash is pushed or dropped. The hash is looked up in the stash reflog right before Git
 * runs, so the command always acts on the stash that was selected, or not at all.
 *
 * Apply and Pop merge the stash into the working tree as Git does: they work on a dirty tree, and Git
 * refuses (changing nothing) when a file they touch has local edits or an untracked file is in the
 * way. A merge that conflicts leaves the conflicts to resolve in Source Control; Pop then keeps the
 * stash, as `git stash pop` does.
 */

import { CommandResult } from '../types';
import { GitCommandService } from './gitCommandService';
import { findStash, StashEntry } from './stashTarget';

export type StashOperation = 'apply' | 'pop' | 'drop';
export const STASH_OPERATIONS: readonly StashOperation[] = ['apply', 'pop', 'drop'];

export interface StashActionData {
  /** Whether the stash's changes reached the working tree (Apply and Pop, conflicts included). */
  changedWorkingTree: boolean;
  /** Paths left in conflict, when the merge did not apply cleanly. */
  conflicts?: string[];
}

export class StashActionService {
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
    let stash: StashEntry;
    try {
      stash = await this.describe(repositoryPath, hash);
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
    const name = `${stash.ref}${stash.message ? ` (${stash.message})` : ''}`;
    // Conflicts found after a failed Apply are the stash's own only if there were none before.
    if (operation !== 'drop' && (await this.unmergedPaths(cwd)).length) {
      return { success: false, data: { changedWorkingTree: false },
        message: `Resolve the conflicts in Source Control before applying ${name}.` };
    }
    try {
      await this.git.execGit(['stash', operation, stash.ref], cwd, 120000);
      const data: StashActionData = { changedWorkingTree: operation !== 'drop' };
      const done = operation === 'apply' ? `Applied ${name}.`
        : operation === 'pop' ? `Popped ${name}: its changes are in the working tree and the stash is removed.`
          : `Dropped ${name}. Until Git cleans up, git stash store ${stash.hash} brings it back.`;
      return { success: true, data, message: done };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const conflicts = operation === 'drop' ? [] : await this.unmergedPaths(cwd);
      if (conflicts.length) {
        const data: StashActionData = { changedWorkingTree: true, conflicts };
        const kept = operation === 'pop' ? ' The stash is kept; drop it once the conflicts are resolved.' : '';
        return { success: false, data, message: `${name} applied with conflicts in ${conflicts.length} file${conflicts.length > 1 ? 's' : ''}: resolve them in Source Control.${kept}` };
      }
      const verb = operation === 'apply' ? 'Apply' : operation === 'pop' ? 'Pop' : 'Drop';
      return { success: false, data: { changedWorkingTree: false }, message: `${verb} ${name} failed: ${detail}` };
    }
  }

  private async unmergedPaths(cwd: string): Promise<string[]> {
    const output = await this.git.execGit(['diff', '--name-only', '--diff-filter=U'], cwd, 10000).catch(() => '');
    return output.split('\n').filter(Boolean);
  }
}
