// Sharing one workflow as a file (docs/agent-studio.md, phase 3): the requirements Export writes,
// what Import checks, warns about and reports missing, and the "about" metadata a shared file may carry.
const assert = require('node:assert/strict');
const { studioSteps } = require('../../out/studio/registry.js');
const { checkImport, compareVersions, computeRequirements, exportWorkflow, freeId, MAX_SHARED_BYTES, withId } = require('../../out/studio/sharing.js');
const { parseWorkflow } = require('../../out/studio/workflow.js');

const steps = studioSteps();
const base = {
  schema: 'repository-manager/workflow@1', id: 'fix-and-check', version: '1.2.0', title: 'Fix and check',
  defaults: { model: 'copilot:gpt-4o' },
  inputs: { extra: { type: 'string', title: 'Extra check' } },
  prompts: { plan: { instructions: 'Plan the change.' } },
  nodes: [
    { id: 'plan', type: 'prompt', prompt: 'plan', with: { input: 'the change' }, skills: ['github:acme/skills/review@0123456789abcdef0123456789abcdef01234567'] },
    { id: 'fix', type: 'code', model: 'copilot:claude-sonnet', with: { task: 'Fix it', paths: ['src/'], checks: ['test', 'lint', 'test', '${inputs.extra}'] } },
    { id: 'ok', type: 'gate', with: { title: 'Done?' } }
  ],
  edges: [{ from: 'plan', to: 'fix' }, { from: 'fix', to: 'ok' }]
};
const text = JSON.stringify(base);
const { workflow, problems } = parseWorkflow(text, steps);
assert.deepEqual(problems, [], JSON.stringify(problems));

// Read from the workflow: sorted, each once; a `${…}` check is resolved at run time, so not listed.
const requires = computeRequirements(workflow, '3.3.0');
assert.deepEqual(requires, {
  extension: '>=3.3.0', steps: ['code', 'gate', 'prompt'], models: ['copilot:claude-sonnet', 'copilot:gpt-4o'],
  skills: ['github:acme/skills/review@0123456789abcdef0123456789abcdef01234567'], scripts: ['lint', 'test']
});

// Export then Import on a repository that has the scripts: no warning, nothing missing.
const exported = exportWorkflow(text, steps, '3.3.0').text;
assert.deepEqual(JSON.parse(exported).requires, requires);
let check = checkImport(exported, steps, { extensionVersion: '3.3.0', scripts: ['lint', 'test', 'build'] });
assert.deepEqual([check.problems, check.warnings, check.missing], [[], [], []]);
// A repository without them is told which; a newer extension's file says so; an older one is fine.
check = checkImport(exported, steps, { extensionVersion: '3.4.0', scripts: ['test'] });
assert.deepEqual(check.missing, ['Scripts the open repository does not have: lint.']);
const newer = JSON.stringify({ ...JSON.parse(exported), requires: { ...requires, extension: '>=3.10.0' } });
check = checkImport(newer, steps, { extensionVersion: '3.9.9', scripts: ['lint', 'test'] });
assert.deepEqual(check.missing, ['Repository Manager 3.10.0 or later (this is 3.9.9).']);
assert.equal(JSON.parse(check.text).requires.extension, '>=3.10.0', 'the author\'s version was not kept');
assert.ok(compareVersions('3.10.0', '3.9.9') > 0 && compareVersions('3.3.0', '3.3.0') === 0);

// No requires, or a malformed one: warned, the computed one written.
check = checkImport(text, steps, { extensionVersion: '3.3.0', scripts: ['lint', 'test'] });
assert.deepEqual(check.warnings, ['The file lists no requirements; they were read from the workflow.']);
assert.deepEqual(JSON.parse(check.text).requires, requires);
check = checkImport(JSON.stringify({ ...base, requires: { extension: 'latest', steps: 'code' } }), steps, { extensionVersion: '3.3.0', scripts: [] });
assert.ok(check.warnings.some(line => line.startsWith('"requires.steps" does not match')));
assert.ok(check.warnings.includes('"requires.extension" is not ">=X.Y.Z"; this version (3.3.0) was written instead.'));
assert.equal(check.workflow.requires.extension, '>=3.3.0');
// A list entry that is not text is a mismatch, warned about, never coerced (an object without
// toString used to throw out of Import).
check = checkImport(JSON.stringify({ ...base, requires: { ...requires, steps: [{ toString: null }] } }), steps, { extensionVersion: '3.3.0', scripts: ['lint', 'test'] });
assert.deepEqual(check.warnings, ['"requires.steps" does not match the workflow; it uses code, gate, prompt.']);
assert.deepEqual(check.workflow.requires.steps, ['code', 'gate', 'prompt']);

// What cannot be imported: too large, not JSON, not a valid workflow.
const huge = JSON.stringify({ ...base, description: 'x'.repeat(MAX_SHARED_BYTES) });
assert.match(checkImport(huge, steps, { extensionVersion: '3.3.0', scripts: [] }).problems[0].message, /larger than 1024 KB/);
assert.equal(checkImport('{', steps, { extensionVersion: '3.3.0', scripts: [] }).workflow, undefined);
assert.ok(checkImport(JSON.stringify({ ...base, nodes: [] }), steps, { extensionVersion: '3.3.0', scripts: [] }).problems.length);

// "about": authors, license, homepage, keywords; anything else or a bad value is a problem.
const about = (value) => parseWorkflow(JSON.stringify({ ...base, about: value }), steps).problems.map(problem => problem.where);
assert.deepEqual(about({ authors: ['Ana <ana@example.com>'], license: 'Apache-2.0', homepage: 'https://example.com', keywords: ['review'] }), []);
assert.deepEqual(about({ license: 'MIT OR Apache-2.0' }), []);
// Grouped SPDX expressions at any depth; a broken one is refused.
for (const license of ['MIT AND (Apache-2.0 OR BSD-3-Clause)', '(MIT OR (GPL-2.0-only WITH Classpath-exception-2.0))']) {
  assert.deepEqual(about({ license }), [], license);
}
for (const license of ['MIT AND', '(MIT', 'MIT)', 'MIT OR OR Apache-2.0', 'AND', '()']) {
  assert.deepEqual(about({ license }), ['about.license'], license);
}
assert.deepEqual(about({ license: 'see file', homepage: 'http://example.com', authors: 'Ana', version: '1' }).sort(),
  ['about.authors', 'about.homepage', 'about.license', 'about.version']);

// Keep Both: the next free id, written into the file.
assert.equal(freeId('note', new Set(['note', 'note-2'])), 'note-3');
assert.equal(freeId('note', new Set()), 'note');
assert.equal(JSON.parse(withId(exported, 'fix-and-check-2')).id, 'fix-and-check-2');
console.log('Studio sharing smoke passed');
