/**
 * Files and folders attached to a Studio Chat (plan 7, docs/plans/plan-7-studio-chat-attached-files.md):
 * the host-side checks of every entry, reading what the editor shows at each send, fitting it to the
 * drafting model's input limit (in full, as a summary, as an outline) and keeping the folder maps up to
 * date. No `vscode` here: the editor's text, Git's ignore check and the model arrive as functions.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MAX_FILE_BYTES } from '../agent/agentTools';
import {
  indexText, insideMaps, listFolder, ListedFile, MapEntry, MAX_READ_BYTES, mapPathOf,
  normalizeSummary, outline, parseMap, readListed, readMapFile, renderMap, summaryPrompt, updateEntries, withSummary, writeMapFile
} from './folderMap';
import type { CancelSignal } from './steps';

export const MAX_ATTACHMENTS = 10;
const MAX_SUMMARIES_PER_SEND = 3;
const MIN_BUDGET = 60_000;
const MAX_BUDGET = 300_000;
const MAX_FILE_OUTCOMES = 200;

export interface Attachment { path: string; kind: 'file' | 'folder'; ignored?: boolean }

/** How a file went to the planner. */
export type Form = 'full' | 'summary' | 'outline' | 'not sent';

export interface FileOutcome { path: string; outcome: Form; reason?: string }

export interface PreparedItem {
  path: string;
  kind: 'file' | 'folder';
  ignored: boolean;
  /** The whole chip was not sent: why (it was deleted, became binary, resolves outside the workspace…). */
  notSent?: string;
  files: FileOutcome[];
  /** Files past MAX_FILE_OUTCOMES, not listed one by one. */
  moreFiles: number;
  sent: { full: number; summary: number; outline: number; notSent: number };
  map?: string;
  mapNotSaved?: boolean;
}

export interface Prepared {
  /** The finished text for the planner's prompt; empty when nothing is sent. */
  text: string;
  items: PreparedItem[];
  /** What the person should hear about (a map that was not saved…). */
  notes: string[];
}

export interface PrepareDeps {
  root: string;
  /** The text an open editor holds, unsaved edits included; undefined when the file is not open. */
  openText(absolute: string): string | undefined;
  isDirty(absolute: string): boolean;
  /** Whether Git ignores the path (relative to the workspace). */
  ignored(relative: string): Promise<boolean>;
  /** One prompt in, the reply text out (the conversation's drafting model); absent when none can answer. */
  complete?: (prompt: string) => Promise<string>;
  signal: CancelSignal;
  /** The drafting model's `maxInputTokens`, when known. */
  inputLimit?: number;
  progress?: (text: string) => void;
  /** `YYYY-MM-DD`, for the summaries' dates. */
  today?: string;
}

/** Characters of attached content one send may carry: 40% of the model's input in tokens, 3 characters each, between 60,000 and 300,000. */
export function budgetFor(inputLimit?: number): number {
  if (!inputLimit || !Number.isFinite(inputLimit) || inputLimit <= 0) { return MIN_BUDGET; }
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.floor(inputLimit * 0.4) * 3));
}

// ---- accepting an entry ----------------------------------------------------------------------------

export type Accepted = { ok: true; attachment: Attachment } | { ok: false; reason: string; duplicate?: boolean };
type Inspected = { ok: true; relative: string; kind: 'file' | 'folder' } | { ok: false; reason: string };

const posix = (value: string) => value.split(path.sep).join('/');
const isOutside = (relative: string) => relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

/**
 * The checks of Decision 3 that do not depend on the other chips: the path is in the workspace (its real
 * path too, so a link that leads out is refused), it exists, and is a folder or a text file of at most 5 MB.
 */
