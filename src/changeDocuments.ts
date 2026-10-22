/**
 * Changed files in VS Code's own diff editor, in an editor tab: an uncommitted file as HEAD ↔ the
 * file on disk (which stays editable), or a commit's file as base ↔ target.
 *
 * The committed side is a read-only document of CHANGE_DOCUMENT_SCHEME. Its URI names the
 * repository, the commit by its full hash and the path, so the same URI always holds the same text
 * and a tab VS Code restores after a reload still shows it. An empty ref stands for "no file" (an
 * added file's left side, a deleted file's right side). Only full hashes and repositories inside an
 * open workspace folder are read, so a URI made up elsewhere cannot run Git anywhere else.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { existsSync, statSync } from 'fs';
import { GitCommandService } from './services/gitCommandService';
import { WorkingTreeChange } from './types';

export const CHANGE_DOCUMENT_SCHEME = 'repository-manager-git';
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Larger committed files are not shown: the editor would struggle, and the dashboard caps patches too. */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** `filePath` as committed at `ref` in the repository at `root`; '' as ref for an empty side. */
export function changeDocumentUri(root: string, ref: string, filePath: string): vscode.Uri {
  // The path keeps the file name and extension, so the tab and the language follow the file.
  return vscode.Uri.from({ scheme: CHANGE_DOCUMENT_SCHEME, path: `/${filePath}`, query: JSON.stringify({ root, ref, path: filePath }) });
}

/** Whether `fsPath` is a workspace folder or inside one. */
export function isInWorkspace(fsPath: string, folders: readonly string[]): boolean {
  return folders.some(folder => {
    const relative = path.relative(path.resolve(folder), path.resolve(fsPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export class ChangeDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly workspaceFolders: () => readonly string[]) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let query: { root?: unknown; ref?: unknown; path?: unknown };
    try { query = JSON.parse(uri.query); } catch { return ''; }
    const { root, ref, path: filePath } = query || {};
    if (typeof root !== 'string' || typeof ref !== 'string' || typeof filePath !== 'string') { return ''; }
    if (!FULL_SHA.test(ref) || !isInWorkspace(root, this.workspaceFolders())) { return ''; }
    const git = new GitCommandService(root);
    let file: string;
    try { file = git.resolveFilePath(filePath); } catch { return ''; }
    // Absent at that commit (added or deleted there): an empty side.
    const size = Number(await git.execGit(['cat-file', '-s', `${ref}:${file}`], root, 10000).catch(() => '0'));
    if (!size) { return ''; }
    if (size > MAX_DOCUMENT_BYTES) { return `(${file} is ${Math.round(size / 1024 / 1024)} MB at ${ref.slice(0, 8)}: too large to show here.)`; }
    const content = await git.execGitRaw(['show', `${ref}:${file}`], root, 15000).catch(() => '');
    return content.includes('\0') ? `(${file} is a binary file at ${ref.slice(0, 8)}.)` : content;
  }
}

export interface OpenWorkingChange { root: string; head: string; change: WorkingTreeChange }
export interface OpenCommitChange { root: string; base: string; target: string; path: string; oldPath?: string }

const short = (sha: string) => sha.slice(0, 7);

/**
 * An uncommitted file: HEAD ↔ the file on disk. A new or conflicted file opens as it is (VS Code
 * shows a conflict's markers itself), and a folder (a linked or nested repository) is revealed.
 */
export async function openWorkingChange({ root, head, change }: OpenWorkingChange): Promise<void> {
  const absolute = path.join(root, change.path);
  const onDisk = existsSync(absolute);
  if (onDisk && statSync(absolute).isDirectory()) {
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(absolute));
    return;
  }
  if (onDisk && (change.untracked || change.conflicted)) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolute), { preview: true });
    return;
  }
  const before = change.originalPath || change.path;
  const left = changeDocumentUri(root, head, before);
  const right = onDisk ? vscode.Uri.file(absolute) : changeDocumentUri(root, '', change.path);
  const name = path.basename(change.path);
  const title = change.originalPath ? `${path.basename(change.originalPath)} → ${name} (HEAD ↔ Working Tree)`
    : onDisk ? `${name} (HEAD ↔ Working Tree)` : `${name} (Deleted)`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

/** A file of a commit or comparison: base ↔ target, both read-only. */
export async function openCommitChange({ root, base, target, path: filePath, oldPath }: OpenCommitChange): Promise<void> {
  const left = changeDocumentUri(root, base, oldPath || filePath);
  const right = changeDocumentUri(root, target, filePath);
  const name = path.basename(filePath);
  const title = `${oldPath && oldPath !== filePath ? `${path.basename(oldPath)} → ` : ''}${name} (${base ? short(base) : 'empty'} ↔ ${short(target)})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}
