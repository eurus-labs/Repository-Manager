/* eslint-disable @typescript-eslint/naming-convention -- Anthropic-shaped messages and tools (tool_use_id, input_schema, tool names), as Musubi's LMRouter. */
/**
 * The tools a step's model may call, scoped to the task's repository. Reads are always allowed;
 * edits only to the paths the approved step lists, never to a file with unsaved changes in an
 * editor; commands only the repository's approved scripts. Every change keeps the content from
 * before the step, so Retry and Stop can put it back.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { findAiDirectedText } from '../services/aiDirectedText';
import { ToolSpec } from './lmRouter';
import { AgentToolName, AiTextWarning, CheckResult, FileChange, PlanStep, READ_TOOLS } from './types';

export const MAX_FILE_BYTES = 200 * 1024;
export const READ_LINES_DEFAULT = 200;
export const READ_LINES_MAX = 400;
export const READ_CHARS_MAX = 16000;
export const LIST_MAX = 200;
export const SEARCH_MAX = 50;

export interface ToolHost {
  /** Absolute repository root. */
  root: string;
  /** Whether an editor holds unsaved changes to this absolute path. */
  isDirty(absolutePath: string): boolean;
  /**
   * Scripts the person approved for this repository, read at each call: a step that changes a
   * script's command (package.json) makes it unapproved until the person approves it again.
   */
  allowedScripts(): string[];
  runScript(script: string): Promise<CheckResult>;
}

export interface ToolOutcome { ok: boolean; content: string; note: string }

export const TOOL_SPECS: Record<AgentToolName, ToolSpec> = {
  read_file: {
    name: 'read_file',
    description: `Read lines of a file (numbered). At most ${READ_LINES_MAX} lines per call.`,
    input_schema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, lineCount: { type: 'number' } }, required: ['path'] }
  },
  list_files: {
    name: 'list_files',
    description: 'List the entries of a folder of the repository (folders end with "/"). Omit path for the root.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } }
  },
  search_code: {
    name: 'search_code',
    description: `Find lines containing a literal text in tracked files (at most ${SEARCH_MAX} matches), optionally under a folder.`,
    input_schema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] }
  },
  edit_file: {
    name: 'edit_file',
    description: 'Replace one exact occurrence of oldText with newText in an existing file. oldText must occur exactly once; include enough surrounding lines.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] }
  },
  create_file: {
    name: 'create_file',
    description: 'Create a new file with the given content. Fails if the file exists.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  run_check: {
    name: 'run_check',
    description: 'Run one of the repository scripts allowed for this task (for example "test") and get its exit code and the end of its output.',
    input_schema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] }
  }
};

/** A path the model gave, as a clean relative path inside the repository, or an error. */
export function cleanPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) { throw new Error('path is required'); }
  const text = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(text) || /^[a-zA-Z]:/.test(text) || text.includes('\0')) { throw new Error(`Use a path relative to the repository: ${value}`); }
  const parts = text.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) { throw new Error(`Paths may not leave the repository: ${value}`); }
  if (parts[0] === '.git') { throw new Error('The .git folder is not available'); }
  return parts.join('/');
}

/** Whether a step that lists `allowed` may change `file`: the file itself, or a folder holding it. */
export function pathAllowed(file: string, allowed: string[]): boolean {
  return allowed.some(entry => {
    const clean = entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return clean === '' || file === clean || file.startsWith(`${clean}/`);
  });
}

function readText(absolute: string): string {
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) { throw new Error('Not a file'); }
  if (stat.size > MAX_FILE_BYTES) { throw new Error(`File is larger than ${MAX_FILE_BYTES / 1024} KB`); }
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) { throw new Error('Binary file'); }
  return buffer.toString('utf8');
}

export class StepWorkspace {
  readonly changes = new Map<string, FileChange>();
  readonly aiText: AiTextWarning[] = [];
  private readonly realRoot: string;

  constructor(private readonly host: ToolHost, private readonly step: Pick<PlanStep, 'tools' | 'paths'>) {
    this.realRoot = fs.realpathSync(host.root);
  }

  /** The tools this step may call: the read tools, and the write tools it lists. */
  tools(): ToolSpec[] {
    const names = [...READ_TOOLS, ...this.step.tools.filter(name => !READ_TOOLS.includes(name))];
    return names.map(name => TOOL_SPECS[name]);
  }

