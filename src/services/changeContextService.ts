import { listStashes, stashDiffTarget, stashInternals } from './stashTarget';
import { ChangeContextPacket } from '../types';
import { parseChangedFilesOutput } from './diffService';
import { GitCommandService } from './gitCommandService';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILES = 80;
export const MAX_PATCH_BYTES = 300000;
const MAX_FILE_BYTES = 300000;

export class ChangeContextService {
  constructor(private git: GitCommandService) {}

  async collect(repositoryPath: string, target: string, base?: string): Promise<ChangeContextPacket> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const targetSha = await this.git.resolveRevision(repositoryPath, target);
    const parents = await this.git.execGit(['rev-list', '--parents', '-n', '1', targetSha], cwd, 5000);
    const parent = parents.split(/\s+/)[1];
    const root = !base && !parent;
    const baseSha = base ? await this.git.resolveRevision(repositoryPath, base) : parent || EMPTY_TREE;
    // The summary is of the commit asked for (targetSha); a stash is read with its untracked files.
    const diffTarget = await stashDiffTarget(this.git, cwd, targetSha);
    const output = await this.git.execGitRaw(['diff', '--name-status', '-z', '--find-renames', baseSha, diffTarget, '--'], cwd, 10000);
    const allFiles = parseChangedFilesOutput(output);
    const files = allFiles.slice(0, MAX_FILES);
    const patches: ChangeContextPacket['patches'] = [];
    const omitted = allFiles.length > MAX_FILES ? [`${allFiles.length - MAX_FILES} changed files omitted from context (file limit)`] : [];
    let bytes = 0;
    for (const file of files) {
      if (bytes >= MAX_PATCH_BYTES) {
        omitted.push(`${file.path}: context limit`);
        continue;
      }
      try {
        const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
        const patch = await this.git.execGitRaw([
          'diff', '--no-ext-diff', '--no-textconv', '--binary', '--find-renames', '--unified=3',
          baseSha, diffTarget, '--', ...paths
        ], cwd, 12000);
        const size = Buffer.byteLength(patch, 'utf8');
        if (size > MAX_FILE_BYTES || bytes + size > MAX_PATCH_BYTES) {
          omitted.push(`${file.path}: patch exceeds budget`);
        } else if (/^Binary files |^GIT binary patch/m.test(patch)) {
          omitted.push(`${file.path}: binary content omitted`);
        } else if (!patch.trim()) {
          omitted.push(`${file.path}: patch unavailable`);
        } else {
          bytes += size;
          patches.push({ path: file.path, patch });
        }
      } catch {
        omitted.push(`${file.path}: patch unavailable`);
      }
    }
    const log = root
      ? `${targetSha}\x1f${await this.git.execGit(['show', '-s', '--format=%s', targetSha], cwd, 5000)}\0`
      : await this.git.execGitRaw(['log', '-z', '--format=%H%x1f%s', '-n', '21', `${baseSha}..${targetSha}`], cwd, 10000);
    // Git's index and untracked-files commits inside a stash are not commits to cite.
    const internal = stashInternals(await listStashes(this.git, cwd));
    const entries = log.split('\0').filter(Boolean)
      .filter(entry => !internal.has(entry.trim().split('\x1f')[0]));
    const commits = entries.slice(0, 20).map(entry => {
      const [hash, ...subject] = entry.trim().split('\x1f');
      return { hash, subject: subject.join('\x1f') };
    });
    return {
      repositoryPath: cwd, baseSha, targetSha, root, files, patches, commits,
      coverage: { totalFiles: allFiles.length, includedFiles: patches.length, omitted, truncatedCommits: entries.length > 20 }
    };
  }
}
