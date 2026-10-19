/**
 * Predicts the conflicts a history action would stop on, before it runs, by running the same
 * merges in memory with `git merge-tree --write-tree` (Git 2.40 or newer for --merge-base). Nothing
 * is checked out and no ref moves; a rebase's intermediate results are written as unreferenced
 * commits (`commit-tree`), which Git prunes like any other unreachable object.
 *
 * These are Git's own answers, not guesses: the dialog shows them as facts. A rebase is replayed
 * commit by commit and the prediction stops at the first one that conflicts, since what follows
 * depends on how that conflict is resolved.
 */

import { GitCommandService } from './gitCommandService';

export type PredictedOperation = 'cherry-pick' | 'revert' | 'merge' | 'rebase' | 'drop';

export interface PredictedConflict {
  /** The commit whose change conflicts (for merge, the merged commit). */
  commit: string;
  subject: string;
  paths: string[];
}

export interface ConflictPrediction {
  /** False when this Git cannot simulate it; `reason` says why, and nothing is claimed. */
  supported: boolean;
  reason?: string;
  conflicts: PredictedConflict[];
  /** Commits replayed before the first conflict, out of `steps`. */
  replayed: number;
  steps: number;
  /** A rebase was not predicted past its first conflict. */
  stoppedEarly: boolean;
}

const MAX_STEPS = 200;

export class ConflictPredictionService {
  constructor(private git: GitCommandService) {}

  /**
   * `commit` is the selected commit; for rebase, the commit the current branch moves onto; for a
   * merge commit picked or reverted, `mainline` names the parent, as `git -m` does.
   */
  async predict(repositoryPath: string, operation: PredictedOperation, commit: string, mainline?: number): Promise<ConflictPrediction> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const sha = await this.git.resolveRevision(repositoryPath, commit);
    const head = await this.git.resolveRevision(repositoryPath, 'HEAD');
    try {
      if (operation === 'merge') {
        const paths = await this.merge(cwd, undefined, head, sha);
        return this.result(paths ? [await this.conflict(cwd, sha, paths)] : [], 1, 1, false);
      }
      if (operation === 'cherry-pick' || operation === 'revert') {
        const parent = await this.git.execGit(['rev-parse', '--verify', `${sha}^${mainline || 1}^{commit}`], cwd, 5000)
          .catch(() => { throw new Unsupported('A root commit cannot be simulated.'); });
        // Picking applies parent → commit; reverting applies commit → parent.
        const paths = operation === 'cherry-pick' ? await this.merge(cwd, parent, head, sha) : await this.merge(cwd, sha, head, parent);
        return this.result(paths ? [await this.conflict(cwd, sha, paths)] : [], 1, 1, false);
      }
      // rebase onto `sha`, or drop `sha`: replay the branch's own commits, oldest first.
      const onto = operation === 'drop' ? `${sha}^` : sha;
      const from = operation === 'drop' ? sha : await this.git.execGit(['merge-base', sha, head], cwd, 5000);
      const commits = (await this.git.execGit(['rev-list', '--reverse', '--first-parent', `${from}..${head}`], cwd, 10000))
        .split('\n').filter(Boolean);
      if (commits.length > MAX_STEPS) {
        throw new Unsupported(`More than ${MAX_STEPS} commits to replay; not simulated.`);
      }
      let base = await this.git.resolveRevision(repositoryPath, onto);
      for (let index = 0; index < commits.length; index++) {
        const step = commits[index];
        const tree = await this.mergeTree(cwd, `${step}^`, base, step);
        if (tree.paths.length) {
          return this.result([await this.conflict(cwd, step, tree.paths)], index, commits.length, index < commits.length - 1);
        }
        base = await this.git.execGit(['commit-tree', tree.tree, '-p', base, '-m', 'conflict prediction'], cwd, 10000);
      }
      return this.result([], commits.length, commits.length, false);
    } catch (error) {
      if (error instanceof Unsupported) {
        return { supported: false, reason: error.message, conflicts: [], replayed: 0, steps: 0, stoppedEarly: false };
      }
      throw error;
    }
  }

  private result(conflicts: PredictedConflict[], replayed: number, steps: number, stoppedEarly: boolean): ConflictPrediction {
    return { supported: true, conflicts, replayed, steps, stoppedEarly };
  }

  private async conflict(cwd: string, commit: string, paths: string[]): Promise<PredictedConflict> {
    const subject = await this.git.execGit(['show', '-s', '--format=%s', commit], cwd, 5000).catch(() => '');
    return { commit, subject, paths };
  }

  /** The conflicted paths of one merge, or undefined when it is clean. */
  private async merge(cwd: string, mergeBase: string | undefined, ours: string, theirs: string): Promise<string[] | undefined> {
    const { paths } = await this.mergeTree(cwd, mergeBase, ours, theirs);
    return paths.length ? paths : undefined;
  }

  private async mergeTree(cwd: string, mergeBase: string | undefined, ours: string, theirs: string): Promise<{ tree: string; paths: string[] }> {
    let output: string;
    try {
      // -z: paths exactly as they are; exit code 1 means "conflicts", with the tree still written.
      output = await this.git.execGitRaw(['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages',
        ...(mergeBase ? [`--merge-base=${mergeBase}`] : []), ours, theirs], cwd, 60000, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/unknown option|usage: git merge-tree/i.test(message)) {
        throw new Unsupported('Predicting conflicts needs Git 2.40 or newer.');
      }
      throw error;
    }
    const [tree, ...rest] = output.split('\0');
    return { tree, paths: [...new Set(rest.filter(Boolean))] };
  }
}

class Unsupported extends Error {}
