const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'vscode') return {};
  return originalLoad.call(this, name, parent, isMain);
};
const { parseReviewSkill, selectReviewSkills, MAX_SKILL_CHARS } = require('../../out/services/reviewSkills.js');
const { matchesReviewPattern } = require('../../out/services/reviewSurveyService.js');
const { ReviewSkillStore } = require('../../out/reviewSkillStore.js');
const { SecurityReviewProvider, INITIAL_UNIT_CHARS } = require('../../out/services/securityReviewProvider.js');
const { SecurityReviewService } = require('../../out/services/securityReviewService.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { ReviewUnitCache } = require('../../out/reviewUnitCache.js');
const { assessReadiness, renderReviewMarkdown } = require('../../out/services/reviewReport.js');
const { ReviewController } = require('../../out/reviewController.js');
const { ReviewHistoryStore } = require('../../out/reviewHistory.js');
Module._load = originalLoad;

const bundledDir = path.join(__dirname, '..', '..', 'resources', 'review-skills');
function memento() {
  const state = new Map();
  return { get: key => state.get(key), update: async (key, value) => { state.set(key, JSON.parse(JSON.stringify(value))); } };
}
const skillText = (id, extra = {}) => `---
id: ${id}
name: ${extra.name || id}
category: ${extra.category || 'security'}
appliesTo: ${extra.appliesTo || '["**/*.py"]'}
---
${extra.guidance || `- Check ${id}.`}
`;

async function main() {
  // 1. Parsing: a skill file is a header and guidance; mistakes come back as messages to show.
  assert.match(parseReviewSkill('no header', 'imported'), /header/);
  assert.match(parseReviewSkill(skillText('A_bad'), 'imported'), /id must be/);
  assert.match(parseReviewSkill(skillText('ok-id', { category: 'style' }), 'imported'), /category/);
  assert.match(parseReviewSkill(skillText('ok-id', { appliesTo: '*.py' }), 'imported'), /JSON array/);
  assert.match(parseReviewSkill(skillText('ok-id', { appliesTo: '[]' }), 'imported'), /non-empty/);
  assert.match(parseReviewSkill('---\nid: ok-id\n---\n  \n', 'imported'), /no guidance/);
  assert.match(parseReviewSkill(skillText('ok-id', { guidance: 'x'.repeat(6001) }), 'imported'), /under 6000/);
  const parsed = parseReviewSkill(`﻿${skillText('py-extra', { name: 'Python extra' })}`.replace(/\n/g, '\r\n'), 'imported');
  assert.equal(typeof parsed, 'object', 'a BOM or CRLF file was rejected');
  assert.deepEqual([parsed.id, parsed.name, parsed.appliesTo], ['py-extra', 'Python extra', ['**/*.py']]);

  // 2. Every bundled skill parses; clean code is the one quality skill.
  const files = fs.readdirSync(bundledDir).filter(name => name.endsWith('.md'));
  for (const name of files) {
    const skill = parseReviewSkill(fs.readFileSync(path.join(bundledDir, name), 'utf8'), 'bundled');
    assert.equal(typeof skill, 'object', `${name}: ${skill}`);
    assert.equal(`${skill.id}.md`, name, 'a bundled file is named after its id');
    assert.ok(skill.references, `${name} names no references`);
    // The parser cuts references at 300 characters; a bundled skill must not lose any.
    assert.ok(/^references: (.*)$/m.exec(fs.readFileSync(path.join(bundledDir, name), 'utf8'))[1].length <= 300, `${name} references are cut`);
  }
  const store = new ReviewSkillStore(bundledDir, memento());
  const bundled = store.snapshot().skills;
  assert.equal(bundled.length, files.length);
  assert.deepEqual(bundled.filter(skill => skill.category === 'quality').map(skill => skill.id), ['clean-code']);

  // 3. Selection follows the globs and the categories reviewed.
  const ids = (paths, categories, disabled = new Set()) => selectReviewSkills(bundled, paths, categories, disabled).skills.map(skill => skill.id).sort();
  const python = ids(['app/views.py'], ['security', 'compliance']);
  assert.ok(python.includes('python-security') && python.includes('secrets-crypto'));
  assert.ok(!python.includes('javascript-security') && !python.includes('ci-supply-chain') && !python.includes('clean-code'));
  assert.ok(ids(['.github/workflows/ci.yml'], ['security']).includes('ci-supply-chain'));
  assert.ok(ids(['infra/main.tf'], ['security']).includes('cloud-iac'));
  assert.ok(ids(['web/app.ts'], ['security']).includes('javascript-security'));
  for (const file of ['src/parser.cpp', 'include/parser.hpp', 'lib/io.c', 'core/buffer.hh']) {
    const cpp = ids([file], ['security', 'quality']);
    assert.ok(cpp.includes('cpp-security') && cpp.includes('injection-sinks') && cpp.includes('clean-code'), `${file}: ${cpp}`);
  }
  assert.ok(!ids(['app/views.py'], ['security']).includes('cpp-security'));
  // Globs ignore case for skills (Auth.java is an auth file), but policy scopes stay case-sensitive.
  assert.ok(ids(['src/Auth.java'], ['security']).includes('web-auth-session'));
  assert.ok(ids(['src/SessionManager.cs'], ['security']).includes('web-auth-session'));
  assert.equal(matchesReviewPattern('**/*auth*.*', 'src/Auth.java'), false, 'policy matching became case-insensitive');
  // Front-end views are not server handlers; SAM templates, manifests and C++ builds have their skills.
  assert.ok(!ids(['web/src/views/Home.vue'], ['security']).includes('web-auth-session'));
  assert.ok(ids(['web/src/views/Home.vue'], ['security', 'quality']).includes('injection-sinks'));
  assert.ok(ids(['infra/template.yaml'], ['security']).includes('cloud-iac'));
  assert.ok(ids(['deploy/manifests/api.yaml'], ['security']).includes('cloud-iac'));
  assert.ok(ids(['CMakeLists.txt'], ['security']).includes('ci-supply-chain'));
  // The general sink list names kinds of sink; the APIs are in one language skill each, so the
  // same line is not reported twice in different words.
  const guidanceOf = id => bundled.find(skill => skill.id === id).guidance;
  for (const api of ['shell=True', 'pickle', 'yaml.load', 'innerHTML', 'dangerouslySetInnerHTML', 'os.system']) {
    assert.ok(!guidanceOf('injection-sinks').includes(api), `injection-sinks still names ${api}`);
  }
  for (const id of ['python-security', 'javascript-security']) assert.ok(!/verify=False|rejectUnauthorized/.test(guidanceOf(id)), `${id} repeats TLS checks`);
  assert.ok(!/bcrypt|Argon2/.test(guidanceOf('web-auth-session')), 'password hashing is in two skills');
  // When skills do not all fit, security goes first and clean code gives way, never secrets or auth.
  const mixed = selectReviewSkills(bundled, ['app.py', 'Dockerfile', 'package.json', 'server.js', '.github/workflows/ci.yml', 'main.tf'],
    ['security', 'compliance', 'quality'], new Set());
  assert.ok(mixed.omitted.length > 0, 'the mixed component no longer tests the cap');
  for (const id of ['secrets-crypto', 'web-auth-session', 'injection-sinks']) assert.ok(mixed.skills.some(skill => skill.id === id), `${id} was left out`);
  assert.ok(mixed.omitted.includes('clean-code'), 'clean code was kept over a security skill');
  // A C++ component gets every matching skill: together they fit in one request.
  assert.deepEqual(selectReviewSkills(bundled, ['src/parser.cpp'], ['security', 'quality'], new Set()).omitted, []);
  assert.ok(ids(['app/views.py'], ['security', 'quality']).includes('clean-code'), 'clean code was not added when asked');
  assert.deepEqual(ids(['app/views.py'], ['quality']), ['clean-code'], 'a security skill ran in a quality-only review');
  assert.ok(!ids(['app/views.py'], ['security'], new Set(['python-security'])).includes('python-security'), 'a disabled skill was applied');
  assert.equal(selectReviewSkills(bundled, ['README.md'], ['compliance'], new Set()).hash, '', 'nothing applied should leave the cache key unchanged');

  // The guidance per component is capped; what does not fit is named, not silently dropped.
  const big = n => parseReviewSkill(skillText(`big-${n}`, { guidance: 'y'.repeat(3000) }), 'bundled');
  const capped = selectReviewSkills([big(1), big(2), big(3)], ['a.py'], ['security'], new Set());
  assert.deepEqual(capped.skills.map(skill => skill.id), ['big-1', 'big-2']);
  assert.deepEqual(capped.omitted, ['big-3']);
  assert.ok(capped.skills.reduce((sum, skill) => sum + skill.guidance.length, 0) <= MAX_SKILL_CHARS);
  // Changing the guidance changes the hash, so a saved component is not reused with other skills.
  const changed = parseReviewSkill(skillText('big-1', { guidance: 'z'.repeat(3000) }), 'bundled');
  assert.notEqual(selectReviewSkills([changed], ['a.py'], ['security'], new Set()).hash,
    selectReviewSkills([big(1)], ['a.py'], ['security'], new Set()).hash);
  const renamed = { ...big(1), name: 'Another name' };
  assert.notEqual(selectReviewSkills([renamed], ['a.py'], ['security'], new Set()).hash,
    selectReviewSkills([big(1)], ['a.py'], ['security'], new Set()).hash, 'the name the model sees is not in the hash');

  // 4. The store: import (replacing a bundled id), turn off, remove; bounded.
  const state = memento();
  const user = new ReviewSkillStore(bundledDir, state);
  assert.match(await user.import('nope'), /header/);
  const imported = await user.import(skillText('python-security', { name: 'Team Python', guidance: '- Team rule.' }));
  assert.equal(imported.name, 'Team Python');
  let listed = user.list();
  assert.equal(listed.filter(skill => skill.id === 'python-security').length, 1, 'an import did not replace the bundled skill');
  assert.equal(listed.find(skill => skill.id === 'python-security').source, 'imported');
  await user.setEnabled('cloud-iac', false);
  assert.equal(user.list().find(skill => skill.id === 'cloud-iac').enabled, false);
  assert.ok(user.snapshot().disabled.has('cloud-iac'));
  await user.setEnabled('cloud-iac', true);
  assert.equal(user.list().find(skill => skill.id === 'cloud-iac').enabled, true);
  await user.remove('python-security');
  assert.equal(user.list().find(skill => skill.id === 'python-security').source, 'bundled', 'removing the import did not restore the bundled skill');
  for (let i = 0; i < 30; i++) assert.equal(typeof await user.import(skillText(`team-${i}`)), 'object');
  assert.match(await user.import(skillText('team-30')), /At most 30/);
  assert.equal(typeof await user.import(skillText('team-3', { guidance: '- Updated.' })), 'object', 'replacing an import counted against the limit');
  // Clean code (the quality category) is on while a quality skill is: the skill's switch is the only one.
  assert.equal(user.includeQuality(), true, 'the bundled clean code skill did not turn quality on');
  await user.setEnabled('clean-code', false);
  assert.equal(new ReviewSkillStore(bundledDir, state).includeQuality(), false);
  await user.setEnabled('clean-code', true);
  // A missing folder is no skills, not a crash.
  assert.deepEqual(new ReviewSkillStore(path.join(bundledDir, 'missing')).list(), []);

  // 5. The engine: matching skills reach the model per component, the report names them, and
  // clean code findings are capped at medium and never block.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-skills-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    fs.mkdirSync(path.join(repo, 'api'));
    fs.mkdirSync(path.join(repo, 'web'));
    fs.writeFileSync(path.join(repo, 'api', 'run.py'), 'def run(a, b, c, d, e, f, g):\n    return eval(a)\n');
    fs.writeFileSync(path.join(repo, 'web', 'app.js'), 'document.body.innerHTML = location.hash;\n');
    // A component as large as the first request allows: skills must not push it past the model's limit.
    fs.mkdirSync(path.join(repo, 'big'));
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(repo, 'big', `m${i}.py`), `${'x = 1  # filler line of source code here...........\n'.repeat(300)}`);
    git('add', '-A');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.org', 'commit', '-qm', 'two components');
    const target = git('rev-parse', 'HEAD');
    const sent = {};
    const sizes = {};
    const model = { id: 'mock', version: '1', name: 'Mock', maxInputTokens: 100000,
      countTokens: async value => Math.ceil(value.length / 4),
      async sendRequest(messages) {
        if (messages[0].startsWith('Independently')) {
          const verdictIds = JSON.parse(messages[1]).evidence.map(item => item.finding.id);
          return { text: (async function* () { yield JSON.stringify({ verdicts: verdictIds.map(id => ({ id, decision: 'supported', reason: 'Checked' })) }); })() };
        }
        const packet = JSON.parse(messages[1]);
        sent[packet.component] = (packet.skills || []).map(skill => skill.id).sort();
        sizes[packet.component] = packet.files.reduce((sum, item) => sum + item.content.length, 0) +
          (packet.skills || []).reduce((sum, skill) => sum + skill.id.length + skill.name.length + skill.guidance.length, 0);
        const file = packet.files[0].path;
        const findings = file.startsWith('api/') ? [
          { category: 'security', severity: 'critical', confidence: 'high', skill: 'python-security', explanation: 'eval of input',
            impact: 'Runs code', suggestedAction: 'Parse instead', evidence: [{ revision: target, path: file, side: 'target', startLine: 2, endLine: 2 }] },
          { category: 'quality', severity: 'critical', confidence: 'high', skill: 'clean-code', explanation: 'Seven positional parameters',
            impact: 'Hard to call correctly', suggestedAction: 'Group them', evidence: [{ revision: target, path: file, side: 'target', startLine: 1, endLine: 1 }] },
          { category: 'security', severity: 'high', confidence: 'high', skill: 'clean-code', explanation: 'Long function mislabelled as security',
            impact: 'Hard to read', suggestedAction: 'Split it', evidence: [{ revision: target, path: file, side: 'target', startLine: 1, endLine: 2 }] },
          { category: 'quality', severity: 'low', confidence: 'high', skill: 'not-a-skill', explanation: 'Unused parameters',
            impact: 'Noise', suggestedAction: 'Remove them', evidence: [{ revision: target, path: file, side: 'target', startLine: 1, endLine: 1 }] }
        ] : [];
        return { text: (async function* () { yield JSON.stringify({ schemaVersion: 1, targetSha: target, policyResults: [], findings, limitations: [] }); })() };
      } };
    const provider = new SecurityReviewProvider({ lm: { selectChatModels: async () => [model] }, LanguageModelChatMessage: { User: value => value } });
    const cache = new ReviewUnitCache(memento());
    let snapshot = store.snapshot();
    const service = new SecurityReviewService(new GitCommandService(repo), provider, cache, () => snapshot);
    const token = { isCancellationRequested: false };
    const request = categories => ({ repositoryPath: '.', targetSha: target, scope: 'branch', categories });

    const details = [];
    const security = await service.review(request(['security', 'compliance']), token, (message, detail) => { if (detail) details.push(detail); });
    // The model is named while it works and in the result and the report.
    assert.equal(security.modelName, 'Mock');
    assert.ok(details.some(detail => detail.model === 'Mock'), 'progress did not name the model');
    assert.match(renderReviewMarkdown(security, { kind: 'review', repositoryName: 'r', targetLabel: 'main', generatedAt: new Date() }), /\| Model \| Mock \(mock:1\) \|/);
    assert.ok(sent.api.includes('python-security') && !sent.api.includes('javascript-security') && !sent.api.includes('clean-code'));
    assert.ok(sent.web.includes('javascript-security') && !sent.web.includes('python-security'));
    assert.ok(!security.findings.some(finding => finding.category === 'quality'), 'a quality finding was kept without the clean code review');
    assert.equal(security.findings[0].skill, 'python-security');
    assert.deepEqual(security.skillsApplied.map(item => item.component).sort(), ['api', 'big', 'web']);
    assert.ok(sent.big.includes('python-security'));
    assert.ok(sizes.big <= INITIAL_UNIT_CHARS, `skills pushed the first request to ${sizes.big} characters`);

    const quality = await service.review(request(['security', 'compliance', 'quality']), token, () => {});
    assert.ok(sent.api.includes('clean-code'), 'clean code did not reach the model');
    const notes = quality.findings.filter(finding => finding.category === 'quality');
    assert.equal(notes.length, 3);
    const relabelled = notes.find(finding => finding.explanation.startsWith('Long function'));
    assert.ok(relabelled, 'a clean code finding kept its security category');
    assert.equal(relabelled.severity, 'medium', 'a clean code finding labelled security kept high severity');
    assert.ok(notes.every(finding => finding.severity === 'medium' || finding.severity === 'low'), 'a quality finding stayed critical');
    assert.equal(notes.find(finding => finding.explanation.startsWith('Seven')).skill, 'clean-code');
    assert.equal(notes.find(finding => finding.explanation.startsWith('Unused')).skill, undefined, 'an unknown skill id was kept');
    const readiness = assessReadiness(quality);
    assert.equal(readiness.quality.length, 3);
    assert.ok(![...readiness.blocking, ...readiness.attention].some(item => notes.some(note => note.id === item.findingId)), 'a quality note was counted as a finding to fix');
    const markdown = renderReviewMarkdown(quality, { kind: 'review', repositoryName: 'r', targetLabel: 'main', generatedAt: new Date() });
    assert.match(markdown, /## Code quality/);
    assert.match(markdown, /## Review skills[\s\S]*api[\s\S]*clean-code/);
    assert.doesNotMatch(renderReviewMarkdown(security, { kind: 'review', repositoryName: 'r', targetLabel: 'main', generatedAt: new Date() }), /## Code quality/);

    // Compliance with no policy no longer ends a review that also asks for clean code.
    for (const key of Object.keys(sent)) delete sent[key];
    const withoutSecurity = await service.review(request(['compliance', 'quality']), token, () => {});
    assert.deepEqual(sent.api, ['clean-code'], 'the clean code review did not run without security');
    assert.ok(withoutSecurity.findings.some(finding => finding.category === 'quality'));
    assert.equal(withoutSecurity.policyStatus, 'not_configured');

    // Turning a skill off sends different guidance, so the component is asked again rather than reused.
    for (const key of Object.keys(sent)) delete sent[key];
    snapshot = { ...snapshot, disabled: new Set(['python-security']) };
    await service.review(request(['security', 'compliance']), token, () => {});
    assert.ok(sent.api && !sent.api.includes('python-security'), 'the saved component was reused with other skills');
    assert.equal(sent.web, undefined, 'a component whose skills did not change was asked again');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  // 6. The controller: the panel lists, turns off, imports and removes skills; the clean code skill adds the category.
  const posts = [];
  const notices = [];
  let picked;
  const runs = [];
  const host = {
    history: new ReviewHistoryStore(memento()),
    skills: new ReviewSkillStore(bundledDir, memento()),
    pickSkillFile: async () => picked,
    workspaceRoot: () => os.tmpdir(),
    post: async message => { posts.push(message); },
    ask: async () => 'Start review',
    alwaysConfirm: () => false,
    isConsentRemembered: () => true,
    rememberConsent: async () => {},
    createRunner: () => ({ review: async request => { runs.push(request); throw new Error('stop here'); } }),
    createCancellation: () => ({ token: { isCancellationRequested: false }, cancel() {}, dispose() {} }),
    copyText: async () => {}, saveText: async () => true, openText: async () => {},
    notify: (message, isError) => { notices.push({ message, isError: Boolean(isError) }); }
  };
  const controller = new ReviewController(host);
  const last = () => posts.filter(message => message.type === 'reviewSkillsLoaded').pop().payload;
  for (const type of ['listReviewSkills', 'setReviewSkillEnabled', 'importReviewSkill', 'removeReviewSkill']) assert.equal(controller.handles(type), true);
  await controller.handle({ type: 'listReviewSkills', payload: {} });
  assert.equal(last().skills.length, files.length);
  assert.equal(last().includeQuality, true);
  assert.equal(controller.handles('setReviewQuality'), false, 'the Clean code box is gone, so is its message');
  await controller.handle({ type: 'setReviewSkillEnabled', payload: { id: 'clean-code', enabled: false } });
  assert.equal(last().skills.find(skill => skill.id === 'clean-code').enabled, false);
  assert.equal(last().includeQuality, false, 'turning the clean code skill off left quality on');
  picked = undefined;
  const before = posts.length;
  await controller.handle({ type: 'importReviewSkill', payload: {} });
  assert.equal(posts.length, before, 'a cancelled file picker changed something');
  picked = 'not a skill';
  await controller.handle({ type: 'importReviewSkill', payload: {} });
  assert.ok(notices.some(notice => notice.isError && /Could not import the skill/.test(notice.message)));
  picked = skillText('team-go', { name: 'Team Go', appliesTo: '["**/*.go"]' });
  await controller.handle({ type: 'importReviewSkill', payload: {} });
  assert.match(last().message, /Imported "Team Go"\. It applies to \*\*\/\*\.go/);
  await controller.handle({ type: 'removeReviewSkill', payload: { id: 'team-go' } });
  assert.ok(!last().skills.some(skill => skill.id === 'team-go'));

  console.log('Review skills smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
