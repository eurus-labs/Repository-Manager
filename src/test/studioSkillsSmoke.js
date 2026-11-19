// Skills for Studio steps (docs/agent-studio.md, "Skills from GitHub") with a scripted GitHub: the
// listing (front matter, scripts flagged, templates left out), the cache per commit (fetched once),
// pinned references, the text a prompt step sends, validation, the planner (offered skills only),
// the trust asked once per source, and "+ Skill" in the chat's host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-skills-'));
const commit = 'a'.repeat(40);
const newer = 'b'.repeat(40);

// --- a scripted GitHub repository: acme/skills -------------------------------------------------
const files = {
  'README.md': '# skills',
  'plugins/testing/skills/write-tests/SKILL.md': '---\nname: write-tests\ndescription: "Write tests that fail before the fix."\n---\n# Write tests\nRead references/standard.md first. Run `python scripts/run.py` to list tests.\n',
  'plugins/testing/skills/write-tests/references/standard.md': 'Every test names the behaviour it checks.',
  'plugins/testing/skills/write-tests/references/unused.md': 'Not named by the skill.',
  'plugins/testing/skills/write-tests/scripts/run.py': 'print(1)',
  'plugins/docs/skills/plain-words/SKILL.md': '---\nname: plain-words\ndescription: Short sentences.\n---\nUse short sentences.',
  'plugins/_template/skills/example/SKILL.md': '---\nname: example\n---\nTemplate.'
};
const calls = { head: 0, tree: 0, file: 0 };
let head = commit;
const api = {
  headCommit: async (owner, repo) => { calls.head++; assert.equal(`${owner}/${repo}`, 'acme/skills'); return head; },
  tree: async () => { calls.tree++; return Object.keys(files); },
  file: async (_owner, _repo, at, file) => { calls.file++; assert.ok([commit, newer].includes(at)); if (!(file in files)) throw new Error(`no ${file}`); return files[file]; }
};

