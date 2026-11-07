// The visual editor's edits (src/studio/workflowEdit.ts), applied to the parsed file in Node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applyEdit, positions, problemNodes, serializeWorkflow, settingText, settingValue, EditError } = require('../../out/studio/workflowEdit.js');
const { stepRegistry } = require('../../out/studio/steps.js');
const { validateWorkflow } = require('../../out/studio/workflow.js');
// The provider module imports vscode; editorState itself does not use it.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain); };
const { editorState } = require('../../out/studio/workflowEditorProvider.js');
Module._load = originalLoad;

const steps = stepRegistry();
const required = type => steps.get(type)?.required ?? [];
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '../../resources/studio/samples/analyze-requirements.workflow.json'), 'utf8'));
const edit = (workflow, operation) => applyEdit(workflow, operation, required);

// Settings typed in a form: JSON when they read as JSON, text otherwise; shown back the same way.
assert.equal(settingValue('analysis/out.md'), 'analysis/out.md');
assert.equal(settingValue('${inputs.x}'), '${inputs.x}');
assert.deepEqual(settingValue('{ "a": [1, "${b.output}"] }'), { a: [1, '${b.output}'] });
assert.equal(settingValue('12'), 12);
assert.equal(settingValue('true'), true);
assert.throws(() => settingValue('{ broken'), EditError);
assert.equal(settingText('plain'), 'plain');
assert.equal(settingText('12'), '"12"', 'text that reads as a number is shown quoted, so it stays text');
assert.equal(settingValue(settingText('12')), '12');
assert.equal(settingText({ a: 1 }), '{\n  "a": 1\n}');

// The file as written: stable key order and a final newline; the sample round-trips unchanged.
const text = serializeWorkflow(sample);
assert.equal(text, serializeWorkflow(JSON.parse(text)));
assert.ok(text.endsWith('}\n'));
assert.deepEqual(Object.keys(JSON.parse(serializeWorkflow({ nodes: [], id: 'x', schema: 's' }))), ['schema', 'id', 'nodes']);

// Add: a fresh id, the step's required settings to fill in, and a place on the canvas.
let workflow = edit(sample, { op: 'addNode', type: 'file.write' });
const added = workflow.nodes.at(-1);
assert.deepEqual([added.id, added.type, added.with], ['write-1', 'file.write', { path: '', content: '' }]);
assert.ok(Array.isArray(workflow.layout['write-1']));
assert.equal(sample.nodes.length, 5, 'the original changed');
assert.equal(edit(workflow, { op: 'addNode', type: 'file.write' }).nodes.at(-1).id, 'write-2');

// Rename: edges, positions and every reference that reads it follow.
workflow = edit(sample, { op: 'renameNode', id: 'compare', to: 'match' });
assert.deepEqual(workflow.edges.map(edge => [edge.from, edge.to]), [['read-new', 'match'], ['read-old', 'match'], ['match', 'analyze'], ['analyze', 'write']]);
assert.equal(workflow.edges[2].when, '${match.output.changes}');
assert.equal(workflow.nodes.find(node => node.id === 'analyze').forEach, '${match.output.changes}');
assert.deepEqual(workflow.nodes.find(node => node.id === 'write').with.content.counts, '${match.output.counts}');
assert.ok(workflow.layout.match && !workflow.layout.compare);
assert.deepEqual(validateWorkflow(workflow, steps), [], 'a rename broke the workflow');
assert.throws(() => edit(sample, { op: 'renameNode', id: 'compare', to: 'analyze' }), /already a node/);
assert.throws(() => edit(sample, { op: 'renameNode', id: 'compare', to: 'item' }), /reserved/);
assert.throws(() => edit(sample, { op: 'renameNode', id: 'compare', to: 'Bad Name' }), /not a valid node name/);
// A node whose id starts like another's is not renamed by mistake.
const prefix = edit(edit(sample, { op: 'renameNode', id: 'read-new', to: 'read' }), { op: 'renameNode', id: 'read', to: 'source' });
assert.equal(prefix.nodes.find(node => node.id === 'compare').with.old, '${read-old.output}');
assert.equal(prefix.nodes.find(node => node.id === 'compare').with.new, '${source.output}');

// Remove: its edges and position go too.
workflow = edit(sample, { op: 'removeNode', id: 'analyze' });
assert.deepEqual(workflow.edges.map(edge => `${edge.from}>${edge.to}`), ['read-new>compare', 'read-old>compare']);
assert.equal(workflow.layout.analyze, undefined);
assert.ok(validateWorkflow(workflow, steps).some(problem => /"analyze" does not run before this|no node "analyze"/.test(problem.message)),
  'a reference to the removed node is not reported');

