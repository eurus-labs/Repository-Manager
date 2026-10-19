import { ReviewCoverage, ReviewRequest } from '../types';
import { parseChangedFilesOutput } from './diffService';
import { GitCommandService } from './gitCommandService';
import { LoadedReviewPolicy, ReviewPolicyRule, ReviewPolicyService } from './reviewPolicyService';
import { ReviewSnapshot, ReviewSnapshotService } from './reviewSnapshotService';

const MAX_REVIEW_FILES = 256;
const FILES_PER_BATCH = 8;
/** Paths per `git diff --numstat` call when looking for binary files. */
const BINARY_CHECK_BATCH = 100; // keeps the command line short on Windows (about 32 KB)
const EMPTY_TREE: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
};

/**
 * Dependency lockfiles: generated, long, and mostly hashes. A diff review sends only their changed
 * entries (added or updated packages and where they come from); a review of every file skips them.
 */
const LOCKFILES = new Set(['uv.lock', 'poetry.lock', 'pipfile.lock', 'pdm.lock', 'package-lock.json', 'npm-shrinkwrap.json',
  'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'cargo.lock', 'gemfile.lock', 'composer.lock', 'go.sum', 'packages.lock.json',
  'podfile.lock', 'mix.lock', 'pubspec.lock', 'gradle.lockfile', 'flake.lock', 'package.resolved']);

export function isLockfile(filePath: string): boolean {
  return LOCKFILES.has((filePath.split('/').pop() || '').toLowerCase());
}

/** Paths Git counts as binary in `git diff --numstat -z` output ("-\t-\tpath"). */
export function binaryPathsFromNumstat(output: string): Set<string> {
  const binary = new Set<string>();
  for (const record of output.split('\0')) {
    const match = /^-\t-\t([\s\S]+)$/.exec(record);
    if (match) { binary.add(match[1]); }
  }
  return binary;
}

export interface ReviewWorkUnit {
  component: string;
  paths: string[];
  rules: ReviewPolicyRule[];
}
export interface ReviewPlan {
  request: ReviewRequest;
  snapshot: ReviewSnapshot;
  base?: ReviewSnapshot;
  policy: LoadedReviewPolicy;
  changedPaths: string[];
  oldPaths: Record<string, string>;
  units: ReviewWorkUnit[];
  coverage: ReviewCoverage;
}

/** Only repository-relative glob patterns, with *, ** and ?. No filesystem access. */
/** Policy scopes match case-sensitively, as Git paths do; review skills pass ignoreCase so `*auth*` finds Auth.java. */
export function matchesReviewPattern(pattern: string, filePath: string, options: { ignoreCase?: boolean } = {}): boolean {
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      expression += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += pattern[i + 2] === '/' ? 2 : 1;
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`${expression}$`, options.ignoreCase ? 'i' : '').test(filePath);
}

export function appliesToPath(rule: ReviewPolicyRule, filePath: string): boolean {
  return rule.scope.include.some(pattern => matchesReviewPattern(pattern, filePath)) &&
    !(rule.scope.exclude || []).some(pattern => matchesReviewPattern(pattern, filePath));
}

/** Target-side line ranges of a unified diff's hunks ("@@ -a,b +c,d @@"), merged; pure deletions have none. */
export function changedTargetRanges(patch: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!count) { continue; }
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) { last[1] = Math.max(last[1], start + count - 1); } else { ranges.push([start, start + count - 1]); }
  }
  return ranges;
}

/** The component a path belongs to: its first two folders (or its first, for shallow paths). */
export function component(path: string): string {
  const parts = path.split('/');
  return parts.length < 3 ? parts[0] : parts.slice(0, 2).join('/');
}

export class ReviewSurveyService {
  private snapshots: ReviewSnapshotService;
  private policies = new ReviewPolicyService();
  constructor(private git: GitCommandService) {
    this.snapshots = new ReviewSnapshotService(git);
  }

