/**
 * Branch Service
 * Handles branch-related operations
 */

import { GitCommandService } from './gitCommandService';
import { HistoryActionService } from './historyActionService';
import { BranchInfo, CommandResult } from '../types';

/** Git prints fetch progress on stderr before the real error; keep the lines that explain the failure. */
function summarizeGitError(message: string): string {
  const lines = message.split('\n').map(line => line.trim()).filter(Boolean);
  const reasons = lines.filter(line => /^(fatal|error):/i.test(line));
  return (reasons.length ? reasons : lines.slice(-1)).join(' ').replace(/^(fatal|error):\s*/i, '');
}

/** How a branch checkout related the branch to origin/<name>. */
export type BranchUpdateOutcome = 'up-to-date' | 'fast-forwarded' | 'ahead' | 'diverged' | 'blocked' | 'local-only';

export class BranchService {
  constructor(private gitCmd: GitCommandService) {}

  /** Create a local branch at a commit without checking out or pulling its base. */
  async createBranchFromCommit(repositoryPath: string, branchName: string, commit: string, checkout: boolean): Promise<CommandResult> {
    try {
      const root = this.gitCmd.resolveRepositoryPath(repositoryPath);
      if (!branchName || branchName.startsWith('-')) {
        throw new Error('Invalid branch name');
      }
      await this.gitCmd.execGit(['check-ref-format', '--branch', branchName], root);
      const sha = await this.gitCmd.resolveRevision(repositoryPath, commit);
      await this.gitCmd.execGit(['branch', branchName, sha], root);
      if (checkout) {
        try {
          await this.gitCmd.execGit(['switch', branchName], root);
        } catch (error) {
          return { success: true, data: { checkoutFailed: true }, message: `Branch '${branchName}' was created at ${sha.slice(0, 8)}, but checkout failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      return { success: true, message: `Branch '${branchName}' created at ${sha.slice(0, 8)}${checkout ? ' and checked out' : ''}` };
    } catch (error) {
      return { success: false, message: `Failed to create branch: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Get branches for a submodule (fast - single git command, no network calls)
   */
  async getBranches(submodulePath: string): Promise<BranchInfo[]> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);
    const branches: BranchInfo[] = [];

    try {
      // Use simple git branch -a command (most compatible) with 5s timeout
      const output = await this.gitCmd.execGit(['branch', '-a'], fullPath, 5000);
      const localNames = new Set<string>();
      const remoteNames = new Set<string>();
      let currentBranchName = '';

      // First pass: categorize all branches into local and remote sets
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.includes('HEAD')) {
          continue;
        }

        const isCurrent = trimmed.startsWith('*');
        const branchName = trimmed.replace(/^\*\s*/, '').trim();
        const isRemote = branchName.startsWith('remotes/origin/') || branchName.startsWith('origin/');
        const cleanName = branchName
          .replace(/^remotes\/origin\//, '')
          .replace(/^origin\//, '');

        if (isCurrent && !isRemote) {
          currentBranchName = cleanName;
        }

        if (isRemote) {
          remoteNames.add(cleanName);
        } else {
          localNames.add(cleanName);
        }
      }

      // Second pass: build unique branch list with local/remote tracking
      const allNames = new Set([...localNames, ...remoteNames]);
      for (const name of allNames) {
        const hasLocalCopy = localNames.has(name);
        const hasRemoteCopy = remoteNames.has(name);
        // Prefer local over remote for dedup
        const isRemote = hasRemoteCopy && !hasLocalCopy;

        branches.push({
          name,
          isRemote,
          isCurrent: name === currentBranchName,
          commit: '',
          // For remote-only branches: mark if they also have a local checkout
          hasLocal: isRemote && hasLocalCopy ? true : undefined,
          // For local branches: mark if they also exist on remote (checked out from remote)
          hasRemote: !isRemote && hasRemoteCopy ? true : undefined
        });
      }

      // Sort: current first, then alphabetically
      branches.sort((a, b) => {
        if (a.isCurrent) {
          return -1;
        }
        if (b.isCurrent) {
          return 1;
        }
        return a.name.localeCompare(b.name);
      });

    } catch (error) {
      console.error('Error getting branches:', error);
    }

    return branches;
  }

  /**
   * Create a branch in the specified submodule
   */
  async createBranch(
    submodulePath: string,
    branchName: string,
    baseBranch?: string,
    checkout: boolean = true
  ): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      // If base branch specified, start from it
      if (baseBranch) {
        await this.gitCmd.execGit(['checkout', baseBranch], fullPath);
        await this.gitCmd.execGit(['pull', 'origin', baseBranch], fullPath);
      }

      // Create the branch
      if (checkout) {
        await this.gitCmd.execGit(['checkout', '-b', branchName], fullPath);
      } else {
        await this.gitCmd.execGit(['branch', branchName], fullPath);
      }

      return { success: true, message: `Branch '${branchName}' created successfully` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to create branch: ${err.message}` };
    }
  }

  /**
   * Create a branch across multiple submodules
   */
  async createBranchAcrossSubmodules(
    submodulePaths: string[],
    branchName: string,
    baseBranch?: string,
    checkout: boolean = true
  ): Promise<Map<string, CommandResult>> {
    const results = new Map<string, CommandResult>();

    for (const submodulePath of submodulePaths) {
      const result = await this.createBranch(submodulePath, branchName, baseBranch, checkout);
      results.set(submodulePath, result);
    }

    return results;
  }

  /**
   * Checkout a branch in a submodule
   */
  async checkoutBranch(
    submodulePath: string,
    branchName: string,
    replaceWithRemote: boolean = false
  ): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      if (replaceWithRemote) {
        const workingTree = await this.gitCmd.execGit(['status', '--porcelain'], fullPath);
        if (workingTree.trim()) {
          return {
            success: false,
            message: 'Cannot replace the local branch while the working tree has uncommitted changes'
          };
        }

        const remoteBranch = `origin/${branchName}`;
        await this.gitCmd.execGit(['rev-parse', '--verify', `refs/remotes/${remoteBranch}`], fullPath);
        await this.gitCmd.execGit(['checkout', '-B', branchName, remoteBranch], fullPath);
        await this.gitCmd.execGit(['branch', '--set-upstream-to', remoteBranch, branchName], fullPath);
        return {
          success: true,
          message: `Replaced local '${branchName}' with '${remoteBranch}'`
        };
      }

      return await this.checkoutAndUpdate(fullPath, branchName);
    } catch (error: unknown) {
      const err = error as Error;
      return {
        success: false,
        message: replaceWithRemote
          ? `Failed to replace local branch from origin: ${err.message}`
          : `Failed to checkout: ${err.message}`
      };
    }
  }

  /**
   * Check out a branch; when it is on origin, fetch it first and fast-forward it afterwards.
   * Only a fast-forward is ever applied, so nothing the person committed is rewritten.
   * `data.update` names the outcome (see BranchUpdateOutcome).
   */
  private async checkoutAndUpdate(fullPath: string, name: string): Promise<CommandResult> {
    const exec = (args: string[], timeout?: number) => this.gitCmd.execGit(args, fullPath, timeout);
    const ok = (args: string[]) => exec(args).then(() => true, () => false);
    const remoteRef = `refs/remotes/origin/${name}`;
    const originName = `origin/${name}`;
    const done = (update: BranchUpdateOutcome, message: string): CommandResult =>
      ({ success: true, message, data: { update } });

    const hasLocal = await ok(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    let onOrigin = !hasLocal || await ok(['rev-parse', '--verify', '--quiet', remoteRef]);

    let fetchNote = '';
    if (onOrigin) {
      try {
        await exec(['fetch', 'origin', `+refs/heads/${name}:${remoteRef}`]);
      } catch (error: unknown) {
        const text = (error as Error).message;
        if (/couldn't find remote ref/i.test(text)) {
          // origin no longer has the branch: forget only this stale tracking ref.
          await ok(['update-ref', '-d', remoteRef]);
          onOrigin = await ok(['rev-parse', '--verify', '--quiet', remoteRef]);
        } else {
          fetchNote = `Could not fetch origin; used ${originName} as last fetched. `;
        }
      }
    }

    const current = await exec(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
    if (!hasLocal && onOrigin) {
      await exec(['checkout', '-b', name, '--track', originName]);
    } else if (current !== name) {
      await exec(['checkout', name]);
    }

    if (!onOrigin) {
      return done('local-only', `${fetchNote}Checked out '${name}'`);
    }

    const counts = (await exec(['rev-list', '--left-right', '--count', `${name}...${originName}`])).split(/\s+/).map(Number);
    const [ahead, behind] = counts;
    if (!ahead && !behind) {
      return done('up-to-date', `${fetchNote}${name} is up to date with origin`);
    }
    if (ahead && !behind) {
      return done('ahead', `${fetchNote}${name} has ${ahead} commit${ahead === 1 ? '' : 's'} not on origin`);
    }
    if (ahead && behind) {
      return done('diverged', `${fetchNote}${name} and ${originName} have diverged (${ahead} ahead, ${behind} behind). Use Pull or Reset to origin.`);
    }
    try {
      await exec(['merge', '--ff-only', originName]);
      return done('fast-forwarded', `${fetchNote}Updated ${name} by ${behind} commit${behind === 1 ? '' : 's'} from origin`);
    } catch (error: unknown) {
      const reason = /overwritten/i.test((error as Error).message)
        ? 'local changes would be overwritten. Commit or stash them, then Pull.'
        : summarizeGitError((error as Error).message);
      return done('blocked', `${fetchNote}Checked out ${name}; not updated: ${reason}`);
    }
  }

  /**
   * Pull changes for a submodule
   */
  async pullChanges(submodulePath: string, branch?: string): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    // A detached HEAD (normal for submodules) has no branch to pull into; `git pull origin HEAD`
    // would merge the remote default branch into it and move the repository off its recorded commit.
    const currentBranch = branch || await this.gitCmd.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], fullPath).catch(() => '');
    if (!currentBranch) {
      return { success: false, message: 'Cannot pull: HEAD is detached. Check out a branch first.' };
    }
    // Pull from the configured upstream when there is one, so branches tracking a differently
    // named remote branch work; otherwise fall back to the same-named branch on origin.
    const upstream = branch ? '' : await this.gitCmd.execGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], fullPath
    ).catch(() => '');

    try {
      await this.gitCmd.execGit(upstream ? ['pull'] : ['pull', 'origin', currentBranch], fullPath, 120000);
      return { success: true, message: `Pulled ${upstream || `origin/${currentBranch}`} into ${currentBranch}` };
    } catch (error: unknown) {
      const pending = await new HistoryActionService(this.gitCmd).pendingOperation(submodulePath).catch(() => undefined);
      if (pending === 'merge' || pending === 'rebase') {
        return {
          success: false,
          message: `Pull stopped with conflicts; a ${pending} is in progress in ${currentBranch}. Resolve the conflicts in Source Control, then continue or abort the ${pending}.`
        };
      }
      const reason = summarizeGitError((error as Error).message);
      if (/divergent branches|not possible to fast-forward/i.test((error as Error).message)) {
        return {
          success: false,
          message: `Cannot pull: ${currentBranch} and ${upstream || `origin/${currentBranch}`} have diverged. Merge or rebase them, or set git's pull.rebase option.`
        };
      }
      return { success: false, message: `Failed to pull: ${reason}` };
    }
  }

