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

/** Why an update stopped without fast-forwarding. */
export type BranchUpdateSkip = 'newer-click' | 'head-moved' | 'operation-pending';

/**
 * Numbers the branch clicks of each repository. A background update asks whether its click is still
 * the latest: after a newer click it must not move any branch.
 */
export class BranchSwitchTracker {
  private readonly latest = new Map<string, number>();
  private counter = 0;

  begin(root: string): number {
    const number = ++this.counter;
    this.latest.set(root, number);
    return number;
  }

  isLatest(root: string, number: number): boolean {
    return this.latest.get(root) === number;
  }
}

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

      // Check out, then update from origin: for callers that wait for one message (commands).
      const switched = await this.switchBranch(submodulePath, branchName);
      if (!switched.success || (switched.data as { update?: string } | undefined)?.update !== 'pending') {
        return switched;
      }
      const updated = await this.updateBranch(submodulePath, branchName);
      return (updated.data as { skipped?: string } | undefined)?.skipped ? switched : updated;
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
   * Check out a branch and say whether it still has to be updated from origin.
   *
   * A branch that exists locally is checked out at once: one Git process reads what exists and what
   * is current, one switches (none when it is already current), and no network is involved. When it
   * is on origin, `data.update` is 'pending' and `updateBranch` brings the new commits afterwards.
   * A branch that exists only on origin keeps the old order, fetch then create, because creating it
   * from a stale or deleted `origin/<name>` would leave a wrong branch behind.
   * `data.unchanged` is true when the branch was already checked out.
   */
  async switchBranch(submodulePath: string, name: string, options: { settleAutoFetch?: () => Promise<boolean> } = {}): Promise<CommandResult> {
    try {
      const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);
      if (!name || name.startsWith('-')) {
        throw new Error('Invalid branch name');
      }
      const exec = (args: string[], timeout?: number) => this.gitCmd.execGit(args, fullPath, timeout);
      const remoteRef = `refs/remotes/origin/${name}`;
      // One process answers whether the branch exists locally, whether it is the current one
      // (%(HEAD) marks it with *), and whether origin has it as far as this machine knows.
      const listing = (await exec(['for-each-ref', '--format=%(refname)%09%(HEAD)', `refs/heads/${name}`, remoteRef], 5000))
        .split('\n').map(line => line.split('\t'));
      const local = listing.find(([ref]) => ref === `refs/heads/${name}`);
      const onOrigin = listing.some(([ref]) => ref === remoteRef);

      if (local) {
        const unchanged = (local[1] || '').trim() === '*';
        if (!unchanged) {
          // `--` makes Git take the name as a branch only, never as a path.
          await exec(['checkout', name, '--']);
        }
        return {
          success: true,
          message: `Checked out '${name}'`,
          data: { update: onOrigin ? 'pending' : 'local-only', unchanged }
        };
      }
      return await this.createFromOrigin(fullPath, name, options.settleAutoFetch);
    } catch (error: unknown) {
      return { success: false, message: `Failed to checkout: ${(error as Error).message}` };
    }
  }

  /** A branch that exists only on origin: fetch it, then create the local branch from the fetched copy. */
  private async createFromOrigin(fullPath: string, name: string, settleAutoFetch?: () => Promise<boolean>): Promise<CommandResult> {
    const exec = (args: string[], timeout?: number) => this.gitCmd.execGit(args, fullPath, timeout);
    const ok = (args: string[]) => exec(args).then(() => true, () => false);
    const remoteRef = `refs/remotes/origin/${name}`;
    // A background fetch may hold the ref locks; let it finish first.
    await settleAutoFetch?.().catch(() => false);
    let onOrigin = true;
    let fetchNote = '';
    try {
      await exec(['fetch', 'origin', `+refs/heads/${name}:${remoteRef}`]);
    } catch (error: unknown) {
      if (/couldn't find remote ref/i.test((error as Error).message)) {
        // origin no longer has the branch: forget only this stale tracking ref.
        await ok(['update-ref', '-d', remoteRef]);
        onOrigin = await ok(['rev-parse', '--verify', '--quiet', remoteRef]);
      } else {
        fetchNote = `Could not fetch origin; used origin/${name} as last fetched. `;
      }
    }
    if (!onOrigin) {
      // Never fall back to a bare `checkout <name>`: with no such branch Git reads it as a path and
      // restores that file, discarding its edits.
      return { success: false, message: `${name} is no longer on origin and has no local branch.` };
    }
    await exec(['checkout', '-b', name, '--track', remoteRef]);
    const update: BranchUpdateOutcome = 'up-to-date';
    return {
      success: true,
      message: `${fetchNote}${name} is up to date with origin`,
      data: { update, fetchFailed: Boolean(fetchNote) }
    };
  }

  /**
   * Bring a checked-out branch up to date with origin: fetch it, compare it, and fast-forward it
   * when it is only behind. Only a fast-forward is ever applied, so nothing the person committed is
   * rewritten. `data.update` names the outcome (see BranchUpdateOutcome).
   *
   * It runs after the click's result, so the person may have moved on. It stops after its fetch when
   * a newer click started (`isLatest`), and it fast-forwards only while HEAD is still this branch and
   * no merge, rebase, cherry-pick or revert is pending; then `data.skipped` says why and nothing but
   * the fetched `origin/<name>` has changed.
   */
  async updateBranch(
    submodulePath: string,
    name: string,
    options: { settleAutoFetch?: () => Promise<boolean>; isLatest?: () => boolean } = {}
  ): Promise<CommandResult> {
    const fullPath = this.gitCmd.resolveRepositoryPath(submodulePath);
    const exec = (args: string[], timeout?: number) => this.gitCmd.execGit(args, fullPath, timeout);
    const ok = (args: string[]) => exec(args).then(() => true, () => false);
    const remoteRef = `refs/remotes/origin/${name}`;
    const originName = `origin/${name}`;
    const done = (update: BranchUpdateOutcome, message: string, extra: Record<string, unknown> = {}): CommandResult =>
      ({ success: true, message, data: { update, ...extra } });
    const skipped = (reason: BranchUpdateSkip): CommandResult => ({ success: true, message: '', data: { skipped: reason } });
    const isLatest = options.isLatest || (() => true);

    try {
      if (!await ok(['rev-parse', '--verify', '--quiet', remoteRef])) {
        return done('local-only', `Checked out '${name}'`);
      }
      let fetchNote = '';
      // A running auto-fetch has fetched this repository when it says so: use its copy.
      const covered = await options.settleAutoFetch?.().catch(() => false);
      if (!covered) {
        try {
          await exec(['fetch', 'origin', `+refs/heads/${name}:${remoteRef}`]);
        } catch (error: unknown) {
          if (/couldn't find remote ref/i.test((error as Error).message)) {
            // origin no longer has the branch: forget only this stale tracking ref.
            await ok(['update-ref', '-d', remoteRef]);
            if (!await ok(['rev-parse', '--verify', '--quiet', remoteRef])) {
              return done('local-only', `Checked out '${name}'`);
            }
          } else {
            fetchNote = `Could not fetch origin; used ${originName} as last fetched. `;
          }
        }
      }
      const extra = { fetchFailed: Boolean(fetchNote) };
      if (!isLatest()) { return skipped('newer-click'); }

      // Full ref names: a tag called like the branch must not stand in for it.
      const counts = (await exec(['rev-list', '--left-right', '--count', `refs/heads/${name}...${remoteRef}`])).split(/\s+/).map(Number);
      const [ahead, behind] = counts;
      if (!ahead && !behind) {
        return done('up-to-date', `${fetchNote}${name} is up to date with origin`, extra);
      }
      if (ahead && !behind) {
        return done('ahead', `${fetchNote}${name} has ${ahead} commit${ahead === 1 ? '' : 's'} not on origin`, extra);
      }
      if (ahead && behind) {
        return done('diverged', `${fetchNote}${name} and ${originName} have diverged (${ahead} ahead, ${behind} behind). Use Pull or Reset to origin.`, extra);
      }

      // Guards, right before the merge: the person may have left this branch, or started an operation.
      if (await new HistoryActionService(this.gitCmd).pendingOperation(submodulePath).catch(() => undefined)) {
        return skipped('operation-pending');
      }
      const head = await exec(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '');
      if (!isLatest()) { return skipped('newer-click'); }
      if (head !== `refs/heads/${name}`) { return skipped('head-moved'); }
      try {
        // --no-autostash: with merge.autoStash set, Git would carry overlapping edits across the
        // update and leave conflicts, instead of refusing as `blocked` promises.
        await exec(['merge', '--ff-only', '--no-autostash', remoteRef]);
        return done('fast-forwarded', `${fetchNote}Updated ${name} by ${behind} commit${behind === 1 ? '' : 's'} from origin`, extra);
      } catch (error: unknown) {
        const reason = /overwritten/i.test((error as Error).message)
          ? 'local changes would be overwritten. Commit or stash them, then Pull.'
          : summarizeGitError((error as Error).message);
        return done('blocked', `${fetchNote}Checked out ${name}; not updated: ${reason}`, extra);
      }
    } catch (error: unknown) {
      return done('blocked', `Checked out ${name}; not updated: ${summarizeGitError((error as Error).message)}`);
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
