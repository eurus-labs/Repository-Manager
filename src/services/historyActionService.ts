import { CommandResult } from '../types';
import { existsSync } from 'fs';
import * as path from 'path';
import { GitCommandService } from './gitCommandService';

export type HistoryAction = 'cherry-pick' | 'revert' | 'merge';
type PendingOperation = HistoryAction | 'am' | 'rebase';

export class HistoryActionService {
  constructor(private git: GitCommandService) {}

  async describe(repositoryPath: string, commit: string): Promise<{ sha: string; branch: string; parents: string[] }> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const sha = await this.git.resolveRevision(repositoryPath, commit);
    const branch = await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000)
      .catch(() => { throw new Error('Checkout a local branch before applying a commit.'); });
    const ancestry = await this.git.execGit(['rev-list', '--parents', '-n', '1', sha], cwd, 5000);
    return { sha, branch, parents: ancestry.split(/\s+/).slice(1) };
  }

  async apply(repositoryPath: string, commit: string, operation: HistoryAction, mainline?: number, expectedBranch?: string): Promise<CommandResult> {
    let started = false;
    try {
      if (!['cherry-pick', 'revert', 'merge'].includes(operation)) {
        throw new Error('Unsupported history action');
      }
      const cwd = this.git.resolveRepositoryPath(repositoryPath);
      const { sha, branch, parents } = await this.describe(repositoryPath, commit);
      if (expectedBranch && branch !== expectedBranch) {
        throw new Error(`Current branch changed from ${expectedBranch} to ${branch}. Confirm the action again.`);
      }
      if (await this.pendingOperation(repositoryPath)) {
        throw new Error('Finish or abort the current Git operation first.');
      }
      const status = await this.git.execGitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, 10000);
      if (status) {
        throw new Error('Commit, stash, or discard working tree changes before running this action.');
      }
      if (operation !== 'merge' && parents.length > 1 &&
          (!Number.isInteger(mainline) || mainline! < 1 || mainline! > parents.length)) {
        throw new Error('Choose a parent for the merge commit.');
      }
      if (expectedBranch) {
        const currentBranch = await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000);
        if (currentBranch !== expectedBranch) {
          throw new Error(`Current branch changed from ${expectedBranch} to ${currentBranch}. Confirm the action again.`);
        }
      }
      const args = operation === 'merge'
        ? ['merge', '--no-edit', sha]
        : [operation, '--no-edit', ...(parents.length > 1 ? ['-m', String(mainline)] : []), sha];
      started = true;
      await this.git.execGit(args, cwd, 120000);
      return { success: true, message: `${operation} ${sha.slice(0, 12)} completed on ${branch}.` };
    } catch (error) {
      const pending = started ? await this.pendingOperation(repositoryPath).catch(() => undefined) : undefined;
      const detail = error instanceof Error ? error.message : String(error);
      let guidance = pending ? ` Resolve conflicts in Source Control, then run git ${pending} --continue, or abort the operation.` : '';
      if (pending === 'cherry-pick') {
        const cwd = this.git.resolveRepositoryPath(repositoryPath);
        const unmerged = await this.git.execGit(['ls-files', '-u'], cwd, 5000).catch(() => '');
        const changes = await this.git.execGitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=no'], cwd, 5000).catch(() => '');
        if (!unmerged && !changes) {
          guidance = ' This cherry-pick is empty. Run git cherry-pick --skip to move on, or git cherry-pick --abort.';
        }
      }
      return { success: false, data: { pending }, message: `${operation} failed: ${detail}${guidance}` };
    }
  }

  async pendingOperation(repositoryPath: string): Promise<PendingOperation | undefined> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    // One Git process asks for both paths, and the three refs are read together: each process costs
    // its start-up time (most of it on Windows), and a discard waits for this check.
    const refs = [['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['MERGE_HEAD', 'merge']] as const;
    const [paths, ...found] = await Promise.all([
      this.git.execGit(['rev-parse', '--git-path', 'rebase-apply', '--git-path', 'rebase-merge'], cwd, 5000),
      ...refs.map(([ref]) => this.git.execGit(['rev-parse', '-q', '--verify', ref], cwd, 5000).catch(() => ''))
    ]);
    const [rebaseApplyPath, rebaseMergePath] = paths.split('\n').map(value => path.resolve(cwd, value.trim()));
    if (existsSync(rebaseApplyPath)) {
      return existsSync(path.join(rebaseApplyPath, 'applying')) ? 'am' : 'rebase';
    }
    if (rebaseMergePath && existsSync(rebaseMergePath)) {
      return 'rebase';
    }
    const index = found.findIndex(Boolean);
    return index >= 0 ? refs[index][1] : undefined;
  }

  async abort(repositoryPath: string, operation: HistoryAction): Promise<CommandResult> {
    try {
      if (await this.pendingOperation(repositoryPath) !== operation) {
        throw new Error('That operation is no longer in progress.');
      }
      await this.git.execGit([operation, '--abort'], this.git.resolveRepositoryPath(repositoryPath), 30000);
      return { success: true, message: `${operation} aborted.` };
    } catch (error) {
      return { success: false, message: `Unable to abort ${operation}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