  async plan(request: ReviewRequest): Promise<ReviewPlan> {
    if (request.paths && (request.scope !== 'changes' || !request.paths.length)) {
      throw new Error('Only a changes review can be limited to some files.');
    }
    if (!['branch', 'changes'].includes(request.scope) || !request.categories.length ||
        request.categories.some(category => !['security', 'compliance', 'quality'].includes(category))) {
      throw new Error('Invalid review scope or categories');
    }
    const snapshot = await this.snapshots.open(request.repositoryPath, request.targetSha);
    const policy = request.categories.includes('compliance')
      ? await this.policies.load(snapshot)
      : { status: 'not_configured' as const, revision: snapshot.targetSha };
    if (request.policyHash && (policy.status !== 'configured' || request.policyHash !== policy.hash)) {
      throw new Error('Selected policy does not match the target revision');
    }
    const root = snapshot.repositoryPath;
    let base: ReviewSnapshot | undefined;
    let changedPaths: string[] = [];
    const oldPaths: Record<string, string> = {};
    if (request.scope === 'changes') {
      const parents = await this.git.execGit(['rev-list', '--parents', '-n', '1', snapshot.targetSha], root, 5000);
      const baseRef = request.baseSha || parents.split(/\s+/)[1];
      if (baseRef) { base = await this.snapshots.open(request.repositoryPath, baseRef); }
      const output = base
        ? await this.git.execGitRaw(['diff', '--name-status', '-z', '--find-renames', base.targetSha, snapshot.targetSha, '--'], root, 20000)
        : await this.git.execGitRaw(['diff-tree', '--root', '-r', '--name-status', '-z', '--no-commit-id', snapshot.targetSha, '--'], root, 20000);
      const wanted = request.paths ? new Set(request.paths) : undefined;
      const changedFiles = parseChangedFilesOutput(output)
        .filter(file => !wanted || wanted.has(file.path) || Boolean(file.oldPath && wanted.has(file.oldPath)));
      if (wanted && !changedFiles.length) {
        throw new Error(`Nothing to review: ${request.paths!.length === 1 ? request.paths![0] : 'the chosen files'} did not change here.`);
      }
      changedPaths = [...new Set(changedFiles.map(file => file.path))];
      for (const file of changedFiles) {
        if (file.oldPath) { oldPaths[file.path] = file.oldPath; }
      }
    }
    const selected = request.scope === 'changes' ? changedPaths : snapshot.tree.entries.map(entry => entry.path);
    const sorted = selected.sort((a, b) => {
      const priority = (path: string) => /^(\.github\/|\.repository-manager\/|package|pyproject|requirements|Cargo|Dockerfile)/i.test(path) ? 0 : 1;
      return priority(a) - priority(b) || a.localeCompare(b);
    });
    const skipped: ReviewCoverage['skipped'] = [];
    const groups = new Map<string, string[]>();
    // Binary files (images, archives) cannot be read as text. Git's own test finds them (the one
    // --numstat uses, which honours .gitattributes), in batches and only until the budget is full.
    const format = await this.git.execGit(['rev-parse', '--show-object-format'], root, 5000).catch(() => 'sha1');
    const emptyTree = EMPTY_TREE[format] || EMPTY_TREE.sha1;
    const binaryIn = async (paths: string[]): Promise<Set<string>> => {
      if (!paths.length) { return new Set(); }
      const output = await this.git.execGitRaw(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
        base ? base.targetSha : emptyTree, snapshot.targetSha, '--', ...paths.map(path => `:(literal)${path}`)], root, 30000);
      return binaryPathsFromNumstat(output);
    };
    // Constant-time lookups and a running count keep planning linear on large trees.
    let grouped = 0;
    for (let offset = 0; offset < sorted.length; offset += BINARY_CHECK_BATCH) {
      const batch: string[] = [];
      for (const path of sorted.slice(offset, offset + BINARY_CHECK_BATCH)) {
        const entry = snapshot.entry(path) || base?.entry(path);
        if (!entry || entry.type !== 'blob' || entry.mode === '120000') {
          skipped.push({ path, reason: 'gitlink, symlink or missing source blob' });
        } else if (isLockfile(path) && request.scope !== 'changes') {
          skipped.push({ path, reason: 'lockfile (reviewed only when it changes)' });
        } else if (grouped + batch.length >= MAX_REVIEW_FILES) {
          skipped.push({ path, reason: 'review file budget' });
        } else {
          batch.push(path);
        }
      }
      const binary = await binaryIn(batch);
      for (const path of batch) {
        if (binary.has(path)) {
          skipped.push({ path, reason: 'binary file' });
          continue;
        }
        const name = component(path);
        const paths = groups.get(name) || [];
        paths.push(path);
        groups.set(name, paths);
        grouped++;
      }
    }
    const units: ReviewWorkUnit[] = [];
    for (const [name, paths] of groups) {
      for (let offset = 0; offset < paths.length; offset += FILES_PER_BATCH) {
        const slice = paths.slice(offset, offset + FILES_PER_BATCH);
        units.push({ component: name, paths: slice,
          rules: policy.status === 'configured'
            ? policy.policy.rules.filter(rule => slice.some(path => appliesToPath(rule, path))) : [] });
      }
    }
    const normalized: ReviewRequest = { ...request, targetSha: snapshot.targetSha,
      baseSha: base?.targetSha, policyHash: policy.status === 'configured' ? policy.hash : undefined };
    const total = request.scope === 'changes' ? selected.length : snapshot.tree.totalEntries;
    const coverage: ReviewCoverage = { surveyed: total, analyzed: 0, skipped, failed: [],
      complete: !snapshot.tree.truncated && !base?.tree.truncated && !skipped.length };
    return { request: normalized, snapshot, base, policy, changedPaths, oldPaths, units, coverage };
  }
}
