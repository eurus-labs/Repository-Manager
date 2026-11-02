/**
 * Tasks and their run logs, as files in the extension's storage for this workspace: one JSON file
 * per task and one append-only JSON Lines log per task. Nothing is written to the repository.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { AgentTask, RunLogEntry, RunLogEvent } from './types';

const ID = /^[a-z0-9-]{1,64}$/;

export class TaskStore {
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly folder: string, private readonly now: () => Date = () => new Date()) {}

  onDidChange(listener: () => void): void { this.listeners.push(listener); }

  private taskFile(id: string): string {
    if (!ID.test(id)) { throw new Error(`Invalid task id: ${id}`); }
    return path.join(this.folder, 'tasks', `${id}.json`);
  }

  private logFile(id: string): string {
    if (!ID.test(id)) { throw new Error(`Invalid task id: ${id}`); }
    return path.join(this.folder, 'runs', `${id}.jsonl`);
  }

  list(): AgentTask[] {
    const folder = path.join(this.folder, 'tasks');
    if (!fs.existsSync(folder)) { return []; }
    const tasks: AgentTask[] = [];
    for (const name of fs.readdirSync(folder)) {
      if (!name.endsWith('.json')) { continue; }
      const task = this.get(name.slice(0, -5));
      if (task) { tasks.push(task); }
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): AgentTask | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.taskFile(id), 'utf8')) as AgentTask;
      return value && value.id === id ? value : undefined;
    } catch {
      return undefined;
    }
  }

  create(fields: Pick<AgentTask, 'title' | 'goal' | 'criteria' | 'repositoryRoot'>): AgentTask {
    const at = this.now().toISOString();
    const id = `${at.slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
    const task: AgentTask = { id, ...fields, createdAt: at, updatedAt: at, status: 'new', current: 0 };
    this.save(task);
    return task;
  }

  save(task: AgentTask): void {
    task.updatedAt = this.now().toISOString();
    const file = this.taskFile(task.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Written beside and renamed, so a crash never leaves half a task.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(task, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    this.listeners.forEach(listener => listener());
  }

  delete(id: string): void {
    fs.rmSync(this.taskFile(id), { force: true });
    fs.rmSync(this.logFile(id), { force: true });
    this.listeners.forEach(listener => listener());
  }

  log(id: string, event: RunLogEvent): void {
    const file = this.logFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: this.now().toISOString(), ...event })}\n`);
  }

  readLog(id: string): RunLogEntry[] {
    try {
      return fs.readFileSync(this.logFile(id), 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as RunLogEntry]; } catch { return []; }
      });
    } catch {
      return [];
    }
  }
}