function inspect(root: string, absolute: string): Inspected {
  const lexicalRoot = path.resolve(root);
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return { ok: false, reason: 'is outside the workspace' }; }
  const resolved = path.resolve(absolute);
  let relative = path.relative(lexicalRoot, resolved);
  if (isOutside(relative)) {
    // The same place by its real path (a folder opened through a link).
    const byReal = path.relative(realRoot, resolved);
    if (isOutside(byReal)) { return { ok: false, reason: 'is outside the workspace' }; }
    relative = byReal;
  }
  let real: string;
  try { real = fs.realpathSync(resolved); } catch { return { ok: false, reason: 'does not exist' }; }
  const realRelative = path.relative(realRoot, real);
  if (isOutside(realRelative)) { return { ok: false, reason: 'resolves outside the workspace (through a link)' }; }
  if (relative === '' || realRelative === '') { return { ok: false, reason: 'is the workspace root' }; }
  if (insideMaps(posix(relative)) || insideMaps(posix(realRelative))) { return { ok: false, reason: 'is inside .repository-manager/maps (the Studio\'s own maps)' }; }
  let stat: fs.Stats;
  try { stat = fs.statSync(real); } catch { return { ok: false, reason: 'does not exist' }; }
  if (stat.isDirectory()) { return { ok: true, relative: posix(relative), kind: 'folder' }; }
  if (!stat.isFile()) { return { ok: false, reason: 'is not a file or a folder' }; }
  if (stat.size > MAX_READ_BYTES) { return { ok: false, reason: `is larger than ${MAX_READ_BYTES / 1024 / 1024} MB` }; }
  try { if (fs.readFileSync(real).includes(0)) { return { ok: false, reason: 'is a binary file' }; } } catch { return { ok: false, reason: 'cannot be read' }; }
  return { ok: true, relative: posix(relative), kind: 'file' };
}

/** One entry the page asked to add: accepted, ignored as a duplicate, or refused with the reason. */
export function acceptEntry(root: string | undefined, entry: { scheme: string; fsPath: string }, existing: Attachment[]): Accepted {
  if (!root) { return { ok: false, reason: 'cannot be added: open a folder first' }; }
  if (entry.scheme !== 'file') { return { ok: false, reason: 'is not a file on this machine' }; }
  const inspected = inspect(root, entry.fsPath);
  if (!inspected.ok) { return inspected; }
  if (existing.some(item => item.path === inspected.relative)) { return { ok: false, reason: 'is already attached', duplicate: true }; }
  if (existing.length >= MAX_ATTACHMENTS) { return { ok: false, reason: `would be the ${MAX_ATTACHMENTS + 1}th: a chat holds at most ${MAX_ATTACHMENTS} files and folders` }; }
  return { ok: true, attachment: { path: inspected.relative, kind: inspected.kind } };
}

/** The checks again at send time: why a chip cannot be sent now, or undefined. */
export function recheck(root: string, attachment: Attachment): string | undefined {
  const inspected = inspect(root, path.join(root, attachment.path));
  if (!inspected.ok) { return inspected.reason; }
  return inspected.kind === attachment.kind ? undefined : `is now a ${inspected.kind}`;
}

// ---- fitting to the budget --------------------------------------------------------------------------

export interface FitInput {
  path: string;
  text: string;
  /** The file's size in bytes, which decides whether a summary is for it (at most MAX_FILE_BYTES). */
  bytes: number;
  summary?: string;
}

export interface Fit { path: string; form: Form; content?: string; reason?: string; needsSummary?: boolean }

const header = (file: string, form: Form) => `=== ${file} (${form}) ===\n`;

/**
 * Each file in the first form that fits what is left of the budget: in full, as its summary, as its
 * outline, or not sent. `fixed` is the text already spoken for (indexes). Nothing is cut mid-text.
 */