// Settings, node fields, edges and their conditions.
workflow = edit(sample, { op: 'setSetting', id: 'write', key: 'format', value: 'json' });
assert.equal(workflow.nodes.find(node => node.id === 'write').with.format, 'json');
workflow = edit(workflow, { op: 'setSetting', id: 'write', key: 'format', value: '' });
assert.equal('format' in workflow.nodes.find(node => node.id === 'write').with, false, 'an emptied optional setting stays');
workflow = edit(workflow, { op: 'setSetting', id: 'write', key: 'path', value: '' });
assert.equal(workflow.nodes.find(node => node.id === 'write').with.path, '', 'a required setting disappeared');
workflow = edit(sample, { op: 'setNode', id: 'analyze', field: 'forEach', value: '' });
assert.equal(workflow.nodes.find(node => node.id === 'analyze').forEach, undefined);
workflow = edit(sample, { op: 'addEdge', from: 'read-new', to: 'write' });
assert.equal(workflow.edges.length, 5);
assert.equal(edit(workflow, { op: 'addEdge', from: 'read-new', to: 'write' }).edges.length, 5, 'a duplicate edge was added');
assert.throws(() => edit(sample, { op: 'addEdge', from: 'write', to: 'write' }), /cannot follow itself/);
workflow = edit(sample, { op: 'setEdgeWhen', index: 2, value: '' });
assert.equal(workflow.edges[2].when, undefined);
workflow = edit(sample, { op: 'move', id: 'write', at: [10.4, 20.6] });
assert.deepEqual(workflow.layout.write, [10, 21]);

// Inputs, prompts and types.
workflow = edit(sample, { op: 'addInput', name: 'release' });
workflow = edit(workflow, { op: 'setInput', name: 'release', field: 'type', value: 'repository' });
workflow = edit(workflow, { op: 'setInput', name: 'release', field: 'default', value: '{ "path": "x" }' });
assert.deepEqual(workflow.inputs.release, { type: 'repository', title: 'release', default: { path: 'x' } });
assert.throws(() => edit(workflow, { op: 'setInput', name: 'release', field: 'type', value: 'number' }), /string, folder or repository/);
workflow = edit(edit(sample, { op: 'addPrompt', name: 'summarize' }), { op: 'setPrompt', name: 'summarize', field: 'output', value: 'ChangeAnalysis' });
assert.equal(workflow.prompts.summarize.output, 'ChangeAnalysis');
assert.throws(() => edit(sample, { op: 'setType', name: 'ChangeAnalysis', schema: '[' }), /not valid JSON/);
workflow = edit(edit(sample, { op: 'addType', name: 'Plan' }), { op: 'setType', name: 'Plan', schema: '{"type":"array"}' });
assert.deepEqual(workflow.types.Plan, { type: 'array' });
assert.throws(() => edit(sample, { op: 'teleport' }), /Unknown edit/);

// Positions: saved ones are kept; the rest go in a column by depth along the edges.
const unplaced = { ...sample, layout: undefined };
assert.deepEqual(positions(unplaced), { 'read-new': [0, 0], 'read-old': [0, 120], compare: [260, 0], analyze: [520, 0], write: [780, 0] });
assert.deepEqual(edit(unplaced, { op: 'arrange' }).layout, positions(unplaced));

// What the page is given: problems on the nodes they concern, effects once it validates.
const state = editorState(serializeWorkflow(sample), steps);
assert.equal(state.editable, true);
assert.deepEqual(state.problems, []);
assert.deepEqual(state.effects.effects, [{ node: 'write', type: 'file.write', effect: 'write' }]);
assert.equal(state.settings.analyze.input, '${item}');
assert.equal(state.catalog.find(step => step.type === 'file.write').asks, 'writes files');
const broken = editorState(serializeWorkflow(edit(sample, { op: 'removeNode', id: 'read-old' })), steps);
assert.ok(broken.problems.some(problem => problem.nodes.includes('compare')));
assert.equal(broken.effects, undefined);
assert.match(editorState('{ nope', steps).error, /^The file is not valid JSON/);
assert.match(editorState('[]', steps).error, /not a workflow/);
assert.deepEqual(problemNodes(sample, 'edges[2].when'), ['compare', 'analyze']);

console.log('Workflow edit smoke passed');
