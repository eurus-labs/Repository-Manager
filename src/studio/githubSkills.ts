/* eslint-disable @typescript-eslint/naming-convention -- GitHub API headers and fields (User-Agent, default_branch) are named by GitHub. */
/**
 * Skills from GitHub in VS Code (docs/agent-studio.md, "Skills from GitHub"): the GitHub API with
 * the person's VS Code GitHub sign-in (`repo` scope, so private repositories work), the sources
 * from the `repositoryManager.studio.skillSources` setting, and the one-time trust per source.
 */
import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import { LoadedSkill, SKILL_SOURCE, SkillError, SkillLibrary, SkillSourceApi, SkillSummary, parseSkillRef } from './skills';

const TRUSTED_KEY = 'repositoryManager.studio.trustedSkillSources';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** What the Studio uses skills through; tests give their own. */
export interface StudioSkills {
  /** The repositories in the setting, as owner/name. */
  sources(): string[];
  index(source: string): Promise<{ commit: string; skills: SkillSummary[] }>;
  /** Skills listed before, without asking GitHub: the planner may suggest these. */
  cached(): Promise<SkillSummary[]>;
  load(ref: string): Promise<LoadedSkill>;
  /** Asks once per source before its skills are used. False: not trusted. */
  ensureTrusted(sources: string[]): Promise<boolean>;
}

function request(url: string, token: string | undefined, accept: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'repository-manager-vscode', Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      timeout: 30_000
    }, res => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('The response from GitHub is too large.')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 0) >= 400) {
          const hint = res.statusCode === 404 ? ' (not found, or your GitHub account cannot see it)' : res.statusCode === 403 ? ' (forbidden or rate limited)' : '';
          reject(new SkillError(`GitHub answered ${res.statusCode}${hint} for ${url.replace('https://api.github.com/', '')}.`));
          return;
        }
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time.')));
    req.on('error', reject);
  });
}

/** The GitHub REST API through the person's sign-in; without a session, public repositories only. */
export class GitHubSkillApi implements SkillSourceApi {
  async token(): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      return session?.accessToken;
    } catch {
      return undefined;
    }
  }

  private async json<T>(route: string): Promise<T> {
    return JSON.parse(await request(`https://api.github.com/${route}`, await this.token(), 'application/vnd.github+json')) as T;
  }

  async headCommit(owner: string, repo: string): Promise<string> {
    const info = await this.json<{ default_branch?: string }>(`repos/${owner}/${repo}`);
    const branch = info.default_branch ?? 'main';
    const commit = await this.json<{ sha?: string }>(`repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`);
    if (!commit.sha || !/^[0-9a-f]{40}$/.test(commit.sha)) { throw new SkillError(`No commit found on ${owner}/${repo} ${branch}.`); }
    return commit.sha;
  }

  async tree(owner: string, repo: string, commit: string): Promise<string[]> {
    const tree = await this.json<{ tree?: Array<{ path: string; type: string }>; truncated?: boolean }>(`repos/${owner}/${repo}/git/trees/${commit}?recursive=1`);
    return (tree.tree ?? []).filter(entry => entry.type === 'blob').map(entry => entry.path);
  }

  async file(owner: string, repo: string, commit: string, filePath: string): Promise<string> {
    const route = `repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`;
    return request(`https://api.github.com/${route}`, await this.token(), 'application/vnd.github.raw');
  }
}

export function studioSkills(context: vscode.ExtensionContext, api: SkillSourceApi = new GitHubSkillApi()): StudioSkills {
  const library = new SkillLibrary(path.join(context.globalStorageUri.fsPath, 'studio', 'skills'), api);
  const sources = (): string[] => {
    const value = vscode.workspace.getConfiguration('repositoryManager').get<unknown>('studio.skillSources');
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && SKILL_SOURCE.test(item.trim())).map(item => item.trim()))] : [];
  };
  return {
    sources,
    index: source => library.index(source),
    cached: async () => (await Promise.all(sources().map(source => library.cachedIndex(source)))).flat(),
    load: ref => library.load(ref),
    async ensureTrusted(wanted) {
      const trusted = new Set(context.globalState.get<string[]>(TRUSTED_KEY) ?? []);
      for (const source of [...new Set(wanted)]) {
        if (trusted.has(source)) { continue; }
        const trust = 'Trust Skills';
        const answer = await vscode.window.showWarningMessage(`Use skills from github.com/${source}?`, {
          modal: true,
          detail: 'A skill is instructions the model follows in the steps that use it. Trust only a repository you would take instructions from. Its scripts are never run here, and steps that write, run or send still ask you first. This is asked once for this repository.'
        }, trust);
        if (answer !== trust) { return false; }
        trusted.add(source);
        await context.globalState.update(TRUSTED_KEY, [...trusted]);
      }
      return true;
    }
  };
}

/** The sources a list of skill references comes from. */
export function skillSources(refs: string[]): string[] {
  return [...new Set(refs.flatMap(ref => { try { return [parseSkillRef(ref).source]; } catch { return []; } }))];
}