export function fitFiles(inputs: FitInput[], budget: number, fixed = 0): Fit[] {
  let left = Math.max(0, budget - fixed);
  return inputs.map(input => {
    const small = input.bytes <= MAX_FILE_BYTES;
    const take = (form: Form, content: string): Fit | undefined => {
      const cost = header(input.path, form).length + content.length + 1;
      if (cost > left) { return undefined; }
      left -= cost;
      return { path: input.path, form, content };
    };
    if (small) {
      const whole = take('full', input.text);
      if (whole) { return whole; }
      if (input.summary) { const summary = take('summary', input.summary); if (summary) { return summary; } }
    }
    const short = take('outline', outline(input.path, input.text));
    const needsSummary = small && !input.summary;
    if (short) { return needsSummary ? { ...short, needsSummary } : short; }
    return { path: input.path, form: 'not sent', reason: 'over the budget', ...(needsSummary ? { needsSummary } : {}) };
  });
}

// ---- preparing the attachments of a send ------------------------------------------------------------

interface FolderWork {
  item: PreparedItem;
  folder: string;
  mapPath: string;
  listed: ListedFile[];
  entries: MapEntry[];
  existingText?: string;
  changed: boolean;
}

interface ParentMap { folder: string; mapPath: string; entries: MapEntry[]; existingText?: string; changed: boolean }

const emptyItem = (chip: Attachment): PreparedItem => ({
  path: chip.path, kind: chip.kind, ignored: Boolean(chip.ignored), files: [], moreFiles: 0, sent: { full: 0, summary: 0, outline: 0, notSent: 0 }
});

/**
 * Reads what is attached (rechecking each chip), brings the folder maps up to date (descriptions in one
 * call per folder, summaries at most 3 per send), and fits the content to the budget. A Stop during a
 * model call keeps what was finished and throws `Cancelled`.
 */
