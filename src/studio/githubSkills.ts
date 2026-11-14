/* eslint-disable @typescript-eslint/naming-convention -- GitHub API headers and fields (User-Agent, default_branch) are named by GitHub. */
/**
 * Skills from GitHub in VS Code (docs/agent-studio.md, "Skills from GitHub"): the GitHub API with
 * the person's VS Code GitHub sign-in (`repo` scope, so private repositories work), the sources
 * from the `repositoryManager.studio.skillSources` setting, and the one-time trust per source.
 */
import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import { GITHUB_HOST, LoadedSkill, SKILL_SOURCE, SkillError, SkillLibrary, SkillSourceApi, SkillSummary, parseSkillRef, sourceLabel } from './skills';

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
  /** Asks the person to sign in to a host (github.com by default) now, even after an earlier Cancel. True: signed in. */
  signIn(host?: string): Promise<boolean>;
  /** Adds a source to the setting (the person's user settings). */
  addSource(source: string): Promise<void>;
  removeSource(source: string): Promise<void>;
}

/**
 * A GitHub repository as people write it: owner/name, github.com/owner/name, a GitHub Enterprise
 * server's host/owner/name, or the repository's URL on either (with .git, a branch path or a
 * trailing slash). github.com gives owner/name; another server gives host/owner/name. Undefined
 * when it is not one.
 */
export function parseSkillSource(text: string): string | undefined {
  const trimmed = text.trim().replace(/^git@([^:\s]+):/i, '$1/');
  // A URL may go on into a branch or a folder; a bare owner/name (or host/owner/name) may not.
  const url = /^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/[^\s]*)?$/i.exec(trimmed);
  const bare = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
  // Only github.com's own www alias is the same server; an Enterprise host is kept whole.
  const named = url ? url[1].toLowerCase() : undefined;
  const host = named === `www.${GITHUB_HOST}` ? GITHUB_HOST : named;
  const owner = url ? url[2] : bare?.[1];
  const repo = url ? url[3] : bare?.[2];
  if (!owner || !repo || /^\.+$/.test(repo)) { return undefined; }
  const source = host && host !== GITHUB_HOST ? `${host}/${owner}/${repo}` : `${owner}/${repo}`;
  return SKILL_SOURCE.test(source) ? source : undefined;
}

/** GitHub answered with an error status: kept, so a refusal can lead to one sign-in question. */
export class GitHubRequestError extends SkillError {
  constructor(message: string, readonly status: number) { super(message); }
}

export type GitHubFetch = (url: string, token: string | undefined, accept: string) => Promise<string>;

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
          reject(new GitHubRequestError(`GitHub answered ${res.statusCode}${hint} for ${url.replace('https://api.github.com/', '')}.`, res.statusCode ?? 0));
          return;
        }
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time.')));
    req.on('error', reject);
  });
}

type Auth = Pick<typeof vscode.authentication, 'getSession'>;

/** The host VS Code's GitHub Enterprise sign-in is set up for (`github-enterprise.uri`), if any. */
export function enterpriseHost(): string | undefined {
  const uri = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
  try { return uri ? new URL(uri).hostname.toLowerCase() : undefined; } catch { return undefined; }
}

interface HostState { token?: string; looked: boolean; declined: boolean; asking?: Promise<string | undefined> }

/**
 * Asks to point VS Code's GitHub Enterprise sign-in (`github-enterprise.uri`) at a server, and sets
 * it when the person agrees. When it already names another server, says so: other extensions sign in
 * through the same setting. True: set.
 */
export async function setUpEnterprise(host: string): Promise<boolean> {
  const current = enterpriseHost();
  const action = current ? `Switch to ${host}` : 'Set Up and Sign In';
  const detail = current
    ? `VS Code's GitHub Enterprise sign-in is set to ${current} (the setting github-enterprise.uri). Skills from ${host} need it set to https://${host}; extensions that use GitHub Enterprise then sign in to ${host} instead.`
    : `VS Code signs in to a GitHub Enterprise server named in the setting github-enterprise.uri. This sets it to https://${host} in your user settings, then asks you to sign in.`;
  const answer = await vscode.window.showWarningMessage(`Sign in to ${host} to read its skills?`, { modal: true, detail }, action);
  if (answer !== action) { return false; }
  await vscode.workspace.getConfiguration('github-enterprise').update('uri', `https://${host}`, vscode.ConfigurationTarget.Global);
  return true;
}

