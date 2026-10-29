/**
 * The requirements that clarification items point at: found in RST and Markdown files under a
 * folder on this computer, or in the editor's own shallow, sparse copy of a Git repository.
 * Also the rules for images named in Visual aids. No `vscode` here, so tests run in Node.
 *
 * Ported from the Python dou-editor (server.py), with its rules and messages.
 */
/* eslint-disable @typescript-eslint/naming-convention -- file extensions, Git's environment, and the
   sync state's keys, which the editor page and the Python dou-editor read as they are */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DouError, EXPLICIT_ID, PY_SPACE, PY_WORD, codePoints, maskFences, nowIso, parse, pySplitLines, pyStrip } from './douDocument';

// REQ-012, FR-7, REQ-AUTH-3; not CLR-001-Q01 (the last segment must be digits).
export const REQUIREMENT_ID = '[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*[-_][0-9]+';
const RST_ADORNMENT = /^([=\-~^"'`*+#:.])\1{2,}\s*$/;
// An ID at the start of a title, then an optional ":", ".", "-", en or em dash.
const TITLE_ID = new RegExp(`^(${REQUIREMENT_ID})(?![${PY_WORD}-])[ \\t]*[:.\\-\\u2013\\u2014]?[ \\t]*([\\s\\S]*)`, 'u');
export const MAX_REQUIREMENT_FILES = 5000;
export const MAX_REQUIREMENT_BYTES = 2_000_000;
const MAX_EXCERPT = 20000; // long enough to check that accepted criteria were written in
// Raster images only: an SVG could run script.
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 10_000_000;
export const CONFIG_NAME = '.dou-editor.json';

/** (id, title, line, excerpt) */
export type RequirementEntry = [string, string, number, string];
export interface Requirement { id: string; title: string; file: string; line: number; excerpt: string }
export interface Catalog { configured: boolean; root?: string; requirements: Requirement[]; skipped?: string[]; truncated?: boolean; web?: string | null }

/** At most MAX_EXCERPT code points, as Python slices a str. */
const excerpt = (text: string) => (text.length > MAX_EXCERPT ? Array.from(text).slice(0, MAX_EXCERPT).join('') : text);
const rstrip = (text: string) => text.replace(new RegExp(`[${PY_SPACE}]+$`), '');
const lstrip = (text: string) => text.replace(new RegExp(`^[${PY_SPACE}]+`), '');

/**
 * Requirements defined in one Markdown or reStructuredText file. Markdown: front matter
 * `id:`/`title:`, or headings starting with an ID (`## REQ-012: Send messages`). RST: section
 * titles starting with an ID, reference labels above a title, or directives with an `:id:`
 * option as sphinx-needs writes them (`.. req:: Title`).
 */
export function requirementsIn(content: string, suffix = '.md'): RequirementEntry[] {
  if (suffix.toLowerCase() === '.rst') { return rstRequirements(content); }
  const found: RequirementEntry[] = [];
  const meta = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (meta) {
    const ident = new RegExp(`(?<![^\\n])id:[ \\t]*["']?(${REQUIREMENT_ID})["']?[ \\t]*\\r?(?=\\n|$)`).exec(meta[1]);
    if (ident) {
      const title = /(?<![^\n])title:[ \t]*([^\n]+?)[ \t]*\r?(?=\n|$)/.exec(meta[1]);
      found.push([ident[1], title ? title[1].replace(/^["']+|["']+$/g, '') : '', 1, excerpt(pyStrip(content.slice(meta[0].length)))]);
    }
  }
  const scanned = maskFences(content);
  const headings: Array<{ index: number; end: number; level: number; text: string }> = [];
  const pattern = /(?<![^\n])(#{1,6})[ \t]+([^\n]*?)[ \t#]*\r?(?=\n|$)/g;
  for (let match = pattern.exec(scanned); match; match = pattern.exec(scanned)) {
    headings.push({ index: match.index, end: match.index + match[0].length, level: match[1].length, text: match[2] });
    if (!match[0]) { pattern.lastIndex++; }
  }
  headings.forEach((heading, i) => {
    const match = TITLE_ID.exec(heading.text);
    if (!match) { return; }
    const next = headings.slice(i + 1).find(h => h.level <= heading.level);
    const line = content.slice(0, heading.index).split('\n').length;
    found.push([match[1], pyStrip(match[2]), line, excerpt(pyStrip(content.slice(heading.end, next ? next.index : content.length)))]);
  });
  return found;
}

function rstRequirements(content: string): RequirementEntry[] {
  const lines = pySplitLines(content);
  const found: RequirementEntry[] = [];
  // Section titles: a text line underlined (and optionally overlined) by one repeated punctuation
  // character. Levels follow the order styles first appear, as in docutils.
  const sections: Array<[number, number, string]> = [];
  const styles: string[] = [];
  let i = 0;
  while (i < lines.length - 1) {
    const title = rstrip(lines[i]), under = lines[i + 1];
    const mark = RST_ADORNMENT.exec(under);
    // Like docutils: a short underline still makes a title as long as it has at least 4 characters.
    const longEnough = codePoints(rstrip(under)) >= Math.min(codePoints(pyStrip(title)), 4);
    if (pyStrip(title) && !RST_ADORNMENT.test(title) && mark && longEnough && !title.startsWith(' ')) {
      const over = i > 0 && rstrip(lines[i - 1]) === rstrip(under);
      const style = mark[1] + (over ? '/over' : '');
      if (!styles.includes(style)) { styles.push(style); }
      sections.push([i, styles.indexOf(style), pyStrip(title)]);
      i += 2;
      continue;
    }
    i++;
  }
  const overline = (at: number) => (at > 0 && RST_ADORNMENT.test(lines[at - 1]) ? 1 : 0);
  sections.forEach(([at, level, heading], n) => {
    let ident: string, title = heading;
    const match = TITLE_ID.exec(heading);
    if (match) {
      ident = match[1];
      title = pyStrip(match[2]);
    } else {
      // Plain Sphinx: a reference label right above the title, ".. _REQ-012:".
      let above = at - overline(at) - 1;
      while (above >= 0 && !pyStrip(lines[above])) { above--; }
      const label = above >= 0 ? new RegExp(`^\\.\\.\\s+_(${EXPLICIT_ID}):\\s*$`).exec(lines[above]) : null;
      if (!label) { return; }
      ident = label[1];
    }
    const next = sections.slice(n + 1).find(s => s[1] <= level);
    const stop = next ? next[0] - overline(next[0]) : lines.length;
    // Drop a reference label that belongs to the next section.
    const body = lines.slice(at + 2, stop);
    while (body.length && (!pyStrip(body[body.length - 1]) || new RegExp(`^\\.\\.\\s+_[${PY_WORD}-]+:\\s*$`, 'u').test(body[body.length - 1]))) { body.pop(); }
    found.push([ident, title, at + 1, excerpt(pyStrip(body.join('\n')))]);
  });
  // sphinx-needs style directives: ".. req:: Title" followed by ":id: REQ_001".
  lines.forEach((line, at) => {
    const directive = new RegExp(`^(\\s*)\\.\\.\\s+[${PY_WORD}-]+::\\s*(.*)$`, 'u').exec(line);
    if (!directive) { return; }
    const indent = directive[1].length;
    const body: string[] = [];
    let ident: string | null = null;
    for (const following of lines.slice(at + 1)) {
      if (pyStrip(following) && following.length - lstrip(following).length <= indent) { break; }
      const option = new RegExp(`^\\s*:id:\\s*(${EXPLICIT_ID})\\s*$`).exec(following);
      if (option && ident === null && !body.length) {
        ident = option[1];
      } else if (!(new RegExp(`^\\s*:[${PY_WORD}-]+:`, 'u').test(following) && !body.length)) {
        body.push(pyStrip(following));
      }
    }
    if (ident) { found.push([ident, pyStrip(directive[2]), at + 1, excerpt(pyStrip(body.join('\n')))]); }
  });
  return found;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** UTF-8 text exactly as Python's bytes.decode('utf-8') gives it: invalid bytes fail, a BOM stays. */
export const decodeUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

/** Files under a folder in os.walk's order: a folder's own files, then each subfolder in turn. */
async function walk(folder: string, into: string[]): Promise<void> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const files: string[] = [], folders: string[] = [];
  for (const entry of entries) {
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      // os.walk lists a link by what it points to, and does not follow one to a folder.
      isDirectory = await fs.stat(path.join(folder, entry.name)).then(s => s.isDirectory(), () => false);
      if (isDirectory) { continue; }
    }
    (isDirectory ? folders : files).push(entry.name);
  }
  const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const name of files.sort(byCodePoint)) {
    if (/\.(md|rst)$/i.test(name)) { into.push(path.join(folder, name)); }
  }
  for (const name of folders.filter(f => !f.startsWith('.') && f !== 'node_modules').sort(byCodePoint)) {
    await walk(path.join(folder, name), into);
  }
}

const posix = (relative: string) => relative.split(path.sep).join('/');

/**
 * Scan RST and Markdown under root (no symlinks, hidden folders or node_modules). File names are
 * shown relative to base (default: root's parent). Clarification files are not requirements.
 */
export async function requirementCatalog(root: string, base = path.dirname(root)): Promise<Catalog> {
  const paths: string[] = [];
  const stat = await fs.stat(root).catch(() => undefined);
  if (stat?.isFile()) { paths.push(root); }
  if (stat?.isDirectory()) { await walk(root, paths); }
  const requirements: Requirement[] = [], skipped: string[] = [];
  for (const candidate of paths.slice(0, MAX_REQUIREMENT_FILES)) {
    const name = posix(path.relative(base, candidate));
    let content: string;
    try {
      const info = await fs.lstat(candidate);
      if (info.isSymbolicLink() || info.size > MAX_REQUIREMENT_BYTES) {
        skipped.push(name);
        continue;
      }
      content = decodeUtf8(await fs.readFile(candidate));
    } catch {
      skipped.push(name);
      continue;
    }
    const suffix = path.extname(candidate);
    if (suffix.toLowerCase() === '.md') {
      try {
        parse(content);
        continue; // a clarification artifact, not a requirement
      } catch { /* a requirement file */ }
    }
    for (const [id, title, line, text] of requirementsIn(content, suffix)) {
      requirements.push({ id, title, file: name, line, excerpt: text });
    }
  }
  return { configured: true, root: path.basename(root), requirements, skipped, truncated: paths.length > MAX_REQUIREMENT_FILES };
}

/** Nearest folder holding .git, else the folder itself. */
export async function repositoryRoot(start: string): Promise<string> {
  for (let folder = start; ; folder = path.dirname(folder)) {
    if (await fs.lstat(path.join(folder, '.git')).then(() => true, () => false)) { return folder; }
    if (path.dirname(folder) === folder) { return start; }
  }
}

export class AssetError extends Error {
  constructor(message: string, readonly status: 403 | 404) { super(message); }
}

/** An image path written in Visual aids, confined to the document's repository. */
export async function visualAid(document: string, relative: string): Promise<{ data: Buffer; kind: string }> {
  if (!relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\0')) {
    throw new AssetError('Use a path relative to the Markdown file.', 403);
  }
  const folder = path.dirname(document);
  const root = await fs.realpath(await repositoryRoot(folder));
  const lexical = path.resolve(folder, relative);
  // Resolving links also catches a symlink that points outside.
  const target = await fs.realpath(lexical).catch(() => lexical);
  const inside = path.relative(root, target);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new AssetError('Only files inside the repository can be previewed.', 403);
  }
  const kind = IMAGE_TYPES[path.extname(target).toLowerCase()];
  if (!kind) { throw new AssetError('Only PNG, JPEG, GIF and WebP images can be previewed.', 403); }
  const info = await fs.stat(target).catch(() => undefined);
  if (!info?.isFile()) { throw new AssetError('Image not found: ' + relative, 404); }
  if (info.size > MAX_IMAGE_BYTES) { throw new AssetError('Image is larger than 10 MB.', 403); }
  return { data: await fs.readFile(target), kind };
}

export type SourceSetting = { kind: 'none' } | { kind: 'folder'; folder: string } | { kind: 'git'; repo: string; ref: string; path: string };

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/ -]*$/;

/** A requirements source from the editor or the config file, checked. */
export function checkSource(source: unknown): SourceSetting {
  const value = source as Record<string, unknown> | null;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !['git', 'folder', 'none'].includes(value.kind as string)) {
    throw new DouError('Requirements source kind must be git, folder or none.');
  }
  if (value.kind === 'none') { return { kind: 'none' }; }
  if (value.kind === 'folder') {
    const folder = pyStrip(String(value.folder ?? ''));
    if (!folder || folder.includes('\0')) { throw new DouError('Enter the folder that holds the requirement files.'); }
    return { kind: 'folder', folder };
  }
  const repo = pyStrip(String(value.repo ?? ''));
  const ref = pyStrip(String(value.ref || 'main'));
  const folder = pyStrip(String(value.path || '.')).replace(/^\/+|\/+$/g, '') || '.';
  const userInfo = /^https?:\/\/([^/?#]*)@/i.exec(repo);
  if (userInfo && userInfo[1]) {
    // Credentials stay in Git's credential manager; a URL is shown and saved.
    throw new DouError('Do not put a user name or token in the URL; Git uses your saved login.');
  }
  if (!(/^(https?|ssh|file):\/\/\S+$/.test(repo) || new RegExp(`^[${PY_WORD}.-]+@[${PY_WORD}.-]+:\\S+$`, 'u').test(repo))) {
    throw new DouError('Repository URL must look like https://host/org/repo.git or git@host:org/repo.git.');
  }
  if (!SAFE_REF.test(ref) || ref.includes('..')) { throw new DouError('Branch or tag may contain letters, digits, ".", "_", "-" and "/".'); }
  if (folder !== '.' && (!SAFE_PATH.test(folder) || folder.split('/').includes('..'))) {
    throw new DouError('Folder must be a path inside the repository, such as docs/source.');
  }
  return { kind: 'git', repo, ref, path: folder };
}

/** Browser link prefix for files at a commit, for GitHub-style hosts. */
export function webBase(repo: string, commit?: string): string | null {
  const match = /^https:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(repo) || /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(repo);
  return match && commit ? `https://${match[1]}/${match[2]}/blob/${commit}/` : null;
}

/**
 * Run the git on this computer, so it signs in the way it always does (credential manager, SSH
 * agent, proxy settings). It fails rather than waiting for a prompt.
 */
export function git(args: string[], cwd?: string): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') { reject(new Error('git is not installed or not on PATH.')); return; }
      if (error.killed) { reject(new Error('git did not finish within 3 minutes (network or proxy?).')); return; }
      const output = (stderr || stdout).trim();
      reject(new Error(output ? output.split(/\r?\n/).pop() as string : `git ${args[0]} failed.`));
    });
  });
}