  async invoke(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      if (!this.tools().some(tool => tool.name === name)) {
        throw new Error(`${name} is not allowed in this step (allowed: ${this.tools().map(tool => tool.name).join(', ')})`);
      }
      switch (name as AgentToolName) {
        case 'read_file': return this.readFile(input);
        case 'list_files': return this.listFiles(input);
        case 'search_code': return await this.searchCode(input);
        case 'edit_file': return this.editFile(input);
        case 'create_file': return this.createFile(input);
        case 'run_check': return await this.runCheck(input);
      }
      throw new Error(`Unknown tool ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, content: message, note: message };
    }
  }

  /**
   * The absolute path, refusing one that leaves the repository or reaches .git through a link.
   * Also returns the path a link leads to, relative to the repository, which is what a write
   * really changes.
   */
  private locate(relative: string, mustExist: boolean): { absolute: string; target: string } {
    const absolute = path.join(this.realRoot, relative);
    let probe = absolute;
    while (!fs.existsSync(probe)) {
      if (mustExist) { throw new Error(`No such file or folder: ${relative}`); }
      probe = path.dirname(probe);
    }
    const real = path.join(fs.realpathSync(probe), path.relative(probe, absolute));
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) { throw new Error(`Paths may not leave the repository: ${relative}`); }
    const target = path.relative(this.realRoot, real).split(path.sep).join('/');
    if (target.split('/')[0] === '.git') { throw new Error('The .git folder is not available'); }
    return { absolute, target };
  }

  private resolve(relative: string, mustExist: boolean): string {
    return this.locate(relative, mustExist).absolute;
  }

  private readFile(input: Record<string, unknown>): ToolOutcome {
    const file = cleanPath(input.path);
    const text = readText(this.resolve(file, true));
    const lines = text.split('\n');
    const start = Math.max(1, Math.floor(Number(input.startLine) || 1));
    const count = Math.min(READ_LINES_MAX, Math.max(1, Math.floor(Number(input.lineCount) || READ_LINES_DEFAULT)));
    const slice = lines.slice(start - 1, start - 1 + count);
    let body = '';
    let shown = 0;
    for (const [index, line] of slice.entries()) {
      const next = `${start + index}: ${line}\n`;
      if (body.length + next.length > READ_CHARS_MAX) { break; }
      body += next;
      shown++;
    }
    const end = start + shown - 1;
    this.flag(findAiDirectedText(file, slice.slice(0, shown).map((text, index) => ({ line: start + index, text }))));
    const more = end < lines.length ? `\n(lines ${start}-${end} of ${lines.length}; read on with startLine ${end + 1})` : '';
    return { ok: true, content: `${file}\n${body}${more}`, note: `${file}:${start}-${end}` };
  }

  private flag(warnings: AiTextWarning[]): void {
    for (const warning of warnings) {
      if (!this.aiText.some(item => item.path === warning.path && item.line === warning.line)) { this.aiText.push(warning); }
    }
  }

  private listFiles(input: Record<string, unknown>): ToolOutcome {
    const folder = input.path === undefined || input.path === '' ? '' : cleanPath(input.path);
    const absolute = this.resolve(folder, true);
    const entries = fs.readdirSync(absolute, { withFileTypes: true })
      .filter(entry => entry.name !== '.git')
      .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort();
    const shown = entries.slice(0, LIST_MAX);
    const more = entries.length > shown.length ? `\n(${entries.length - shown.length} more not shown)` : '';
    return { ok: true, content: `${folder || '.'}/\n${shown.join('\n')}${more}`, note: `${folder || '.'} (${entries.length})` };
  }

  private searchCode(input: Record<string, unknown>): Promise<ToolOutcome> {
    if (typeof input.query !== 'string' || !input.query) { throw new Error('query is required'); }
    const query = input.query;
    const folder = input.path === undefined || input.path === '' ? '' : cleanPath(input.path);
    const args = ['-c', 'core.longpaths=true', 'grep', '-n', '-I', '-F', '--no-color', '-e', query, '--', folder || '.'];
    return new Promise(resolve => {
      execFile('git', args, { cwd: this.realRoot, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        // git grep exits 1 when nothing matches.
        if (error && (error as { code?: unknown }).code !== 1) {
          resolve({ ok: false, content: `Search failed: ${error.message}`, note: 'search failed' });
          return;
        }
        const lines = stdout.split('\n').filter(Boolean);
        const shown = lines.slice(0, SEARCH_MAX).map(line => line.length > 300 ? `${line.slice(0, 299)}…` : line);
        // What the model sees here counts as read: text speaking to an AI is flagged, as with read_file.
        for (const line of lines.slice(0, SEARCH_MAX)) {
          const match = /^(.*?):(\d+):(.*)$/.exec(line);
          if (match) { this.flag(findAiDirectedText(match[1], [{ line: Number(match[2]), text: match[3] }])); }
        }
        const more = lines.length > shown.length ? `\n(${lines.length - shown.length} more matches not shown)` : '';
        resolve({ ok: true, content: shown.length ? shown.join('\n') + more : 'No matches.', note: `"${query}" (${lines.length})` });
      });
    });
  }

  /** The file a write really changes: its path (relative, links resolved) and its absolute path. */
  private checkWritable(file: string): { absolute: string; target: string } {
    if (!pathAllowed(file, this.step.paths)) {
      throw new Error(`${file} is not among the paths this step may change (${this.step.paths.join(', ') || 'none'}). Finish and say which file is missing.`);
    }
    const { absolute, target } = this.locate(file, false);
    // A link inside an allowed folder must not lead to a file the step may not change.
    if (target !== file && !pathAllowed(target, this.step.paths)) {
      throw new Error(`${file} leads to ${target}, which is not among the paths this step may change.`);
    }
    if (this.host.isDirty(absolute)) { throw new Error(`${file} has unsaved changes in an editor; it is not changed.`); }
    return { absolute, target };
  }

  /**
   * Keyed by the file really changed (links resolved), so two paths to one file keep one record
   * whose "before" is the content from before the step, and undo puts that back.
   */
  private record(target: string, before: string | null, after: string): void {
    const known = this.changes.get(target);
    this.changes.set(target, { path: target, before: known ? known.before : before, after });
  }

  private editFile(input: Record<string, unknown>): ToolOutcome {
    const file = cleanPath(input.path);
    if (typeof input.oldText !== 'string' || !input.oldText || typeof input.newText !== 'string') { throw new Error('oldText and newText are required'); }
    const { absolute, target } = this.checkWritable(file);
    const text = readText(absolute);
    const first = text.indexOf(input.oldText);
    if (first < 0) { throw new Error(`oldText was not found in ${file}; read the file again.`); }
    if (text.indexOf(input.oldText, first + 1) >= 0) { throw new Error(`oldText occurs more than once in ${file}; include more lines.`); }
    const after = text.slice(0, first) + input.newText + text.slice(first + input.oldText.length);
    if (Buffer.byteLength(after) > MAX_FILE_BYTES) { throw new Error(`The result is larger than ${MAX_FILE_BYTES / 1024} KB`); }
    fs.writeFileSync(absolute, after);
    this.record(target, text, after);
    return { ok: true, content: `Edited ${file}.`, note: file };
  }

  private createFile(input: Record<string, unknown>): ToolOutcome {
    const file = cleanPath(input.path);
    if (typeof input.content !== 'string') { throw new Error('content is required'); }
    if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) { throw new Error(`The content is larger than ${MAX_FILE_BYTES / 1024} KB`); }
    const { absolute, target } = this.checkWritable(file);
    if (fs.existsSync(absolute)) { throw new Error(`${file} exists; use edit_file.`); }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, input.content);
    this.record(target, null, input.content);
    return { ok: true, content: `Created ${file}.`, note: file };
  }

  private async runCheck(input: Record<string, unknown>): Promise<ToolOutcome> {
    const allowed = this.host.allowedScripts();
    if (typeof input.script !== 'string' || !allowed.includes(input.script)) {
      throw new Error(`Only these scripts may run: ${allowed.join(', ') || 'none'} (a script whose command changed must be approved again)`);
    }
    const result = await this.host.runScript(input.script);
    return { ok: true, content: `exit code ${result.exitCode}\n${result.output}`, note: `${input.script}: ${result.passed ? 'passed' : 'failed'}` };
  }
}

/**
 * Puts the files a step changed back as they were. A file that changed again since the step (the
 * person edited it, or it has unsaved changes) is left alone and returned, never overwritten.
 */
export function revertChanges(root: string, changes: FileChange[], isDirty: (absolutePath: string) => boolean): string[] {
  const kept: string[] = [];
  for (const change of changes) {
    const absolute = path.join(root, change.path);
    let current: string | null = null;
    try { current = fs.readFileSync(absolute, 'utf8'); } catch { current = null; }
    if (current !== change.after || isDirty(absolute)) { kept.push(change.path); continue; }
    if (change.before === null) { fs.rmSync(absolute, { force: true }); } else { fs.writeFileSync(absolute, change.before); }
  }
  return kept;
}
