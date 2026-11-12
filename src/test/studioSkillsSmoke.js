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
    showQuickPick: async (items, options) => { warnings.push(['pick', options.title, items.map(item => item.label)]); const pick = answers.quickPick.shift(); return pick ? items.find(pick) : undefined; },
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
const { studioSkills, skillSources, parseSkillSource } = out('githubSkills.js');
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
  assert.deepEqual(['eurus-labs/skills', 'https://github.com/eurus-labs/skills', 'github.com/eurus-labs/skills.git', 'https://github.com/eurus-labs/skills/tree/main/plugins', 'git@github.com:eurus-labs/skills.git', 'not a repo', '../x', 'a/b/c d'].map(parseSkillSource),
    ['eurus-labs/skills', 'eurus-labs/skills', 'eurus-labs/skills', 'eurus-labs/skills', 'eurus-labs/skills', undefined, undefined, undefined]);

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
  const skill = await library.load(writeTests);
  assert.equal(calls.file, fetched.file, 'a pinned, cached skill needs no request');
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
    assert.match(prompts[0], new RegExp(`Available skills:\\n- ${offered[0].ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: write-tests\\. .*\\(its scripts are not run here\\)`));
    assert.match(prompts[1], /is not one of the available skills/, 'the repair turn names the invented skill');
    assert.ok(draft.problems.some(problem => /is not one of the available skills/.test(problem.message)));
    const kept = await draftPlan({ complete: async () => ({ text: JSON.stringify(reply([offered[1].ref])), model: 'S' }) }, steps, { message: 'Plan it', history: [], skills: offered }, never);
    assert.deepEqual(kept.problems, []);
    const none = [];
    await draftPlan({ complete: async prompt => { none.push(prompt); return { text: JSON.stringify(reply(undefined)), model: 'S' }; } }, steps, { message: 'x', history: [] }, never);
    assert.match(none[0], /No skills are available: do not add "skills"\./);
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
  assert.match(warnings[asked - 1][1], /Its scripts are never run here/);

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