export interface SyncState { state: 'idle' | 'syncing' | 'ok' | 'error'; error?: string | null; commit?: string; committed_at?: string; subject?: string; synced_at?: string }

/** Commit of the editor's copy, or nothing when there is no usable copy yet. */
async function cachedCommit(cache: string): Promise<Partial<SyncState>> {
  if (!await fs.lstat(path.join(cache, '.git')).then(() => true, () => false)) { return {}; }
  try {
    const [commit, committedAt, subject] = (await git(['log', '-1', '--format=%H%x1f%cI%x1f%s'], cache)).trim().split('\x1f');
    if (subject === undefined) { return {}; }
    return { commit, committed_at: committedAt, subject };
  } catch {
    return {};
  }
}

const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/**
 * Where requirements come from: nothing, a local folder, or a Git repository the editor keeps a
 * shallow, sparse copy of in its own storage. The choice is saved in `.dou-editor.json` at the
 * repository root, which the Python dou-editor reads too.
 */
export class RequirementSource {
  private source: SourceSetting = { kind: 'none' };
  private state: SyncState = { state: 'idle' };
  private running?: Promise<void>;
  private readonly loaded: Promise<void>;

  constructor(readonly configFile: string, private readonly cacheRoot: string) {
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.configFile, 'utf8');
    } catch {
      return;
    }
    try {
      const config = JSON.parse(text);
      this.source = checkSource(isRecord(config) && 'requirements' in config ? config.requirements : { kind: 'none' });
    } catch (error) {
      this.state = { state: 'error', error: `${path.basename(this.configFile)}: ${(error as Error).message}` };
    }
  }

  cacheFolder(repo: string): string {
    return path.join(this.cacheRoot, createHash('sha256').update(repo, 'utf8').digest('hex').slice(0, 16));
  }

  /** Save a new source in the config file (other keys kept) and start syncing it. */
  async save(source: unknown): Promise<void> {
    await this.loaded;
    const checked = checkSource(source);
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
      if (isRecord(parsed)) { config = parsed; }
    } catch { /* a new or unreadable file is replaced */ }
    config.requirements = checked;
    const temporary = `${this.configFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', 'utf8');
    await fs.rename(temporary, this.configFile);
    this.source = checked;
    this.state = { state: 'idle' };
    this.sync();
  }

  /** Folder to scan, and the base that file names are shown relative to. */
  folder(): { folder: string; base: string } | undefined {
    if (this.source.kind === 'folder') {
      const folder = path.resolve(path.dirname(this.configFile), this.source.folder);
      return { folder, base: path.dirname(folder) };
    }
    if (this.source.kind === 'git') {
      const cache = this.cacheFolder(this.source.repo);
      return { folder: path.join(cache, this.source.path), base: cache };
    }
    return undefined;
  }

  /** Fetch the configured ref in the background; the editor polls `describe`. */
  sync(): Promise<void> {
    if (this.source.kind !== 'git' || this.state.state === 'syncing') { return this.running || Promise.resolve(); }
    this.state = { ...this.state, state: 'syncing', error: null };
    const source = this.source;
    this.running = this.runSync(source).finally(() => { this.running = undefined; });
    return this.running;
  }

  /** Starts the first sync once the config file is read. */
  async start(): Promise<void> {
    await this.loaded;
    void this.sync();
  }

  private async runSync(source: Extract<SourceSetting, { kind: 'git' }>): Promise<void> {
    const cache = this.cacheFolder(source.repo);
    let result: SyncState;
    try {
      if (!await exists(path.join(cache, '.git'))) {
        await fs.mkdir(path.dirname(cache), { recursive: true });
        await fs.rm(cache, { recursive: true, force: true }); // a clone that failed halfway
        await git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', source.ref, '--', source.repo, cache]);
      } else {
        await git(['fetch', '--depth', '1', 'origin', source.ref], cache);
        await git(['reset', '--hard', 'FETCH_HEAD'], cache); // the editor's own copy, never a user clone
      }
      await git(['sparse-checkout', 'set', '--no-cone', source.path === '.' ? '/*' : `/${source.path}/`], cache);
      result = { state: 'ok', ...await cachedCommit(cache), synced_at: nowIso(), error: null };
    } catch (error) {
      // Keep using an earlier copy if there is one, and say which commit it is.
      result = { ...this.state, ...await cachedCommit(cache), state: 'error', error: (error as Error).message };
    }
    if (source === this.source) { this.state = result; } // ignore a sync for a source replaced meanwhile
  }

  /** The source, its sync state and, when there is something to read, the catalog. */
  async describe(): Promise<Catalog & { source: SourceSetting & { from: string }; sync: SyncState }> {
    await this.loaded;
    const source = this.source, state = { ...this.state };
    const location = this.folder();
    const info = { source: { ...source, from: CONFIG_NAME }, sync: state };
    const empty = { configured: false, requirements: [] as Requirement[] };
    if (!location) { return { ...empty, ...info }; }
    const found = await exists(location.folder);
    if (source.kind === 'git' && !state.commit && !found) { return { ...empty, ...info }; }
    if (!found) {
      return { ...empty, ...info, sync: { ...state, state: 'error', error: state.error || `Folder not found: ${location.folder}` } };
    }
    const catalog = await requirementCatalog(location.folder, location.base);
    if (source.kind === 'git') {
      catalog.web = webBase(source.repo, state.commit);
      catalog.root = source.path !== '.' ? source.path : source.repo.replace(/\/+$/, '').split('/').pop();
    }
    return { ...catalog, ...info };
  }

  /** A file named in the catalog, if it lies inside the scanned folder's base (to open it). */
  locate(file: string): string | undefined {
    const location = this.folder();
    if (!location || typeof file !== 'string') { return undefined; }
    const target = path.resolve(location.base, file);
    const inside = path.relative(location.base, target);
    return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? target : undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