export async function prepareAttachments(chips: Attachment[], deps: PrepareDeps): Promise<Prepared> {
  const notes: string[] = [];
  const items: PreparedItem[] = [];
  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const absoluteOf = (relative: string) => path.join(deps.root, relative);
  const textOf = (relative: string) => deps.openText(absoluteOf(relative)) ?? readMapFile(deps.root, relative);
  const works: Array<FolderWork | { item: PreparedItem; chip: Attachment; file?: ListedFile }> = [];
  const complete = deps.complete;
  // One description call per send, whatever the number of folders: a later folder keeps its outlines until the next send.
  let described = false;
  const describeOnce = complete && (async (prompt: string) => {
    if (described) { throw new Error('one description call per send'); }
    described = true;
    return complete(prompt);
  });
  const parents = new Map<string, ParentMap>();
  const memorySummaries = new Map<string, string>();
  let cancelled = false;

  // 1. Each chip, checked again: a file that was deleted, became binary or leads out stays a chip, not sent.
  for (const chip of chips) {
    if (cancelled) { break; }
    const item = emptyItem(chip);
    items.push(item);
    const reason = recheck(deps.root, chip);
    if (reason) { item.notSent = reason; item.sent.notSent = 1; works.push({ item, chip }); continue; }
    if (chip.kind === 'folder') {
      const folder = chip.path;
      const mapPath = mapPathOf(folder);
      deps.progress?.(`Updating the map of ${folder}…`);
      const listed = await readListed(deps.root, await listFolder(deps.root, folder), absolute => deps.openText(absolute));
      const existingText = textOf(mapPath);
      const existing = existingText ? parseMap(existingText) : [];
      let updated: { entries: MapEntry[]; changed: boolean };
      try { updated = await updateEntries(existing, listed, 'folder', { complete: describeOnce, signal: deps.signal, today }); }
      catch (error) { if (deps.signal.cancelled) { cancelled = true; items.pop(); break; } throw error; }
      works.push({ item, folder, mapPath, listed, entries: updated.entries, existingText, changed: updated.changed });
      if (existingText !== undefined) { item.map = mapPath; }
      continue;
    }
    item.ignored = await deps.ignored(chip.path).catch(() => false);
    const [file] = await readListed(deps.root, [chip.path], absolute => deps.openText(absolute));
    if (!file || file.kind !== 'text') { item.notSent = file?.kind === 'binary' ? 'is a binary file' : 'cannot be read'; item.sent.notSent = 1; works.push({ item, chip }); continue; }
    works.push({ item, chip, file });
  }

  const folderWorks = works.filter((work): work is FolderWork => 'folder' in work);
  /** The first folder chip that lists the file: its map holds the file's entry. */
  const folderOf = (file: string) => folderWorks.find(work => !work.item.notSent && work.listed.some(listed => listed.path === file));
  const parentOf = (file: string): ParentMap => {
    const folder = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    const mapPath = mapPathOf(folder);
    let parent = parents.get(mapPath);
    if (!parent) {
      const existingText = textOf(mapPath);
      parent = { folder, mapPath, entries: existingText ? parseMap(existingText) : [], existingText, changed: false };
      parents.set(mapPath, parent);
    }
    return parent;
  };
  const storedSummary = (file: ListedFile, ignored: boolean): string | undefined => {
    if (ignored) { return memorySummaries.get(`${file.path}@${file.hash}`); }
    const owner = folderOf(file.path);
    const entry = (owner ? owner.entries : parentOf(file.path).entries).find(candidate => candidate.path === file.path);
    return entry && entry.hash === file.hash ? entry.summary : undefined;
  };

  // 2. The files to send, in chip order, each once.
  interface Unit { item: PreparedItem; file: ListedFile; ignored: boolean; folder?: FolderWork }
  const units: Unit[] = [];
  const seen = new Map<string, string>();
  const place = (item: PreparedItem, file: ListedFile, ignored: boolean, folder?: FolderWork) => {
    if (seen.has(file.path)) { item.files.push({ path: file.path, outcome: 'not sent', reason: `sent with ${seen.get(file.path)}` }); return; }
    seen.set(file.path, item.path);
    if (file.kind === 'text') { units.push({ item, file, ignored, folder }); return; }
    item.files.push({ path: file.path, outcome: 'not sent', reason: file.kind === 'binary' ? 'binary file' : `larger than ${MAX_READ_BYTES / 1024 / 1024} MB` });
    item.sent.notSent++;
  };
  for (const work of works) {
    if (work.item.notSent) { continue; }
    if ('folder' in work) { for (const file of work.listed) { place(work.item, file, false, work); } continue; }
    place(work.item, work.file!, work.item.ignored);
  }

  const indexOf = (work: FolderWork) => `Folder ${work.folder}\nMap (a file in the repository; a code step can read it): ${work.mapPath}\nIndex (path: description):\n${indexText(work.entries) || '(no files)'}\n`;
  const fixed = folderWorks.filter(work => !work.item.notSent).reduce((sum, work) => sum + indexOf(work).length + 1, 0);
  const inputs = () => units.map(unit => ({ path: unit.file.path, text: unit.file.text!, bytes: unit.file.size, summary: storedSummary(unit.file, unit.ignored) }));
  const budget = budgetFor(deps.inputLimit);
  let fits = fitFiles(inputs(), budget, fixed);

  // 3. Summaries for the files that did not fit whole: at most 3 per send; the others go as outlines now.
  if (complete && !cancelled) {
    const wanted = units.filter((_, index) => fits[index].needsSummary).slice(0, MAX_SUMMARIES_PER_SEND);
    for (const unit of wanted) {
      deps.progress?.(`Summarizing ${unit.file.path}…`);
      try {
        const summary = normalizeSummary(await complete(summaryPrompt(unit.file.path, unit.file.text!)));
        if (!summary) { continue; }
        if (unit.ignored) { memorySummaries.set(`${unit.file.path}@${unit.file.hash}`, summary); continue; }
        // The entry goes in the map of the folder chip that lists the file, else of the file's own folder.
        if (unit.folder ?? folderOf(unit.file.path)) {
          const owner = (unit.folder ?? folderOf(unit.file.path))!;
          owner.entries = owner.entries.map(entry => entry.path === unit.file.path ? withSummary(entry, summary, today) : entry);
          owner.changed = true;
        } else {
          const parent = parentOf(unit.file.path);
          const updated = await updateEntries(parent.entries, [unit.file], 'partial', { signal: deps.signal, today });
          parent.entries = updated.entries.map(entry => entry.path === unit.file.path ? withSummary(entry, summary, today) : entry);
          parent.changed = true;
        }
      } catch {
        if (deps.signal.cancelled) { cancelled = true; break; }
        // No summary this time: the outline goes, and the next send tries again.
      }
    }
    fits = fitFiles(inputs(), budget, fixed);
  }

  // 4. The maps, written whole and renamed; not while the person has one open with unsaved changes.
  const writeMap = (folder: string, mapPath: string, entries: MapEntry[], changed: boolean, existingText: string | undefined, item?: PreparedItem) => {
    if (!changed || (!entries.length && existingText === undefined)) { return; }
    if (deps.isDirty(absoluteOf(mapPath))) {
      notes.push(`The map ${mapPath} is open with unsaved changes, so it was not saved; this send used the updated entries.`);
      if (item) { item.mapNotSaved = true; }
      return;
    }
    try { writeMapFile(deps.root, mapPath, renderMap(folder, entries)); if (item) { item.map = mapPath; } }
    catch (error) { notes.push(`The map ${mapPath} could not be written: ${error instanceof Error ? error.message : String(error)}`); }
  };
  for (const work of folderWorks) { if (!work.item.notSent) { writeMap(work.folder, work.mapPath, work.entries, work.changed, work.existingText, work.item); } }
  for (const parent of parents.values()) { writeMap(parent.folder, parent.mapPath, parent.entries, parent.changed, parent.existingText); }
  if (cancelled) { throw new Error('Cancelled'); }

  // 5. The text, and how each file went.
  const blocks = new Map<string, string[]>();
  units.forEach((unit, index) => {
    const fit = fits[index];
    const list = blocks.get(unit.item.path) ?? [];
    blocks.set(unit.item.path, list);
    if (fit.form === 'not sent') {
      unit.item.sent.notSent++;
      unit.item.files.push({ path: fit.path, outcome: 'not sent', reason: fit.reason });
    } else {
      unit.item.sent[fit.form]++;
      unit.item.files.push({ path: fit.path, outcome: fit.form });
      list.push(`${header(fit.path, fit.form)}${fit.content}\n`);
    }
  });
  const sections: string[] = [];
  for (const work of works) {
    if (work.item.notSent) { continue; }
    const body = (blocks.get(work.item.path) ?? []).join('\n');
    sections.push('folder' in work ? `${indexOf(work)}${body ? `\n${body}` : ''}` : body);
  }
  for (const item of items) {
    if (item.files.length > MAX_FILE_OUTCOMES) { item.moreFiles = item.files.length - MAX_FILE_OUTCOMES; item.files = item.files.slice(0, MAX_FILE_OUTCOMES); }
  }
  return { text: sections.filter(Boolean).join('\n'), items, notes };
}

/** `with a.md, docs/req (12 files: 9 full, 2 summary, 1 outline)`: what the person's bubble says went with a message. */
export function attachedLine(attached: Array<{ path: string; kind: 'file' | 'folder'; sent: { full: number; summary: number; outline: number; notSent: number } }>): string {
  const parts = attached.map(item => {
    const { full, summary, outline: short, notSent } = item.sent;
    if (item.kind === 'file') { return notSent ? `${item.path} (not sent)` : item.path; }
    const total = full + summary + short + notSent;
    const counts = [full && `${full} full`, summary && `${summary} summary`, short && `${short} outline`, notSent && `${notSent} not sent`].filter(Boolean).join(', ');
    return `${item.path} (${total} ${total === 1 ? 'file' : 'files'}${counts ? `: ${counts}` : ''})`;
  });
  return parts.length ? `with ${parts.join(', ')}` : '';
}
