/**
 * Read-only commit history service used by the dashboard.
 */

import { GitCommandService } from './gitCommandService';

/** The search scanning each repository: a newer history request stops it (typing a query). */
const activeSearches = new Map<string, AbortController>();
import { GitRefLabel, GitRefKind, HistoryCommit, HistoryPage, HistoryQuery } from '../types';
import { SNAPSHOT_REF_PREFIX } from './localChangesSnapshot';
import { DISCARD_REF_PREFIX } from './discardService';
import { hideStashInternals, listStashes } from './stashTarget';

const FIELD_SEPARATOR = '\x1f';
const RECORD_SEPARATOR = '\x1e';
const HISTORY_FORMAT = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%s',
  '%D'
].join('%x1f') + '%x1e';

function classifyRef(name: string): { name: string; kind: GitRefKind; isCurrent?: boolean } {
  const trimmed = name.trim();
  if (trimmed.startsWith('HEAD -> ')) {
    return { name: trimmed.slice('HEAD -> '.length).replace(/^refs\/heads\//, ''), kind: 'head', isCurrent: true };
  }
  if (trimmed.startsWith('tag: ')) {
    return { name: trimmed.slice('tag: '.length).replace(/^refs\/tags\//, ''), kind: 'tag' };
  }
  if (trimmed.startsWith('refs/heads/')) {
    return { name: trimmed.slice('refs/heads/'.length), kind: 'local-branch' };
  }
  if (trimmed.startsWith('refs/remotes/')) {
    return { name: trimmed.slice('refs/remotes/'.length), kind: 'remote-branch' };
  }
  return { name: trimmed, kind: 'other' };
}

export function parseDecorations(value: string): GitRefLabel[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(classifyRef);
}

export function parseHistoryOutput(output: string): HistoryCommit[] {
  return output
    .split(RECORD_SEPARATOR)
    .map(record => record.replace(/^\s+|\s+$/g, ''))
    .filter(Boolean)
    .map(record => {
      const fields = record.split(FIELD_SEPARATOR);
      if (fields.length < 8) {
        throw new Error('Unexpected Git history record');
      }
      const [hash, shortHash, parents, authorName, authorEmail, authoredAt, subject, decorations] = fields;
      return {
        hash,
        shortHash,
        parentHashes: parents ? parents.split(' ').filter(Boolean) : [],
        authorName,
        authorEmail,
        authoredAt,
        subject,
        refs: parseDecorations(decorations)
      };
    });
}

/** What a history search looks in: hashes, author, subject and ref names, ignoring case. */
function matchesSearch(commit: HistoryCommit, search: string): boolean {
  return [commit.hash, commit.shortHash, commit.authorName, commit.authorEmail, commit.subject, ...commit.refs.map(ref => ref.name)]
    .join('\n').toLowerCase().includes(search);
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

export class HistoryService {
  constructor(private gitCmd: GitCommandService) {}

  async getHistory(query: HistoryQuery): Promise<HistoryPage> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(query.repositoryPath);
    const limit = clamp(query.limit, 100, 1, 200);
    const offset = clamp(query.offset, 0, 0, 100000);
    const search = query.search?.trim().toLowerCase() || '';
    const args = search
      // A search reads the whole history (topological, like the graph, so no parent precedes its
      // child) and stops as soon as it has this page and one more match.
      ? ['log', '--topo-order', '--date=iso-strict', '--decorate=full', `--format=${HISTORY_FORMAT}`]
      : ['log', `--max-count=${limit + 1}`, '--topo-order', '--date=iso-strict', '--decorate=full', `--format=${HISTORY_FORMAT}`];

    if (!search && offset > 0) {
      args.push(`--skip=${offset}`);
    }

    // A page of history is read with its upstream and stashes: looked up while the log runs, not
    // after it, since each is a Git process of its own and on a slow machine (Windows, a virus
    // scanner) every process waited for adds its whole start-up time. A search starts them only
    // once its scan is done: typing replaces searches, and a replaced one needs neither.
    // The configured upstream, not a same-named guess: `work` may track `upstream/release`.
    // A detached HEAD or a branch without one has none. Neither lookup rejects (each falls back to
    // none), so a failing log leaves nothing unhandled.
    const lookUp = () => Promise.all([
      this.gitCmd.execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repositoryRoot, 5000).catch(() => ''),
      listStashes(this.gitCmd, repositoryRoot)
    ]);
    const lookups = search ? undefined : lookUp();

    let tip: string | undefined;
    if (query.branch) {
      tip = await this.gitCmd.resolveRevision(query.repositoryPath, query.branch);
      args.push(tip);
    } else if (query.includeRemotes) {
      // Every ref but the review snapshots and the copies Discard keeps, which are not history.
      args.push(`--exclude=${SNAPSHOT_REF_PREFIX}*`, `--exclude=${DISCARD_REF_PREFIX}*`, '--all');
    } else {
      args.push('HEAD');
    }

    let commits: HistoryCommit[];
    // Any new history request for this repository replaces a search still scanning it.
    activeSearches.get(repositoryRoot)?.abort();
    activeSearches.delete(repositoryRoot);
    if (search) {
      const matches: HistoryCommit[] = [];
      const wanted = offset + limit + 1;
      const controller = new AbortController();
      activeSearches.set(repositoryRoot, controller);
      try {
        await this.gitCmd.scanGitRecords(args, repositoryRoot, RECORD_SEPARATOR, record => {
          // A subject containing the record separator splits its commit into malformed pieces: skip
          // those rather than failing the search.
          let parsed: HistoryCommit[] = [];
          try { parsed = parseHistoryOutput(record); } catch { return false; }
          const [commit] = parsed;
          if (commit && matchesSearch(commit, search)) { matches.push(commit); }
          return matches.length >= wanted;
        }, 30000, controller.signal);
      } finally {
        if (activeSearches.get(repositoryRoot) === controller) { activeSearches.delete(repositoryRoot); }
      }
      commits = matches.slice(offset);
    } else {
      commits = parseHistoryOutput(await this.gitCmd.execGitRaw(args, repositoryRoot, 15000));
    }

    const hasMore = commits.length > limit;
    const [upstreamName, stashes] = await (lookups || lookUp());
    const upstream = upstreamName.trim() || null;
    return {
      repositoryPath: query.repositoryPath,
      offset,
      // Git's index and untracked-files commits inside a stash are not history.
      commits: hideStashInternals(commits.slice(0, limit), stashes, tip),
      nextOffset: hasMore ? offset + limit : null,
      upstream
    };
  }
}
