import { CommandResult } from '../types';
import { GitCommandService } from './gitCommandService';
import { HistoryActionService } from './historyActionService';
import { TreeWrites, assertNoCollisions, trackedChanges, trackedChangesMessage } from './untrackedGuard';

export type HistoryRewriteAction = 'rebase' | 'reset' | 'drop';
export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface HistoryRewritePreview {
  action: HistoryRewriteAction;
  branch: string;
  head: string;
  target: string;
  targetSubject: string;
  affectedCount: number;
  /** For a rebase: how many of the commits that move are already on a remote (reachable from refs/remotes). */
  publishedCount: number;
  affected: { hash: string; subject: string }[];
}

export class HistoryRewriteService {
  private historyActions: HistoryActionService;

  constructor(private git: GitCommandService) {
    this.historyActions = new HistoryActionService(git);
  }

  async preview(repositoryPath: string, revision: string, action: HistoryRewriteAction): Promise<HistoryRewritePreview> {
    if (!['rebase', 'reset', 'drop'].includes(action)) {
      throw new Error('Unsupported history rewrite action.');
    }
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const target = await this.git.resolveRevision(repositoryPath, revision);
    const targetSubject = await this.git.execGit(['show', '-s', '--format=%s', target], cwd, 5000);
    const branch = await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000)
      .catch(() => { throw new Error('Checkout a local branch before rewriting its history.'); });
    const head = await this.git.resolveRevision(repositoryPath, 'HEAD');
    if (head === target && action !== 'drop') {
      throw new Error('The selected commit is already the current HEAD.');
    }
    let range: string;
    if (action === 'drop') {
      const ancestry = await this.git.execGit(['rev-list', '--first-parent', 'HEAD'], cwd, 10000);
      if (!ancestry.split('\n').includes(target)) {
        throw new Error('Only a commit on the current branch first-parent history can be dropped.');
      }
      const parents = (await this.git.execGit(['rev-list', '--parents', '-n', '1', target], cwd, 5000)).split(/\s+/).slice(1);
      if (parents.length !== 1) {
        throw new Error('Dropping a root or merge commit is not supported.');
      }
      const published = await this.git.execGit(['for-each-ref', `--contains=${target}`, '--format=%(refname)', 'refs/remotes'], cwd, 10000);
      if (published) {
        throw new Error('This commit is reachable from a remote branch. Dropping a published commit is blocked.');
      }
      range = `${target}..${head}`;
    } else if (action === 'rebase') {
      const base = await this.git.execGit(['merge-base', target, head], cwd, 5000)
        .catch(() => { throw new Error('The selected commit has no common ancestor with the current branch.'); });
      if (base === target) {
        throw new Error('The selected commit is already an ancestor of the current branch.');
      }
      range = `${base}..${head}`;
    } else {
      range = `${target}..${head}`;
    }
    if (action !== 'reset') {
      const merges = await this.git.execGit(['rev-list', '--merges', range], cwd, 10000);
      if (merges) {
        throw new Error('Rewriting a range containing merge commits is not supported.');
      }
    }
    const traversal = action === 'reset' ? [] : ['--first-parent'];
    const affectedCount = Number(await this.git.execGit(['rev-list', ...traversal, '--count', range], cwd, 10000));
    const log = await this.git.execGit(['log', ...traversal, '--reverse', '--max-count=10', '--format=%H%x1f%s', range], cwd, 10000);
    const affected = log.split('\n').filter(Boolean).map(line => {
      const [hash, ...subject] = line.split('\x1f');
      return { hash, subject: subject.join('\x1f') };
    });
    let publishedCount = 0;
    if (action === 'rebase') {
      const count = async (...extra: string[]) => Number(await this.git.execGit(['rev-list', '--count', range, ...extra], cwd, 10000));
      publishedCount = await count() - await count('--not', '--remotes');
    }
    return { action, branch, head, target, targetSubject, affectedCount, publishedCount, affected };
  }

  async execute(repositoryPath: string, target: string, action: HistoryRewriteAction,
    expectedBranch: string, expectedHead: string, mode?: ResetMode, ontoBranch?: string, ontoKind?: 'local' | 'remote'): Promise<CommandResult> {
    let started = false;
    let backup: string | undefined;
    try {
      if (!expectedBranch || !expectedHead) {
        throw new Error('Missing confirmed branch or HEAD.');
      }
      if (action === 'reset' && !['soft', 'mixed', 'hard'].includes(mode || '')) {
        throw new Error('Choose a reset mode.');
      }
      const cwd = this.git.resolveRepositoryPath(repositoryPath);
      const preview = await this.preview(repositoryPath, target, action);
      if (preview.branch !== expectedBranch || preview.head !== expectedHead || preview.target !== target) {
        throw new Error('Branch, HEAD, or selected commit changed. Review the action again.');
      }
      if (await this.historyActions.pendingOperation(repositoryPath)) {
        throw new Error('Finish or abort the current Git operation first.');
      }
      await this.assertRunnable(repositoryPath, target, action, expectedHead, mode);
      // A rebase onto a named branch goes to the tip the question showed; a branch that moved since is not rebased onto.
      if (ontoBranch && (await this.historyActions.resolveBranch(repositoryPath, ontoBranch, ontoKind)).sha !== target) {
        throw new Error(`Branch ${ontoBranch} moved while the question was open. Nothing was run; start the rebase again.`);
      }
      // Recheck immediately before making a backup or changing the current branch.
      if (await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000) !== expectedBranch ||
          await this.git.resolveRevision(repositoryPath, 'HEAD') !== expectedHead) {
        throw new Error('Current branch changed. Review the action again.');
      }
      if (action === 'drop' || (action === 'reset' && mode === 'hard')) {
        backup = `history-backup/${action}-${Date.now()}-${expectedHead.slice(0, 8)}`;
        await this.git.execGit(['branch', backup, expectedHead], cwd, 5000);
      }
      const args = action === 'reset'
        ? ['reset', `--${mode}`, target]
        : action === 'drop'
          ? expectedHead === target ? ['reset', '--hard', `${target}^`]
            : ['rebase', '--no-fork-point', '--onto', `${target}^`, target]
          : ['rebase', '--no-fork-point', '--onto', target, await this.git.execGit(['merge-base', target, expectedHead], cwd, 5000)];
      started = true;
      await this.git.execGit(args, cwd, 120000);
      return { success: true, data: { backup }, message: `${action}${mode ? ` (${mode})` : ''} completed on ${expectedBranch}.${backup ? ` Backup: ${backup}.` : ''}` };
    } catch (error) {
      const pending = started ? await this.historyActions.pendingOperation(repositoryPath).catch(() => undefined) : undefined;
      return { success: false, data: { pending, backup },
        message: `${action} failed: ${error instanceof Error ? error.message : String(error)}` +
          `${pending === 'rebase' ? ' Resolve conflicts, stage files, then continue or abort the rebase.' : ''}` +
          `${backup ? ` Backup: ${backup}.` : ''}` };
    }
  }

  /**
   * Refuses when tracked files have changes, or when an untracked file is at a path the action would
   * write (Git would lose it in `reset --hard`, or stop a rebase half-way). Other untracked files stay.
   */
  async assertRunnable(repositoryPath: string, target: string, action: HistoryRewriteAction, head: string, mode?: ResetMode): Promise<void> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    if (await trackedChanges(this.git, cwd)) {
      throw new Error(trackedChangesMessage('rewriting history'));
    }
    let writes: TreeWrites;
    if (action === 'reset') {
      // Soft and mixed resets do not touch the working tree.
      writes = mode === 'hard' ? { trees: [target], ranges: [] } : { trees: [], ranges: [] };
    } else if (action === 'drop') {
      writes = { trees: [`${target}^`], ranges: head === target ? [] : [`${target}..${head}`] };
    } else {
      const base = await this.git.execGit(['merge-base', target, head], cwd, 5000);
      writes = { trees: [target], ranges: [`${base}..${head}`] };
    }
    await assertNoCollisions(this.git, cwd, action, writes);
  }

  async resolveRebase(repositoryPath: string, command: 'continue' | 'abort'): Promise<CommandResult> {
    try {
      if (await this.historyActions.pendingOperation(repositoryPath) !== 'rebase') {
        throw new Error('There is no rebase in progress.');
      }
      const cwd = this.git.resolveRepositoryPath(repositoryPath);
      await this.git.execGit(['-c', 'core.editor=true', 'rebase', `--${command}`], cwd, 120000);
      return { success: true, message: `Rebase ${command} completed.` };
    } catch (error) {
      return { success: false, message: `Unable to ${command} rebase: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
