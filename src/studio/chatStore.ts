/**
 * Studio Chat conversations, kept on this machine (workspace storage), one file each, like the
 * agent's tasks: they hold what the person typed and the model's replies. A plan lives in its
 * conversation until the person saves it as a workflow file. No `vscode` here.
 */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PlanDiff } from './chatPlanner';
import { Problem, Workflow } from './workflow';

/** proposed: a change waiting for Accept. current: the plan the conversation has. */
export type DraftStatus = 'current' | 'proposed' | 'accepted' | 'discarded' | 'superseded';

export interface ChatDraft {
  workflow: Workflow;
  problems: Problem[];
  diff?: PlanDiff;
  status: DraftStatus;
}

export interface ChatRun {
  id: string;
  status: string;
  error?: string;
  /** The criteria the run froze, for the person to check against the result. */
  criteria?: string[];
  /** Files the run wrote, relative to the workspace. */
  written?: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'run' | 'error';
  text: string;
  at: string;
  /** For an assistant turn: the name of the model that answered. */
  model?: string;
  draft?: ChatDraft;
  run?: ChatRun;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The `<vendor>:<family>` chosen for drafting. */
  model?: string;
  messages: ChatMessage[];
  /** The plan as it is now (the last accepted draft, with the person's edits). */
  plan?: Workflow;
  /** Where the plan was saved, relative to the workspace: from then on that file is the plan. */
  file?: string;
  /**
   * The repository the plan was made for, when it came from elsewhere (an agent task): its paths are
   * relative to it, so it runs only when that repository is the folder open.
   */
  repositoryRoot?: string;
}

export const newMessage = (message: Omit<ChatMessage, 'id' | 'at'>): ChatMessage => ({ id: randomUUID().slice(0, 12), at: new Date().toISOString(), ...message });

export class ChatStore {
  /** Saves of one conversation, one after another: two at once would share the temporary file. */
  private readonly saving = new Map<string, Promise<void>>();

  constructor(readonly folder: string) {}

  private file(id: string): string {
    if (!/^[\w-]+$/.test(id)) { throw new Error(`"${id}" is not a conversation id.`); }
    return path.join(this.folder, `${id}.json`);
  }

  create(): Conversation {
    const now = new Date().toISOString();
    return { id: `${now.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
  }

  save(conversation: Conversation): Promise<void> {
    conversation.updatedAt = new Date().toISOString();
    const file = this.file(conversation.id);
    // The text as it is now, written after the saves before it.
    const text = JSON.stringify(conversation, null, 2);
    const next = (this.saving.get(conversation.id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await fs.mkdir(this.folder, { recursive: true });
      // Written whole, then renamed: a crash never leaves half a conversation.
      await fs.writeFile(`${file}.tmp`, text);
      await fs.rename(`${file}.tmp`, file);
    });
    this.saving.set(conversation.id, next);
    void next.finally(() => { if (this.saving.get(conversation.id) === next) { this.saving.delete(conversation.id); } }).catch(() => undefined);
    return next;
  }

  async load(id: string): Promise<Conversation | undefined> {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as Conversation; } catch { return undefined; }
  }

  async list(): Promise<Conversation[]> {
    const names = (await fs.readdir(this.folder).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
    const all = await Promise.all(names.map(name => this.load(name.slice(0, -5))));
    return all.filter((item): item is Conversation => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }
}
