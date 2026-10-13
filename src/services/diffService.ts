/**
 * Commit metadata and patch service. Large patches are capped for webview safety.
 */

import { ChangedFileInfo, ChangedFileStatus, CommitDetail, FileDiff } from '../types';
import { GitCommandService } from './gitCommandService';
import { findStash, stashDiffTarget } from './stashTarget';
import { parseDecorations } from './historyService';

const FIELD_SEPARATOR = '\x1f';
const DETAIL_FORMAT = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%cn',
  '%ce',
  '%cI',
  '%s',
  '%D',
  '%B'
].join('%x1f');
const MAX_PATCH_LENGTH = 1024 * 1024;

function mapStatus(code: string): ChangedFileStatus {
  switch (code.charAt(0)) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type-changed';
    case 'U': return 'unmerged';
    default: return 'unknown';
  }
}

export function parseChangedFilesOutput(output: string): ChangedFileInfo[] {
  const tokens = output.split('\0');
  const files: ChangedFileInfo[] = [];
  let index = 0;

  while (index < tokens.length) {
    const code = tokens[index++];
    if (!code) {
      continue;
    }

    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (oldPath && newPath) {
        files.push({ oldPath, path: newPath, status: mapStatus(code) });
      }
      continue;
    }

    const filePath = tokens[index++];
    if (filePath) {
      files.push({ path: filePath, status: mapStatus(code) });
    }
  }

  return files;
}

export class DiffService {
  constructor(private gitCmd: GitCommandService) {}

  async getCommitDetail(repositoryPath: string, revision: string, baseRevision?: string): Promise<CommitDetail> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const commitHash = await this.gitCmd.resolveRevision(repositoryPath, revision);
    const metadata = await this.gitCmd.execGitRaw(
      ['show', '-s', `--format=${DETAIL_FORMAT}`, commitHash], repositoryRoot, 10000
    );

    const fields = metadata.split(FIELD_SEPARATOR);
    if (fields.length < 12) {
      throw new Error('Unexpected Git commit detail record');
    }
    const [
      hash, shortHash, parents, authorName, authorEmail, authoredAt,
      committerName, committerEmail, committedAt, subject, decorations, ...bodyParts
    ] = fields;
    const parentHashes = parents ? parents.split(' ').filter(Boolean) : [];
    const comparisonBaseHash = baseRevision
      ? await this.gitCmd.resolveRevision(repositoryPath, baseRevision)
      : parentHashes[0] || null;
    const comparisonMode: CommitDetail['comparisonMode'] = baseRevision
      ? 'range'
      : comparisonBaseHash
        ? 'parent'
        : 'root';
    // A stash made with untracked files is read with them (see stashTarget).
    const stash = await findStash(this.gitCmd, repositoryRoot, commitHash);
    const diffTarget = await stashDiffTarget(this.gitCmd, repositoryRoot, commitHash);
    const changedFiles = comparisonBaseHash
      ? await this.gitCmd.execGitRaw([
        'diff', '--name-status', '-z', '--find-renames', comparisonBaseHash, diffTarget, '--'
      ], repositoryRoot, 10000)
      : await this.gitCmd.execGitRaw([
        'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--find-renames', commitHash, '--'
      ], repositoryRoot, 10000);

    return {
      hash,
      shortHash,
      parentHashes,
      authorName,
      authorEmail,
      authoredAt,
      committerName,
      committerEmail,
      committedAt,
      subject,
      refs: parseDecorations(decorations),
      body: bodyParts.join(FIELD_SEPARATOR).trim(),
      comparisonBaseHash,
      comparisonMode,
      files: parseChangedFilesOutput(changedFiles),
      ...(stash ? { stash: { ref: stash.ref, branch: stash.branch, message: stash.message } } : {})
    };
  }

  async getFileDiff(repositoryPath: string, revision: string, filePath: string, baseRevision?: string): Promise<FileDiff> {
    const repositoryRoot = this.gitCmd.resolveRepositoryPath(repositoryPath);
    const commitHash = await this.gitCmd.resolveRevision(repositoryPath, revision);
    const safePath = this.gitCmd.resolveFilePath(filePath);
    let baseCommitHash: string | null;
    if (baseRevision) {
      baseCommitHash = await this.gitCmd.resolveRevision(repositoryPath, baseRevision);
    } else {
      const ancestry = await this.gitCmd.execGit(
        ['rev-list', '--parents', '--max-count=1', commitHash], repositoryRoot, 5000
      );
      baseCommitHash = ancestry.split(/\s+/).slice(1)[0] || null;
    }
    const diffTarget = await stashDiffTarget(this.gitCmd, repositoryRoot, commitHash);
    const output = baseCommitHash
      ? await this.gitCmd.execGitRaw([
        'diff', '--no-ext-diff', '--find-renames', '--unified=80', baseCommitHash, diffTarget, '--', safePath
      ], repositoryRoot, 15000)
      : await this.gitCmd.execGitRaw([
        'show', '--format=', '--no-ext-diff', '--find-renames', '--unified=80', commitHash, '--', safePath
      ], repositoryRoot, 15000);
    const truncated = output.length > MAX_PATCH_LENGTH;

    return {
      repositoryPath,
      commitHash,
      baseCommitHash,
      path: safePath,
      patch: truncated ? output.slice(0, MAX_PATCH_LENGTH) : output,
      truncated
    };
  }
}