// --- the fake `vscode` for the host parts -------------------------------------------------------
const warnings = [];
const answers = { warning: [], quickPick: [], input: [] };
const settings = { skillSources: ['acme/skills', 'not a repo', 'acme/skills'] };
let viewProvider;
const fileUri = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` });
const fakeVscode = {
  Uri: { file: fileUri, joinPath: (uri, ...parts) => fileUri(path.join(uri.fsPath, ...parts)) },
  workspace: {
    textDocuments: [],
    getConfiguration: () => ({
      get: key => key === 'studio.skillSources' ? settings.skillSources : undefined,
      update: async (key, value, target) => { assert.equal(key, 'studio.skillSources'); assert.equal(target, 1, 'kept in user settings'); settings.skillSources = value; }
    })
  },
  ConfigurationTarget: { Global: 1 },
  window: {
    showWarningMessage: async (message, options) => { warnings.push([message, options && options.detail]); return answers.warning.shift(); },
    showQuickPick: async (items, options) => { warnings.push(['pick', options.title, items.map(item => item.label), items.map(item => item.detail)]); const pick = answers.quickPick.shift(); return pick ? items.find(pick) : undefined; },
    showInputBox: async options => { const value = answers.input.shift(); if (value !== undefined && options.validateInput) { assert.equal(options.validateInput(value), undefined, `"${value}" was refused`); } return value; },
    registerWebviewViewProvider: (_id, provider) => { viewProvider = provider; return { dispose() {} }; }
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  authentication: { getSession: async () => undefined },
  lm: { selectChatModels: async () => [] }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const out = name => require(path.join(__dirname, '../../out/studio', name));
const { SkillLibrary, parseSkillRef, parseSkillFile, skillsPrompt, skillRef } = out('skills.js');
const { studioSkills, skillSources, parseSkillSource, GitHubSkillApi, GitHubRequestError } = out('githubSkills.js');
const { StudioChatProvider } = out('studioChat.js');
const { RunStore, WorkflowEngine, workflowSkills } = out('engine.js');
const { studioSteps } = out('registry.js');
const { validateWorkflow } = out('workflow.js');
const { draftPlan } = out('chatPlanner.js');
Module._load = originalLoad;

const steps = studioSteps();
const never = { cancelled: false };
const writeTests = skillRef('acme', 'skills', 'plugins/testing/skills/write-tests', commit);
const plainWords = skillRef('acme', 'skills', 'plugins/docs/skills/plain-words', commit);

async function main() {
  // ---- References and front matter.
  assert.deepEqual(parseSkillRef(writeTests), { owner: 'acme', repo: 'skills', folder: 'plugins/testing/skills/write-tests', commit, source: 'acme/skills' });
  assert.throws(() => parseSkillRef('github:acme/skills/write-tests@abc123'), /40-character commit/);
  assert.throws(() => parseSkillRef(`github:acme/skills/../secrets@${commit}`), /outside the repository/);
  assert.deepEqual(parseSkillFile('no front matter', 'fallback'), { name: 'fallback', description: '', body: 'no front matter' });
  assert.deepEqual(skillSources([writeTests, plainWords, 'nonsense']), ['acme/skills']);
  const sources = {
    'eurus-labs/skills': 'eurus-labs/skills',
    'https://github.com/eurus-labs/skills': 'eurus-labs/skills',
    'github.com/eurus-labs/skills.git': 'eurus-labs/skills',
    'https://github.com/eurus-labs/skills/tree/main/plugins': 'eurus-labs/skills',
    'git@github.com:eurus-labs/skills.git': 'eurus-labs/skills',
    // A GitHub Enterprise server (the URL a person pasted, 2026-11-13), and its other forms.
    'https://github.boschdevcloud.com/GON7HC/DSD-Skills': 'github.boschdevcloud.com/GON7HC/DSD-Skills',
    'github.boschdevcloud.com/GON7HC/DSD-Skills/tree/main': 'github.boschdevcloud.com/GON7HC/DSD-Skills',
    'git@GitHub.BoschDevCloud.com:GON7HC/DSD-Skills.git': 'github.boschdevcloud.com/GON7HC/DSD-Skills',
    // An Enterprise host is kept whole, www included; only github.com's www alias is github.com.
    'https://www.github.example.com/team/skills': 'www.github.example.com/team/skills',
    'https://www.github.com/eurus-labs/skills': 'eurus-labs/skills',
    'not a repo': undefined, '../x': undefined, 'a/b/c d': undefined, 'https://github.com/only-owner': undefined
  };
  for (const [text, expected] of Object.entries(sources)) { assert.equal(parseSkillSource(text), expected, text); }

  // ---- The listing: names and descriptions, scripts flagged, templates left out; cached per commit.
  const library = new SkillLibrary(path.join(base, 'cache'), api);
  const listed = await library.index('acme/skills');
  assert.equal(listed.commit, commit);
  assert.deepEqual(listed.skills.map(skill => [skill.name, skill.usesScripts, skill.ref]), [['write-tests', true, writeTests], ['plain-words', false, plainWords]]);
  assert.equal(listed.skills[0].description, 'Write tests that fail before the fix.');
  const fetched = { ...calls };
  assert.deepEqual((await library.index('acme/skills')).skills.map(skill => skill.name), ['write-tests', 'plain-words']);
  assert.equal(calls.tree, fetched.tree, 'a listed commit is not fetched again');
  assert.equal(calls.file, fetched.file);
  assert.deepEqual((await library.cachedIndex('acme/skills')).map(skill => skill.name), ['write-tests', 'plain-words'], 'the last listing is there offline');

  // A pinned skill reads from the cache, with the references of its folder.
  // Its scripts (cached by the listing without them) come with the first load, once (plan 6, Decision 7).
  const skill = await library.load(writeTests);
  assert.equal(calls.file, fetched.file + 1, 'the first load of a listed skill downloads its one script file');
  assert.deepEqual(skill.scripts, ['scripts/run.py']);
  assert.equal(skill.scriptsUnavailable, undefined);
  assert.equal(fs.readFileSync(path.join(skill.dir, 'scripts', 'run.py'), 'utf8'), 'print(1)', 'the script is cached at the pinned commit');
  assert.equal(path.basename(skill.dir), 'write-tests');
  const afterScripts = { ...calls };
  const again = await library.load(writeTests);
  assert.deepEqual(calls, afterScripts, 'a pinned, cached skill with its scripts needs no request');
  assert.deepEqual(again.scripts, ['scripts/run.py']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(skill.dir, 'skill.json'), 'utf8')).dir, undefined, 'the cache folder is not written into skill.json');
  assert.deepEqual((await library.load(plainWords)).scripts, [], 'a skill without a scripts folder has none');
  assert.deepEqual(Object.keys(skill.references).sort(), ['references/standard.md', 'references/unused.md']);
  // The source moved on: a listing shows the new commit; the pinned skill still reads the old one.
  head = newer;
  files['plugins/docs/skills/plain-words/SKILL.md'] = '---\nname: plain-words\ndescription: Shorter.\n---\nUse very short sentences.';
  assert.equal((await library.index('acme/skills')).skills[1].ref, skillRef('acme', 'skills', 'plugins/docs/skills/plain-words', newer));
  assert.equal((await library.load(plainWords)).body, 'Use short sentences.', 'a pin keeps the text it was pinned to');
  await assert.rejects(library.load(skillRef('acme', 'skills', 'plugins/none', commit)), /has no plugins\/none\/SKILL\.md/);

  // ---- The text a step sends: instructions, the references they name, within the budget.
  const text = skillsPrompt([skill, await library.load(plainWords)]);
  assert.match(text, /^Follow these skills for this step\./);
  assert.match(text, /### Skill: write-tests\n# Write tests/);
  assert.match(text, /#### write-tests: references\/standard\.md\nEvery test names/);
  assert.ok(!text.includes('Not named by the skill'), 'a reference the skill does not name is left out');
  assert.match(skillsPrompt([skill], 400), /Not included \(over the size limit\): write-tests/);
  // With run_skill_script offered, the line about scripts changes; without it, the old line stays (Decision 10).
  assert.match(text, /Scripts a skill mentions are not available: do their work yourself or say what is missing\./);
  const withTool = skillsPrompt([skill], undefined, true);
  assert.match(withTool, /Run a skill's scripts with run_skill_script \(skill, script path as its SKILL\.md writes it, args\); they run from the repository root/);
  assert.ok(!withTool.includes('are not available'), 'the old line is gone when the tool is offered');

  // ---- Scripts: limits keep the skill loadable but its scripts unavailable (Decision 7).
  {
    const big = (name, sizes, extra = {}) => {
      const tree = { [`plugins/${name}/SKILL.md`]: `---\nname: ${name}\n---\nRun scripts/a.py.`, ...extra };
      sizes.forEach((size, index) => { tree[`plugins/${name}/scripts/f${index}.py`] = 'x'.repeat(size); });
      return tree;
    };
    const tree = {
      ...big('many', Array.from({ length: 301 }, () => 1)),
      ...big('large', [2 * 1024 * 1024 + 1]),
      ...big('total', Array.from({ length: 11 }, () => 2_000_000)),
      ...big('fits', [2 * 1024 * 1024], { 'plugins/fits/scripts/sub/deep.sh': 'echo hi' }),
      'plugins/evil/SKILL.md': '---\nname: evil\n---\nbody', 'plugins/evil/scripts/../../escape.py': 'x'
    };
    const fetchedPaths = [];
    const limitApi = { headCommit: async () => commit, tree: async () => Object.keys(tree), file: async (_o, _r, _c, file) => { fetchedPaths.push(file); return tree[file]; } };
    const limited = new SkillLibrary(path.join(base, 'limit-cache'), limitApi);
    const ref = name => skillRef('acme', 'skills', `plugins/${name}`, commit);
    const many = await limited.load(ref('many'));
    assert.deepEqual([many.scripts, many.body], [[], 'Run scripts/a.py.'], 'over the file limit: the skill loads, its scripts do not');
    assert.match(many.scriptsUnavailable, /301 files.*at most 300/);
    assert.ok(!fetchedPaths.some(file => file.includes('/many/scripts/')), 'nothing is downloaded over the file limit');
    const large = await limited.load(ref('large'));
    assert.deepEqual(large.scripts, []);
    assert.match(large.scriptsUnavailable, /f0\.py is larger than 2 MB/);
    assert.equal(fs.existsSync(path.join(large.dir, 'scripts')), false, 'an unavailable skill leaves no script files to run');
    const total = await limited.load(ref('total'));
    assert.deepEqual(total.scripts, []);
    assert.match(total.scriptsUnavailable, /more than 20 MB/);
    assert.equal(fs.existsSync(path.join(total.dir, 'scripts')), false);
    const fits = await limited.load(ref('fits'));
    assert.deepEqual(fits.scripts, ['scripts/f0.py', 'scripts/sub/deep.sh'], 'sub-folders are kept; exactly 2 MB fits');
    assert.equal(fits.scriptsUnavailable, undefined);
    assert.equal(fs.readFileSync(path.join(fits.dir, 'scripts', 'sub', 'deep.sh'), 'utf8'), 'echo hi');
    const evil = await limited.load(ref('evil'));
    assert.deepEqual(evil.scripts, []);
    assert.match(evil.scriptsUnavailable, /not a plain path/);
    assert.equal(fs.existsSync(path.join(base, 'limit-cache', 'acme', 'skills', commit, 'plugins', 'escape.py')), false);
    // The reason is kept: a second load says the same without asking again.
    const asked = fetchedPaths.length;
    assert.match((await limited.load(ref('many'))).scriptsUnavailable, /at most 300/);
    assert.equal(fetchedPaths.length, asked);

    // A skill cached before this change has no `scripts` field: its scripts are downloaded on the next load.
    const old = new SkillLibrary(path.join(base, 'old-cache'), api);
    const folder = path.join(base, 'old-cache', 'acme', 'skills', commit, 'plugins/testing/skills/write-tests');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'skill.json'), JSON.stringify({ ref: writeTests, name: 'write-tests', description: 'd', usesScripts: true, body: 'old body', references: {} }));
    const upgraded = await old.load(writeTests);
    assert.equal(upgraded.body, 'old body', 'the cached text is kept');
    assert.deepEqual(upgraded.scripts, ['scripts/run.py']);
    assert.equal(fs.readFileSync(path.join(folder, 'scripts', 'run.py'), 'utf8'), 'print(1)');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'skill.json'), 'utf8')).scripts, ['scripts/run.py'], 'the upgrade is cached');

    // A download that fails (a network error) does not fail the skill, and is tried again next time.
    let fail = true;
    const flaky = new SkillLibrary(path.join(base, 'flaky-cache'), { ...api, file: async (o, r, c, file) => { if (fail && file.includes('/scripts/')) { throw new Error('offline'); } return api.file(o, r, c, file); } });
    const first = await flaky.load(writeTests);
    assert.deepEqual([first.scripts, first.body.startsWith('# Write tests')], [[], true]);
    assert.match(first.scriptsUnavailable, /could not be downloaded: offline/);
    fail = false;
    assert.deepEqual((await flaky.load(writeTests)).scripts, ['scripts/run.py']);

    // Offline with a skill cached before this change: it still loads (a prompt step needs no scripts), without them, and is retried.
    const offlineCache = path.join(base, 'offline-cache');
    const offlineFolder = path.join(offlineCache, 'acme', 'skills', commit, 'plugins/testing/skills/write-tests');
    fs.mkdirSync(offlineFolder, { recursive: true });
    fs.writeFileSync(path.join(offlineFolder, 'skill.json'), JSON.stringify({ ref: writeTests, name: 'write-tests', description: 'd', usesScripts: true, body: 'cached body', references: {} }));
    let online = false;
    const offline = new SkillLibrary(offlineCache, { ...api, tree: async () => { if (!online) { throw new Error('GitHub did not answer in time.'); } return api.tree(); } });
    const cachedOffline = await offline.load(writeTests);
    assert.deepEqual([cachedOffline.body, cachedOffline.scripts], ['cached body', []]);
    assert.match(cachedOffline.scriptsUnavailable, /its scripts could not be listed: GitHub did not answer in time\./);
    assert.equal('scripts' in JSON.parse(fs.readFileSync(path.join(offlineFolder, 'skill.json'), 'utf8')), false, 'a failed lookup is not kept');
    online = true;
    assert.deepEqual((await offline.load(writeTests)).scripts, ['scripts/run.py']);
  }

  // ---- Validation: pinned references, steps that use a model, at most five.
  const flow = nodes => ({ schema: 'repository-manager/workflow@1', id: 'w', version: '1', title: 'W', prompts: { p: { instructions: 'Do it.' } }, nodes });
  assert.deepEqual(validateWorkflow(flow([{ id: 'a', type: 'prompt', prompt: 'p', skills: [writeTests], with: { input: 'x' } }]), steps), []);
  const messages = nodes => validateWorkflow(flow(nodes), steps).map(problem => problem.message).join(' | ');
  assert.match(messages([{ id: 'a', type: 'prompt', prompt: 'p', skills: ['write-tests'], with: { input: 'x' } }]), /Skills are a list of references/);
  assert.match(messages([{ id: 'a', type: 'gate', skills: [writeTests], with: { title: 'x' } }]), /"gate" does not use a model, so it cannot follow skills/);
  assert.match(messages([{ id: 'a', type: 'prompt', prompt: 'p', skills: Array.from({ length: 6 }, (_, index) => skillRef('acme', 'skills', `s${index}`, commit)), with: { input: 'x' } }]), /At most 5 skills/);

  // ---- A prompt step sends its skills before its instructions; a skill that cannot be read fails the step.
  {
    const prompts = [];
    const model = { complete: async prompt => { prompts.push(prompt); return { text: '{"ok": true}', model: 'Scripted' }; } };
    const engine = new WorkflowEngine({ root: base, steps, store: new RunStore(path.join(base, 'runs')), model, skills: library });
    const workflow = flow([{ id: 'a', type: 'prompt', prompt: 'p', skills: [writeTests], with: { input: 'data' } }]);
    assert.deepEqual(workflowSkills(workflow), [writeTests]);
    const state = await engine.continue(workflow, await engine.start(workflow, 'h', {}), never);
    assert.equal(state.status, 'done');
    assert.ok(prompts[0].indexOf('### Skill: write-tests') < prompts[0].indexOf('Do it.'), 'skills come before the instructions');
    const log = await new RunStore(path.join(base, 'runs')).readLog(state.id);
    assert.deepEqual(log.find(entry => entry.type === 'skills').skills, [writeTests]);
    const missing = flow([{ id: 'a', type: 'prompt', prompt: 'p', skills: [skillRef('acme', 'skills', 'plugins/none', commit)], with: { input: 'data' } }]);
    const failed = await engine.continue(missing, await engine.start(missing, 'h', {}), never);
    assert.match(failed.error, /^a: A skill could not be read: acme\/skills has no plugins\/none\/SKILL\.md/);
    assert.equal(prompts.length, 1, 'nothing was sent for the failed step');
  }

  // ---- The planner: told the skills it may use; one it invents is a problem.
  {
    const offered = (await library.cachedIndex('acme/skills'));
    const invented = skillRef('acme', 'skills', 'plugins/invented', commit);
    const reply = skills => ({ reply: 'Plan.', workflow: { title: 'T', criteria: ['c'], prompts: { p: { instructions: 'Do it.' } }, nodes: [{ id: 'a', type: 'prompt', prompt: 'p', skills, with: { input: 'x' } }] } });
    const prompts = [];
    const script = [reply([invented]), reply([invented])];
    const model = { complete: async prompt => { prompts.push(prompt); return { text: JSON.stringify(script.shift()), model: 'Scripted' }; } };
    const draft = await draftPlan(model, steps, { message: 'Plan it', history: [], skills: offered }, never);
    assert.match(prompts[0], new RegExp(`Available skills:\\n- ${offered[0].ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: write-tests\\. .*\\(its scripts run only in a code step, after the person approves it\\)`));
    assert.doesNotMatch(prompts[0], /not run here/, 'with the setting on, the planner is not told the scripts are not run');
    assert.match(prompts[1], /is not one of the available skills/, 'the repair turn names the invented skill');
    assert.ok(draft.problems.some(problem => /is not one of the available skills/.test(problem.message)));
    const kept = await draftPlan({ complete: async () => ({ text: JSON.stringify(reply([offered[1].ref])), model: 'S' }) }, steps, { message: 'Plan it', history: [], skills: offered }, never);
    assert.deepEqual(kept.problems, []);
    // With the setting `off` the caller says so, and the planner is told they are not run.
    const offPrompts = [];
    await draftPlan({ complete: async prompt => { offPrompts.push(prompt); return { text: JSON.stringify(reply(undefined)), model: 'S' }; } }, steps, { message: 'Plan it', history: [], skills: offered, scriptsOff: true }, never);
    assert.match(offPrompts[0], /write-tests\. .*\(its scripts are not run here\)/);
    const none = [];
    await draftPlan({ complete: async prompt => { none.push(prompt); return { text: JSON.stringify(reply(undefined)), model: 'S' }; } }, steps, { message: 'x', history: [] }, never);
    assert.match(none[0], /No skills are available: do not add "skills"\./);
  }

  // ---- GitHub sign-in: an existing session is used silently; public repositories need none; a
  // ---- refusal asks once, and a Cancel is not asked again (the dialog kept coming back).
  {
    const asked = [];
    const auth = (silentToken, answer) => ({ getSession: async (_provider, _scopes, options) => {
      asked.push(options.silent ? 'silent' : 'dialog');
      if (options.silent) { return silentToken ? { accessToken: silentToken } : undefined; }
      if (answer === 'cancel') { throw new Error('User did not consent to login.'); }
      return { accessToken: answer };
    } });
    const fetched = [];
    // A public repository answers anyone; a private one only a token.
    const fetch = async (url, token) => {
      fetched.push([url.replace('https://api.github.com/', ''), token]);
      if (/\/acme\/private(\/|$|\?)/.test(url) && !token) { throw new GitHubRequestError('GitHub answered 404 (not found, or your GitHub account cannot see it).', 404); }
      if (url.endsWith('/commits/main')) { return JSON.stringify({ sha: commit }); }
      if (url.includes('/git/trees/')) { return JSON.stringify({ tree: Object.keys(files).map(file => ({ path: file, type: 'blob' })) }); }
      if (url.includes('/contents/')) { return files[decodeURIComponent(url.split('/contents/')[1].split('?')[0])]; }
      return JSON.stringify({ default_branch: 'main' });
    };

    const publicApi = new GitHubSkillApi(fetch, auth(undefined, 'cancel'));
    const listed = await new SkillLibrary(path.join(base, 'public-cache'), publicApi).index('acme/skills');
    assert.equal(listed.skills.length, 2);
    assert.deepEqual(asked, ['silent'], 'a public repository is read without asking to sign in');
    assert.ok(fetched.every(([, token]) => token === undefined));

    asked.length = 0; fetched.length = 0;
    const cancelled = new GitHubSkillApi(fetch, auth(undefined, 'cancel'));
    const library = new SkillLibrary(path.join(base, 'private-cache'), cancelled);
    await assert.rejects(library.index('acme/private'), /404.*If the repository is private, sign in: Manage Skill Sources → Sign in to github\.com\./);
    await assert.rejects(library.index('acme/private'), /404/);
    await assert.rejects(Promise.all([cancelled.tree('acme', 'private', commit), cancelled.file('acme', 'private', commit, 'a')]), /404/);
    assert.deepEqual(asked, ['silent', 'dialog'], 'Cancel is remembered: one dialog for all those requests');

    // Signing in when the person asks (Manage Skill Sources) works after a Cancel.
    const later = new GitHubSkillApi(fetch, { getSession: async (_p, _s, options) => { asked.push(options.silent ? 'silent' : 'dialog'); return options.silent ? undefined : { accessToken: 'tok' }; } });
    asked.length = 0; fetched.length = 0;
    assert.equal((await later.headCommit('acme', 'private')), commit);
    assert.deepEqual(asked, ['silent', 'dialog']);
    assert.deepEqual(fetched.map(([, token]) => token), [undefined, 'tok', 'tok'], 'refused once, then read with the token from then on');
    asked.length = 0;
    await later.tree('acme', 'private', commit);
    assert.deepEqual(asked, [], 'signed in: no more questions');
    assert.equal(await cancelled.signIn(false), undefined, 'not asked again by itself');
    const forced = new GitHubSkillApi(fetch, auth(undefined, 'tok2'));
    await assert.rejects(new GitHubSkillApi(fetch, auth(undefined, 'cancel')).signIn(false).then(token => { if (token) { throw new Error('signed in'); } throw new Error('declined'); }), /declined/);
    assert.equal(await forced.signIn(true), 'tok2');

    // A token that is no longer valid (signed out and in again, or replaced) is not sent again:
    // the current session is looked up silently and the request retried with it.
    {
      const sessions = ['old', 'new'];
      const silentAsked = [];
      const rotating = new GitHubSkillApi(async (url, token) => {
        if (token === 'old') { throw new GitHubRequestError('GitHub answered 401.', 401); }
        return JSON.stringify(url.endsWith('/commits/main') ? { sha: commit } : { default_branch: 'main' });
      }, { getSession: async (_p, _s, options) => { silentAsked.push(options.silent ? 'silent' : 'dialog'); return options.silent ? { accessToken: sessions.shift() } : undefined; } });
      assert.equal(await rotating.headCommit('acme', 'skills'), commit);
      assert.deepEqual(silentAsked, ['silent', 'silent'], 'looked again silently, no dialog');
      // Signed out: a public repository is still read, without a token.
      const tokens = [];
      const signedOut = new GitHubSkillApi(async (url, token) => {
        tokens.push(token);
        if (token === 'gone') { throw new GitHubRequestError('GitHub answered 401.', 401); }
        return JSON.stringify(url.endsWith('/commits/main') ? { sha: commit } : { default_branch: 'main' });
      }, { getSession: async (_p, _s, options) => options.silent ? (tokens.length ? undefined : { accessToken: 'gone' }) : undefined });
      assert.equal(await signedOut.headCommit('acme', 'skills'), commit);
      assert.deepEqual(tokens, ['gone', undefined, undefined]);
      // VS Code's sessions changed: the next request looks again (a Cancel stays remembered).
      const looks = [];
      const watched = new GitHubSkillApi(async url => JSON.stringify(url.endsWith('/commits/main') ? { sha: commit } : { default_branch: 'main' }),
        { getSession: async (_p, _s, options) => { looks.push(options.silent); return { accessToken: `t${looks.length}` }; } });
      await watched.headCommit('acme', 'skills');
      await watched.headCommit('acme', 'skills');
      watched.forgetSessions();
      await watched.headCommit('acme', 'skills');
      assert.equal(looks.length, 2, 'looked up once, then again after the sessions changed');
    }

    // A session already there is used, silently, from the first request.
    asked.length = 0; fetched.length = 0;
    const existing = new GitHubSkillApi(fetch, auth('mine', 'cancel'));
    await existing.headCommit('acme', 'private');
    assert.deepEqual(asked, ['silent']);
    assert.ok(fetched.every(([, token]) => token === 'mine'));
  }

  // ---- A GitHub Enterprise server: its API under /api/v3, its own sign-in, its host in refs and the cache.
  {
    const host = 'github.boschdevcloud.com';
    assert.deepEqual(parseSkillRef(skillRef('GON7HC', 'DSD-Skills', 'skills/review', commit, host)),
      { host, owner: 'GON7HC', repo: 'DSD-Skills', folder: 'skills/review', commit, source: `${host}/GON7HC/DSD-Skills` });
    assert.equal(parseSkillRef(`github:acme/skills/plugins/x@${commit}`).host, undefined, 'an owner is never read as a host');
    const asked = [];
    const urls = [];
    const fetch = async (url, token) => {
      urls.push(url);
      if (!token) { throw new GitHubRequestError('GitHub answered 404 (not found, or your GitHub account cannot see it).', 404); }
      if (url.endsWith('/commits/main')) { return JSON.stringify({ sha: commit }); }
      if (url.includes('/git/trees/')) { return JSON.stringify({ tree: [{ path: 'skills/review/SKILL.md', type: 'blob' }] }); }
      if (url.includes('/contents/')) { return '---\nname: dsd-review\ndescription: Team review.\n---\nReview it.'; }
      return JSON.stringify({ default_branch: 'main' });
    };
    const auth = { getSession: async (provider, _scopes, options) => { asked.push(`${provider}:${options.silent ? 'silent' : 'dialog'}`); return options.silent ? undefined : { accessToken: 'ghe-token' }; } };
    const api = new GitHubSkillApi(fetch, auth, () => host);
    const library = new SkillLibrary(path.join(base, 'ghe-cache'), api);
    const listed = await library.index(`${host}/GON7HC/DSD-Skills`);
    assert.deepEqual(listed.skills.map(skill => [skill.name, skill.ref]), [['dsd-review', `github:${host}/GON7HC/DSD-Skills/skills/review@${commit}`]]);
    assert.ok(urls.every(url => url.startsWith(`https://${host}/api/v3/repos/GON7HC/DSD-Skills`)), urls.join('\n'));
    assert.deepEqual(asked, ['github-enterprise:silent', 'github-enterprise:dialog'], 'the Enterprise account, asked once');
    assert.ok(fs.existsSync(path.join(base, 'ghe-cache', host, 'GON7HC', 'DSD-Skills', commit, 'index.json')));
    assert.deepEqual((await library.cachedIndex(`${host}/GON7HC/DSD-Skills`)).map(skill => skill.name), ['dsd-review']);
    assert.equal((await library.load(listed.skills[0].ref)).body, 'Review it.');
    // VS Code's Enterprise sign-in set up for another server (or none): the person is offered to set
    // it up for this one (the 401 a person hit, 2026-11-13). Declined: no sign-in dialog, the way to
    // do it later, and not offered again by itself.
    asked.length = 0;
    const offers = [];
    const unset = new GitHubSkillApi(fetch, auth, () => undefined, async offered => { offers.push(offered); return false; });
    await assert.rejects(unset.headCommit('GON7HC', 'DSD-Skills', host), /needs a sign-in: Manage Skill Sources → Sign in to github\.boschdevcloud\.com sets up VS Code's GitHub Enterprise sign-in for it/);
    await assert.rejects(unset.tree('GON7HC', 'DSD-Skills', commit, host), /needs a sign-in/);
    assert.deepEqual(offers, [host], 'offered once');
    assert.deepEqual(asked, [], 'no sign-in dialog without the setup');
    assert.equal(await unset.signIn(true, host), undefined);
    assert.deepEqual(offers, [host, host], 'Manage Skill Sources → Sign in offers it again');
    // Accepted: the setting is set, then the Enterprise account signs in and the repository is read.
    asked.length = 0; urls.length = 0;
    let configured;
    const setUp = new GitHubSkillApi(fetch, auth, () => configured, async offered => { configured = offered; return true; });
    assert.equal(await setUp.headCommit('GON7HC', 'DSD-Skills', host), commit);
    assert.equal(configured, host);
    assert.deepEqual(asked, ['github-enterprise:dialog'], 'signed in with the Enterprise account right after the setup');
    assert.ok(urls.slice(-1)[0].startsWith(`https://${host}/api/v3/`));
    // Validation takes an Enterprise ref like any other.
    assert.deepEqual(validateWorkflow({ schema: 'repository-manager/workflow@1', id: 'w', version: '1', title: 'W', prompts: { p: { instructions: 'x' } },
      nodes: [{ id: 'a', type: 'prompt', prompt: 'p', skills: [listed.skills[0].ref], with: { input: 'x' } }] }, steps), []);
  }

  // ---- The host: sources from the setting, trust asked once per source.
  const memento = () => { const values = new Map(); return { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } }; };
  const context = { subscriptions: [], extensionUri: fileUri(path.resolve(__dirname, '../..')), storageUri: fileUri(path.join(base, 'storage')), globalStorageUri: fileUri(path.join(base, 'global')), globalState: memento(), workspaceState: memento() };
  const service = studioSkills(context, api);
  assert.deepEqual(service.sources(), ['acme/skills'], 'invalid and repeated entries are dropped');
  answers.warning.push(undefined);
  assert.equal(await service.ensureTrusted(['acme/skills']), false, 'declined');
  answers.warning.push('Trust Skills');
  assert.equal(await service.ensureTrusted(['acme/skills']), true);
  const asked = warnings.length;
  assert.equal(await service.ensureTrusted(['acme/skills']), true);
  assert.equal(warnings.length, asked, 'trusted once, not asked again');
  assert.match(warnings[asked - 1][1], /Its scripts run only in a code step you approve, in a container when Docker or Podman is available and otherwise directly on this machine, not isolated/);

  // ---- "+ Skill" on the chat's plan card: listed, picked, pinned; names on the card.
  {
    const posted = [];
    const runs = { steps, skills: service, run: async () => undefined };
    StudioChatProvider.register(context, runs, base);
    let listener;
    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    const receive = async message => { listener(message); await settle(); };
    viewProvider.resolveWebviewView({ webview: { options: {}, html: '', cspSource: 'c', asWebviewUri: uri => uri, postMessage: async message => { posted.push(message); }, onDidReceiveMessage: fn => { listener = fn; } } });
    await receive({ type: 'ready' });
    const conversation = viewProvider.conversation;
    conversation.plan = { schema: 'repository-manager/workflow@1', id: 'p', version: '0.1.0', title: 'P', criteria: ['c'], prompts: { p: { instructions: 'Do it.' } }, nodes: [{ id: 'a', type: 'prompt', prompt: 'p', with: { input: 'x' } }] };
    conversation.messages.push({ id: 'm1', role: 'assistant', text: 'Plan.', at: '', draft: { workflow: conversation.plan, problems: [], status: 'current' } });
    // + Skill asks where the skills come from first: each source, or a repository added now.
    answers.quickPick.push(item => item.label === 'acme/skills', item => item.label === 'write-tests');
    await receive({ type: 'addSkill', id: 'a' });
    const sourcePick = warnings.find(entry => entry[0] === 'pick' && entry[1] === 'Skills from');
    assert.deepEqual(sourcePick[2], ['acme/skills', '$(add) Add a GitHub repository…'], 'one source: no "All sources"');
    const ref = viewProvider.conversation.plan.nodes[0].skills[0];
    assert.equal(ref, skillRef('acme', 'skills', 'plugins/testing/skills/write-tests', newer), 'pinned to the commit listed now');
    const last = posted[posted.length - 1];
    assert.equal(last.messages[0].draft.view.steps[0].skills[0], ref);
    assert.deepEqual(last.skills[ref], { name: 'write-tests', usesScripts: true });
    // The picker says what a skill's scripts do on this step: not run on a prompt step; run after approval on a code step.
    const skillPick = title => warnings.filter(entry => entry[0] === 'pick' && entry[1] === title).pop()[3][0];
    assert.match(skillPick('Add a skill to "a"'), /uses scripts: this step type has no tools, so they are not run here; use a code step$/);
    viewProvider.conversation.plan.nodes.push({ id: 'c', type: 'code', title: 'Change it', with: { task: 'Change', paths: ['src/'] } });
    answers.quickPick.push(item => item.label === 'acme/skills', item => item.label === 'write-tests');
    await receive({ type: 'addSkill', id: 'c' });
    assert.match(skillPick('Add a skill to "Change it"'), /uses scripts: run in this step after your approval \(in a container when Docker or Podman is available, else directly on this machine\)$/);
    assert.equal(last.scriptRunner, null, 'no runner known without the host\'s probe');
    viewProvider.conversation.plan.nodes.pop();
    // Picking nothing changes nothing; a step that is gone is said.
    answers.quickPick.push(item => item.label === 'acme/skills');
    await receive({ type: 'addSkill', id: 'a' });
    assert.equal(viewProvider.conversation.plan.nodes[0].skills.length, 1);
    await receive({ type: 'addSkill', id: 'gone' });
    assert.match(posted[posted.length - 1].notice, /no longer in the plan/);

    // Add a repository from + Skill: its URL is enough; it is trusted first, then kept in the setting.
    answers.quickPick.push(item => item.add);
    answers.input.push('https://github.com/other-org/team-skills.git');
    answers.warning.push(undefined);
    await receive({ type: 'addSkill', id: 'a' });
    assert.deepEqual(settings.skillSources, ['acme/skills', 'not a repo', 'acme/skills'], 'a repository not trusted is not added');
    assert.match(warnings[warnings.length - 1][0], /Use skills from github\.com\/other-org\/team-skills\?/);
    answers.quickPick.push(item => item.add);
    answers.input.push('other-org/team-skills');
    answers.warning.push('Trust Skills');
    head = commit;
    await receive({ type: 'addSkill', id: 'a' });
    assert.deepEqual(settings.skillSources, ['acme/skills', 'other-org/team-skills']);
    // Two sources: "All sources" is offered.
    answers.quickPick.push(undefined);
    await receive({ type: 'addSkill', id: 'a' });
    assert.deepEqual(warnings.filter(entry => entry[1] === 'Skills from').pop()[2], ['acme/skills', 'other-org/team-skills', 'All sources', '$(add) Add a GitHub repository…']);
    // Manage Skill Sources removes one.
    answers.quickPick.push(item => item.source === 'other-org/team-skills');
    await viewProvider.manageSkillSources(); await settle();
    assert.deepEqual(settings.skillSources, ['acme/skills']);
    assert.match(posted[posted.length - 1].notice, /Removed other-org\/team-skills\. Skills already on a plan keep working/);
  }

  console.log('Studio skills smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(base, { recursive: true, force: true }));