  /**
   * Push changes for a submodule
   */
  async pushChanges(submodulePath: string, branch?: string): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      const currentBranch = branch || await this.gitCmd.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], fullPath);
      if (currentBranch === 'HEAD') {
        return { success: false, message: 'Failed to push: HEAD is detached. Check out a branch to push.' };
      }
      // The branch's own remote when it has one (a fork, a second remote), else origin.
      const remote = await this.gitCmd.execGit(['config', '--get', `branch.${currentBranch}.remote`], fullPath).catch(() => '') || 'origin';
      await this.gitCmd.execGit(['push', '-u', remote, currentBranch], fullPath);
      return { success: true, message: 'Changes pushed successfully' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to push: ${err.message}` };
    }
  }

  /**
   * Delete a branch in a submodule
   */
  async deleteBranch(
    submodulePath: string,
    branchName: string,
    deleteRemote: boolean = false
  ): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      // Check if trying to delete current branch
      const currentBranch = await this.gitCmd.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], fullPath);
      if (currentBranch === branchName) {
        return { success: false, message: `Cannot delete the currently checked out branch '${branchName}'` };
      }

      // Delete local branch
      await this.gitCmd.execGit(['branch', '-D', branchName], fullPath);

      // Optionally delete remote branch
      if (deleteRemote) {
        try {
          await this.gitCmd.execGit(['push', 'origin', '--delete', branchName], fullPath);
        } catch (error: unknown) {
          const err = error as Error;
          return {
            success: true,
            message: `Local branch '${branchName}' deleted, but failed to delete remote: ${err.message}`
          };
        }
      }

      return { success: true, message: `Branch '${branchName}' deleted successfully${deleteRemote ? ' (local + remote)' : ''}` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to delete branch: ${err.message}` };
    }
  }

  /**
   * Delete a branch across multiple submodules
   */
  async deleteBranchAcrossSubmodules(
    submodulePaths: string[],
    branchName: string,
    deleteRemote: boolean = false
  ): Promise<Map<string, CommandResult>> {
    const results = new Map<string, CommandResult>();

    for (const submodulePath of submodulePaths) {
      const result = await this.deleteBranch(submodulePath, branchName, deleteRemote);
      results.set(submodulePath, result);
    }

    return results;
  }

  /**
   * Fetch updates for a submodule
   */
  /**
   * Fetch without any credential prompt, for periodic background refreshes.
   * Never prunes (even with fetch.prune set): removing deleted remote branches is left to the manual Fetch.
   * Failures (offline, auth required) are left to the caller to ignore.
   */
  async fetchInBackground(submodulePath: string): Promise<void> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);
    const env = { ...process.env };
    env.GIT_TERMINAL_PROMPT = '0';
    // An empty GIT_ASKPASS also stops Git falling back to core.askPass and SSH_ASKPASS.
    env.GIT_ASKPASS = '';
    env.SSH_ASKPASS_REQUIRE = 'never';
    env.GCM_INTERACTIVE = 'never';
    await this.gitCmd.execGitRaw(['fetch', '--all', '--no-prune', '--quiet'], fullPath, 60000, false, env);
  }

  async fetchUpdates(submodulePath: string): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);

    try {
      await this.gitCmd.execGit(['fetch', '--all', '--prune'], fullPath);
      return { success: true, message: 'Updates fetched successfully' };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, message: `Failed to fetch: ${err.message}` };
    }
  }
}
