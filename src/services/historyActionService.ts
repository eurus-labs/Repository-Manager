import { CommandResult } from '../types';
import { existsSync } from 'fs';
import * as path from 'path';
import { GitCommandService } from './gitCommandService';
import { TreeWrites, assertNoCollisions, trackedChanges, trackedChangesMessage } from './untrackedGuard';

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

  /**
   * A branch by name (local first, then remote-tracking such as `origin/x`), as its full ref and tip.
   * Names that start with `-` or match no branch are refused, so a name never reaches Git as an option.
   */
  async resolveBranch(repositoryPath: string, name: string, kind?: 'local' | 'remote'): Promise<{ name: string; ref: string; sha: string }> {
    if (typeof name !== 'string' || !name || name.startsWith('-') || /[\s\0]/.test(name)) {
      throw new Error('Invalid branch name.');
    }
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    // A label's kind keeps its namespace: a local branch may be called origin/topic beside refs/remotes/origin/topic.
    const refs = kind === 'local' ? [`refs/heads/${name}`] : kind === 'remote' ? [`refs/remotes/${name}`] : [`refs/heads/${name}`, `refs/remotes/${name}`];
    for (const ref of refs) {
      const sha = await this.git.execGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, 5000).catch(() => '');
      if (sha) {
        return { name, ref, sha };
      }
    }
    throw new Error(`Branch ${name} no longer exists.`);
  }

  /** What merging `sha` into HEAD brings: the first 20 incoming commits and their count. */
  async previewMerge(repositoryPath: string, sha: string): Promise<{ count: number; commits: { hash: string; subject: string }[]; fastForward: boolean; upToDate: boolean;
    ffSetting?: 'no' | 'only'; ffSource?: string; noFastForward?: boolean }> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const isAncestor = (ancestor: string, descendant: string) =>
      this.git.execGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd, 5000).then(() => true, () => false);
    if (await isAncestor(sha, 'HEAD')) {
      return { count: 0, commits: [], fastForward: false, upToDate: true };
    }
    const count = Number(await this.git.execGit(['rev-list', '--count', `HEAD..${sha}`], cwd, 10000));
    const log = await this.git.execGit(['log', '--max-count=20', '--format=%H%x1f%s', `HEAD..${sha}`], cwd, 10000);
    const commits = log.split('\n').filter(Boolean).map(line => {
      const [hash, ...subject] = line.split('\x1f');
      return { hash, subject: subject.join('\x1f') };
    });
    const canFastForward = await isAncestor('HEAD', sha);
    // The branch's own merge options win over merge.ff: --no-ff and --ff-only decide what Git will do.
    const setting = async (key: string) => this.git.execGit(['config', '--get', key], cwd, 5000).catch(() => '');
    const branch = await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000).catch(() => '');
    const options = branch ? (await setting(`branch.${branch}.mergeOptions`)).split(/\s+/) : [];
    const global = (await setting('merge.ff')).trim().toLowerCase();
    let ffSetting: 'no' | 'only' | undefined;
    let ffSource: string | undefined;
    const last = [...options].reverse().find(option => option === '--no-ff' || option === '--ff-only' || option === '--ff');
    if (last) {
      ffSetting = last === '--no-ff' ? 'no' : last === '--ff-only' ? 'only' : undefined;
      ffSource = `branch.${branch}.mergeOptions=${last}`;
    } else if (['false', 'no', 'off', '0'].includes(global)) {
      ffSetting = 'no'; ffSource = 'merge.ff=false';
    } else if (global === 'only') {
      ffSetting = 'only'; ffSource = 'merge.ff=only';
    }
    return { count, commits, fastForward: canFastForward && ffSetting !== 'no', upToDate: false, ffSetting, ffSource, noFastForward: canFastForward && ffSetting === 'no' };
  }

  /** `mergeBranch` merges by that branch's name (so the merge message names it) after checking its tip is still `commit`. */
  async apply(repositoryPath: string, commit: string, operation: HistoryAction, mainline?: number, expectedBranch?: string,
    mergeBranch?: string, mergeKind?: 'local' | 'remote'): Promise<CommandResult> {
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
      if (await trackedChanges(this.git, cwd)) {
        throw new Error(trackedChangesMessage('running this action'));
      }
      if (operation !== 'merge' && parents.length > 1 &&
          (!Number.isInteger(mainline) || mainline! < 1 || mainline! > parents.length)) {
        throw new Error('Choose a parent for the merge commit.');
      }
      await this.assertNoUntrackedCollisions(repositoryPath, sha, operation, parents, mainline);
      let mergeRef: string | undefined;
      if (mergeBranch) {
        const named = await this.resolveBranch(repositoryPath, mergeBranch, mergeKind);
        if (named.sha !== sha) {
          throw new Error(`Branch ${mergeBranch} moved while the question was open. Nothing was run; start the merge again.`);
        }
        // The plain name gives the merge message "Merge branch 'x'"; a tag of the same name would win, so then the full ref is used.
        const byName = await this.git.execGit(['rev-parse', '--verify', '--quiet', `${mergeBranch}^{commit}`], cwd, 5000).catch(() => '');
        mergeRef = byName === sha ? mergeBranch : named.ref;
      }
      if (expectedBranch) {
        const currentBranch = await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000);
        if (currentBranch !== expectedBranch) {
          throw new Error(`Current branch changed from ${expectedBranch} to ${currentBranch}. Confirm the action again.`);
        }
      }
      const args = operation === 'merge'
        ? ['merge', '--no-edit', mergeRef ?? sha]
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

  /** Refuses when an untracked file is at a path the action would write; other untracked files stay. */
  async assertNoUntrackedCollisions(repositoryPath: string, sha: string, operation: HistoryAction,
    parents: string[], mainline?: number): Promise<void> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    let writes: TreeWrites;
    if (operation === 'merge') {
      const base = await this.git.execGit(['merge-base', 'HEAD', sha], cwd, 5000).catch(() => '');
      writes = { trees: [sha], ranges: base ? [`${base}..${sha}`] : [] };
    } else if (!parents.length) {
      writes = { trees: [sha], ranges: [] };
    } else {
      writes = { trees: [], ranges: [parents.length > 1 ? `${sha}^${mainline}..${sha}` : `${sha}^..${sha}`] };
    }
    await assertNoCollisions(this.git, cwd, operation, writes);
  }

  /** The same refusals `apply` makes for changes to tracked files and colliding untracked files, before a confirm. */
  async assertRunnable(repositoryPath: string, sha: string, operation: HistoryAction, parents: string[], mainline?: number): Promise<void> {
    if (await trackedChanges(this.git, this.git.resolveRepositoryPath(repositoryPath))) {
      throw new Error(trackedChangesMessage('running this action'));
    }
    await this.assertNoUntrackedCollisions(repositoryPath, sha, operation, parents, mainline);
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