/**
 * The GitHub REST API, on github.com or a GitHub Enterprise server (its `/api/v3`). A session the
 * person already has is used without asking; without one, repositories are read anonymously.
 * Only when a server refuses (a private repository, the anonymous rate limit) is the person asked
 * to sign in, once per server: a Cancel is remembered and not asked again (Manage Skill Sources →
 * Sign in asks on request). Each request asking again kept the sign-in dialog coming back after
 * Cancel (reported 2026-11-13). An Enterprise server signs in through VS Code's GitHub Enterprise
 * account, which serves the one server set in `github-enterprise.uri`.
 */
export class GitHubSkillApi implements SkillSourceApi {
  private readonly hosts = new Map<string, HostState>();

  constructor(private readonly fetch: GitHubFetch = request, private readonly auth: Auth = vscode.authentication,
    private readonly enterprise: () => string | undefined = enterpriseHost,
    private readonly setUp: (host: string) => Promise<boolean> = setUpEnterprise) {}

  private state(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) { state = { looked: false, declined: false }; this.hosts.set(host, state); }
    return state;
  }

  /** The VS Code account that signs in to this host; undefined when none can. */
  private provider(host: string): string | undefined {
    if (host === GITHUB_HOST) { return 'github'; }
    return this.enterprise() === host ? 'github-enterprise' : undefined;
  }

  /** A session the person already has, found without a dialog; looked up once per host. */
  private async silent(host: string): Promise<string | undefined> {
    const state = this.state(host);
    const provider = this.provider(host);
    if (!state.looked && provider) {
      state.looked = true;
      try { state.token = (await this.auth.getSession(provider, ['repo'], { silent: true }))?.accessToken; } catch { state.token = undefined; }
    }
    return state.token;
  }

  /**
   * Asks to sign in to a host, at most once at a time; after a Cancel, only when `force` (the person
   * asked). Undefined: not signed in.
   */
  async signIn(force = false, host: string = GITHUB_HOST): Promise<string | undefined> {
    const state = this.state(host);
    if (state.declined && !force) { return undefined; }
    if (!state.asking) {
      state.asking = (async () => {
        try {
          // An Enterprise server VS Code is not set up for: offer to set it up first (asked once,
          // with the sign-in: declining either is remembered the same way).
          if (!this.provider(host) && !await this.setUp(host)) { state.declined = true; return undefined; }
          const provider = this.provider(host);
          if (!provider) { state.declined = true; return undefined; }
          const session = await this.auth.getSession(provider, ['repo'], { createIfNone: true });
          state.token = session?.accessToken;
          state.looked = true;
          state.declined = !state.token;
          return state.token;
        } catch {
          state.declined = true;
          return undefined;
        } finally {
          state.asking = undefined;
        }
      })();
    }
    return state.asking;
  }

  /**
   * Forgets the sessions found (not the Cancels): the next request looks again, silently. Called
   * when VS Code's sessions change (sign out, sign in, a refreshed token).
   */
  forgetSessions(): void {
    for (const state of this.hosts.values()) { state.looked = false; state.token = undefined; }
  }

  private async get(route: string, accept: string, host: string = GITHUB_HOST): Promise<string> {
    const url = host === GITHUB_HOST ? `https://api.github.com/${route}` : `https://${host}/api/v3/${route}`;
    let token = await this.silent(host);
    try {
      return await this.fetch(url, token, accept);
    } catch (first) {
      let error: unknown = first;
      // A token no longer valid (signed out, or replaced): look for the current session silently and
      // try again with it, or without one; never keep sending the old token.
      if (token && error instanceof GitHubRequestError && error.status === 401) {
        const state = this.state(host);
        state.looked = false;
        state.token = undefined;
        const fresh = await this.silent(host);
        if (fresh === token) { throw error; }
        token = fresh;
        try { return await this.fetch(url, token, accept); } catch (retry) { error = retry; }
      }
      // Refused without a sign-in: a private repository, or the anonymous limit. Ask once.
      if (token || !(error instanceof GitHubRequestError) || ![401, 403, 404].includes(error.status)) { throw error; }
      const signedIn = await this.signIn(false, host);
      if (!signedIn) {
        throw new SkillError(this.provider(host)
          ? `${error.message} If the repository is private, sign in: Manage Skill Sources → Sign in to ${host}.`
          : `${error.message} ${host} needs a sign-in: Manage Skill Sources → Sign in to ${host} sets up VS Code's GitHub Enterprise sign-in for it (the setting github-enterprise.uri).`);
      }
      return this.fetch(url, signedIn, accept);
    }
  }

  private async json<T>(route: string, host?: string): Promise<T> {
    return JSON.parse(await this.get(route, 'application/vnd.github+json', host)) as T;
  }

  async headCommit(owner: string, repo: string, host?: string): Promise<string> {
    const info = await this.json<{ default_branch?: string }>(`repos/${owner}/${repo}`, host);
    const branch = info.default_branch ?? 'main';
    const commit = await this.json<{ sha?: string }>(`repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, host);
    if (!commit.sha || !/^[0-9a-f]{40}$/.test(commit.sha)) { throw new SkillError(`No commit found on ${owner}/${repo} ${branch}.`); }
    return commit.sha;
  }

  async tree(owner: string, repo: string, commit: string, host?: string): Promise<string[]> {
    const tree = await this.json<{ tree?: Array<{ path: string; type: string }>; truncated?: boolean }>(`repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, host);
    return (tree.tree ?? []).filter(entry => entry.type === 'blob').map(entry => entry.path);
  }

  async file(owner: string, repo: string, commit: string, filePath: string, host?: string): Promise<string> {
    const route = `repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`;
    return this.get(route, 'application/vnd.github.raw', host);
  }
}

