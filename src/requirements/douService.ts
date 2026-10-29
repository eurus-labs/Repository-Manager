/**
 * What the Requirement editor asks of the extension for one clarification file: the endpoints of
 * the Python dou-editor's local server, as methods. Saving keeps its guarantees: the editor says
 * which version it edited (a SHA-256 of the bytes), a stale save is refused with the draft kept,
 * the file is checked again right before it is replaced, and the replacement is atomic.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DouError, ParsedDou, parse, prepareSave } from './douDocument';
import { CONFIG_NAME, RequirementSource, decodeUtf8, repositoryRoot, visualAid } from './requirementCatalog';

export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A refusal the editor shows as it is; `status` keeps the HTTP code the editor used to get. */
export class DouRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface DouDocumentData extends ParsedDou { content: string; hash: string; filename: string }
export interface IndexEntry { file: string; version: number; id: string; values: Record<string, string> }

/** Saves to one file wait for each other, wherever they come from. */
const saving = new Map<string, Promise<unknown>>();

export class DouService {
  constructor(readonly file: string, readonly source: RequirementSource) {}

  /** The requirements source for the repository holding `file`, shared by every file there. */
  static async sourceFor(file: string, cacheRoot: string, sources: Map<string, RequirementSource>): Promise<RequirementSource> {
    const config = path.join(await repositoryRoot(path.dirname(file)), CONFIG_NAME);
    let source = sources.get(config);
    if (!source) {
      source = new RequirementSource(config, cacheRoot);
      sources.set(config, source);
      void source.start();
    }
    return source;
  }

  async document(): Promise<DouDocumentData> {
    try {
      const raw = await fs.readFile(this.file);
      const content = decodeUtf8(raw);
      return { content, hash: digest(raw), filename: path.basename(this.file), ...parse(content) };
    } catch (error) {
      throw new DouRequestError(messageOf(error), 422);
    }
  }

  /** Items of the clarification files beside this one, as saved. */
  async index(): Promise<IndexEntry[]> {
    const folder = path.dirname(this.file);
    const names = (await fs.readdir(folder, { withFileTypes: true }))
      .filter(entry => !entry.isSymbolicLink() && entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const index: IndexEntry[] = [];
    for (const name of names) {
      try {
        const parsed = parse(decodeUtf8(await fs.readFile(path.join(folder, name))));
        for (const item of parsed.items) { index.push({ file: name, version: parsed.version, ...item }); }
      } catch { /* not a clarification file */ }
    }
    return index;
  }

  /** An image from Visual aids, as base64 for a blob: URL in the editor. */
  async asset(relative: string): Promise<{ data: string; kind: string }> {
    try {
      const { data, kind } = await visualAid(this.file, relative);
      return { data: data.toString('base64'), kind };
    } catch (error) {
      const status = (error as { status?: number }).status;
      throw new DouRequestError(messageOf(error), status || 422);
    }
  }

  requirements() {
    // Scanned per request, so edits to requirement files show after a reload.
    return this.source.describe();
  }

  async setSource(source: unknown) {
    if (JSON.stringify(source ?? '').length > 10_000) { throw new DouRequestError('Request size must be 1–10,000 bytes.', 422); }
    try {
      await this.source.save(source);
    } catch (error) {
      throw new DouRequestError(messageOf(error), 422);
    }
    return this.source.describe();
  }

  syncSource() {
    void this.source.sync();
    return this.source.describe();
  }

  /** Read-only: lets the editor leave Markdown mode or add an item without saving. */
  parse(content: unknown): ParsedDou {
    try {
      return parse(checkContent(content));
    } catch (error) {
      throw new DouRequestError(messageOf(error), 422);
    }
  }

  /** Write `content` if the file is still the version the editor loaded (`hash`). */
  async save(content: unknown, hash: unknown, target = this.file): Promise<{ hash: string }> {
    const previous = saving.get(target) || Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.write(checkContent(content), hash, target));
    saving.set(target, run);
    try {
      return await run;
    } finally {
      if (saving.get(target) === run) { saving.delete(target); }
    }
  }

  private async write(content: string, hash: unknown, target: string): Promise<{ hash: string }> {
    let next: string;
    let raw: Buffer;
    try {
      parse(content);
      raw = await fs.readFile(target);
    } catch (error) {
      throw new DouRequestError(messageOf(error), 422);
    }
    if (digest(raw) !== hash) {
      throw new DouRequestError('File changed externally. Your edits are retained. Download your draft before reloading.', 409);
    }
    try {
      next = prepareSave(decodeUtf8(raw), content);
    } catch (error) {
      throw new DouRequestError(messageOf(error), 422);
    }
    const bytes = Buffer.from(next, 'utf8');
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(temporary, (await fs.stat(target)).mode);
      // Check again right before replacing: other writers do not share this queue.
      if (!(await fs.readFile(target)).equals(raw)) {
        throw new DouRequestError('External change detected; draft retained.', 409);
      }
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error instanceof DouRequestError ? error : new DouRequestError(messageOf(error), 422);
    }
    return { hash: digest(bytes) };
  }
}

function checkContent(content: unknown): string {
  if (typeof content !== 'string') { throw new DouRequestError('content: expected the Markdown text.', 422); }
  if (!content || Buffer.byteLength(content, 'utf8') > 2_000_000) { throw new DouRequestError('Request size must be 1–2,000,000 bytes.', 422); }
  return content;
}

export function messageOf(error: unknown): string {
  if (error instanceof DouError || error instanceof Error) { return error.message; }
  return String(error);
}