export function studioSkills(context: vscode.ExtensionContext, api: SkillSourceApi & { signIn?(force: boolean, host?: string): Promise<string | undefined> } = new GitHubSkillApi()): StudioSkills {
  const library = new SkillLibrary(path.join(context.globalStorageUri.fsPath, 'studio', 'skills'), api);
  // A sign-out, a sign-in or a refreshed token in VS Code: the next request uses the session as it is now.
  const forget = (api as { forgetSessions?: () => void }).forgetSessions;
  const changed = forget ? vscode.authentication?.onDidChangeSessions?.(event => {
    if (event.provider.id === 'github' || event.provider.id === 'github-enterprise') { forget.call(api); }
  }) : undefined;
  if (changed) { context.subscriptions.push(changed); }
  const sources = (): string[] => {
    const value = vscode.workspace.getConfiguration('repositoryManager').get<unknown>('studio.skillSources');
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && SKILL_SOURCE.test(item.trim())).map(item => item.trim()))] : [];
  };
  const save = async (list: string[]) => {
    await vscode.workspace.getConfiguration('repositoryManager').update('studio.skillSources', list, vscode.ConfigurationTarget.Global);
  };
  return {
    sources,
    signIn: async host => Boolean(await api.signIn?.(true, host)),
    addSource: async source => { if (!sources().includes(source)) { await save([...sources(), source]); } },
    removeSource: async source => { await save(sources().filter(item => item !== source)); },
    index: source => library.index(source),
    cached: async () => (await Promise.all(sources().map(source => library.cachedIndex(source)))).flat(),
    load: ref => library.load(ref),
    async ensureTrusted(wanted) {
      const trusted = new Set(context.globalState.get<string[]>(TRUSTED_KEY) ?? []);
      for (const source of [...new Set(wanted)]) {
        if (trusted.has(source)) { continue; }
        const trust = 'Trust Skills';
        const answer = await vscode.window.showWarningMessage(`Use skills from ${sourceLabel(source)}?`, {
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
