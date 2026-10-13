const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const nodes = new Map();
const listeners = {};
const posts = [];
const repositoryCheckboxes = [
  { value: '.', disabled: false, checked: true, dataset: {} },
  { value: 'other', disabled: false, checked: true, dataset: {} },
  { value: 'conflicted', disabled: true, checked: false, dataset: {} }
];
function node(id) {
  if (!nodes.has(id)) nodes.set(id, { id, hidden: false, disabled: false, innerHTML: '', textContent: '', value: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} }, listeners: {}, addEventListener(type, cb) { this.listeners[type] = cb; }, querySelector() { return id === 'historyContextMenu' ? { focus() {} } : null; }, querySelectorAll() { return []; },
    setAttribute() {}, removeAttribute() {}, closest() { return null; }, contains() { return false; }, insertAdjacentHTML() {} });
  return nodes.get(id);
}
const document = { documentElement: { clientWidth: 1200, clientHeight: 800 }, body: { addEventListener(type, cb) { listeners[`body_${type}`] = cb; }, closest() { return null; } },
  getElementById: node, querySelectorAll(selector) { return selector === '.branch-repository' ? repositoryCheckboxes : []; },
  querySelector() { return null; }, addEventListener() {} };
const window = { __initialRepositories: [], innerWidth: 1200, innerHeight: 800,
  addEventListener(type, cb) { listeners[`window_${type}`] = cb; }, setTimeout() {}, requestAnimationFrame() {},
  RepositoryHistoryGraph: { normalizeHistoryFilters: require('../../resources/historyGraph.js').normalizeHistoryFilters,
    laneX() { return 25; }, buildGraphModel(commits) { return {
    width: 76, rowHeight: 32, rows: commits.map(() => ({ lane: 0, before: [], after: [], startsHere: true, parentLanes: [], isMerge: false }))
  }; } } };
const vscode = { getState() { return { selectedDashboardCommit: 'a'.repeat(40), activeDashboardRepository: '.' }; },
  setState() {}, postMessage(message) { posts.push(message); } };
vm.runInNewContext(fs.readFileSync('resources/webview.js', 'utf8'), { document, window, acquireVsCodeApi: () => vscode,
  console, ResizeObserver: class { observe() {} }, setTimeout, clearTimeout, requestAnimationFrame: () => 1 });
function detail(hash, parent) { listeners.window_message({ data: { type: 'commitDetailLoaded', payload: {
  repositoryPath: '.', targetRevision: hash, detail: { hash, shortHash: hash.slice(0,7), parentHashes:[parent],
    comparisonBaseHash: parent, subject: 'Change', authorName: 'Test', authoredAt: new Date().toISOString(), files: [{ path: 'a.txt', status: 'modified' }], refs: [] } } } }); }
function click(action, data = {}) { listeners.body_click({ target: { dataset: { action, ...data }, parentElement: document.body, tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} }); }
const A='a'.repeat(40), B='b'.repeat(40), P='0'.repeat(40);
detail(A, P);
// The remembered model comes back at start, before the model list loads, and is used at once.
listeners.window_message({ data: { type: 'copilotSettingsLoaded', payload: { askBeforeSending: 'never', selectedModel: { id: 'saved', name: 'Saved model' } } } });
assert.equal(node('summaryModelName').textContent, 'Saved model');
click('summarizeChanges');
assert.equal(posts.at(-1).type, 'summarizeChanges');
assert.equal(posts.at(-1).payload.modelId, 'saved');
const id = posts.at(-1).payload.requestId;
// Navigate away by requesting a different commit through the dashboard action.
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: B }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
detail(B, P);
assert.equal(posts.filter(item => item.type === 'cancelChangeSummary').length, 0);
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: A }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
detail(A, P);
assert.equal(node('summarizeChangesButton').disabled, true);
assert.equal(node('cancelChangeSummaryButton').hidden, false);
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: B }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
detail(B, P);
const summary={ repositoryPath:'.', baseSha:P, targetSha:A, root:false, intent:{text:'Changed a.txt',evidence:['a.txt']},
  behaviorChanges:[],affectedAreas:[],dependencyConfigChanges:[],possibleBreakingChanges:[],riskHints:[],suggestedTests:[],
  limitations:[],coverage:{totalFiles:1,includedFiles:1,omitted:[],truncatedCommits:false} };
listeners.window_message({ data: { type:'changeSummaryLoaded', payload: {requestId:id,repositoryPath:'.',summary,model:'test'} } });
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: A }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
detail(A,P);
assert.match(node('changeSummaryResult').innerHTML, /Changed a.txt/);
assert.equal(posts.filter(item=>item.type==='cancelChangeSummary').length,0);
// The restored model is checked at once: the list was asked for at start, and only once.
assert.equal(posts.filter(post => post.type === 'loadSummaryModels').length, 1, 'a restored model was not checked against the list');
// Reload does nothing while a list request is pending, so an older reply cannot land last.
click('reloadSummaryModels');
click('loadSummaryModels');
assert.equal(posts.filter(post => post.type === 'loadSummaryModels').length, 1, 'a second list request started while one was pending');
listeners.window_message({ data: { type: 'summaryModelsLoaded', payload: { models: [
  { id: 'fast', name: 'Fast model' }, { id: 'deep', name: 'Deep model' }, { id: 'odd"<id>', name: '<b>Odd</b>' }
], pinned: ['gone'] } } });
const modelMenu = node('summaryModelMenu');
// Copilot does not offer the remembered model now: Default for this session, but nothing is saved over it.
assert.equal(node('summaryModelName').textContent, 'Default');
assert.equal(posts.filter(post => post.type === 'setSelectedModel').length, 0);
// Choosing Default there is still a choice: the saved model is forgotten, though Default was in use.
click('chooseSummaryModel', { modelId: '' });
assert.equal(JSON.stringify(posts.filter(post => post.type === 'setSelectedModel').at(-1).payload), JSON.stringify({ model: null }));
const savesAfterDefault = posts.filter(post => post.type === 'setSelectedModel').length;
click('chooseSummaryModel', { modelId: '' });
assert.equal(posts.filter(post => post.type === 'setSelectedModel').length, savesAfterDefault, 'Default was saved again');
// A pin of a model Copilot no longer offers is kept but not listed; nothing is pinned here yet.
assert.doesNotMatch(modelMenu.innerHTML, /Pinned|gone/);
assert.ok(modelMenu.innerHTML.indexOf('Fast model') < modelMenu.innerHTML.indexOf('Deep model'), 'models lost Copilot\'s order');
// Names and ids are escaped.
assert.match(modelMenu.innerHTML, /&lt;b&gt;Odd&lt;\/b&gt;/);
assert.match(modelMenu.innerHTML, /data-model-id="odd&quot;&lt;id&gt;"/);
// Pinning saves every pin (the stale one too) and lists the pinned model first, under Pinned.
click('toggleSummaryModelPin', { modelId: 'deep' });
assert.equal(JSON.stringify(posts.at(-1)), JSON.stringify({ type: 'setPinnedModels', payload: { ids: ['gone', 'deep'] } }));
const pinnedAt = modelMenu.innerHTML.indexOf('Pinned');
assert.ok(pinnedAt > 0 && pinnedAt < modelMenu.innerHTML.indexOf('Deep model'));
assert.ok(modelMenu.innerHTML.indexOf('Deep model') < modelMenu.innerHTML.indexOf('All models'));
assert.ok(modelMenu.innerHTML.indexOf('All models') < modelMenu.innerHTML.indexOf('Fast model'));
assert.match(modelMenu.innerHTML, /aria-checked="true" aria-label="Unpin Deep model"/);
// Pinning does not choose the model.
assert.equal(node('summaryModelName').textContent, 'Default');
// Unpinning puts it back in its place; the last pin is gone, so is the Pinned heading.
click('toggleSummaryModelPin', { modelId: 'deep' });
assert.equal(JSON.stringify(posts.at(-1).payload.ids), '["gone"]');
assert.doesNotMatch(modelMenu.innerHTML, /Pinned/);
click('toggleSummaryModelPin', { modelId: 'deep' });
click('chooseSummaryModel', { modelId: 'deep' });
assert.equal(node('summaryModelName').textContent, 'Deep model');
const lastSaved = () => JSON.stringify(posts.filter(post => post.type === 'setSelectedModel').at(-1).payload);
assert.equal(lastSaved(), JSON.stringify({ model: { id: 'deep', name: 'Deep model' } }));
// A later settings reply (a setting changed) does not undo the choice.
listeners.window_message({ data: { type: 'copilotSettingsLoaded', payload: { askBeforeSending: 'always', selectedModel: { id: 'saved', name: 'Saved model' } } } });
assert.equal(node('summaryModelName').textContent, 'Deep model');
assert.equal(node('changeSummaryResult').innerHTML, '');
click('summarizeChanges');
assert.equal(posts.at(-1).payload.modelId, 'deep');
const secondId = posts.at(-1).payload.requestId;
listeners.window_message({ data: { type: 'changeSummaryLoaded', payload: {
  requestId: secondId, repositoryPath: '.', summary: { ...summary, intent: { text: 'Deep summary', evidence: ['a.txt'] } }, model: 'deep:1'
} } });
assert.match(node('changeSummaryResult').innerHTML, /Deep summary/);
click('chooseSummaryModel', { modelId: '' });
assert.equal(node('summaryModelName').textContent, 'Default');
assert.equal(lastSaved(), JSON.stringify({ model: null }));
// Summaries are kept per model: the first was written by the remembered model, so Default has none,
// and switching back to Deep model shows its summary again without asking Copilot.
assert.equal(node('changeSummaryResult').innerHTML, '');
const summariesAsked = posts.filter(post => post.type === 'summarizeChanges').length;
click('chooseSummaryModel', { modelId: 'deep' });
assert.match(node('changeSummaryResult').innerHTML, /Deep summary/);
assert.equal(posts.filter(post => post.type === 'summarizeChanges').length, summariesAsked);
const historyRequest = posts.filter(post => post.type === 'getHistory').at(-1);
listeners.window_message({ data: { type: 'historyLoaded', payload: {
  repositoryPath: '.', requestId: historyRequest?.payload.requestId || 0, offset: 0, nextOffset: null,
  commits: [{ hash: B, shortHash: B.slice(0, 7), subject: 'Right clicked', authorName: 'Test', authorEmail: '',
    authoredAt: new Date().toISOString(), refs: [], parentHashes: [] }]
} } });
const row = { dataset: { commit: B }, closest(selector) { return selector.includes('.history-row') ? this : null; } };
let prevented = false;
listeners.body_contextmenu({ target: row, clientX: 1180, clientY: 790, preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.equal(node('historyContextMenu').hidden, false);
for (const [action, operation] of [
  ['contextCherryPick', 'cherry-pick'], ['contextRevert', 'revert'], ['contextMerge', 'merge']
]) {
  click(action);
  assert.equal(posts.at(-1).type, 'applyHistoryCommit');
  assert.equal(posts.at(-1).payload.commit, B);
  assert.equal(posts.at(-1).payload.operation, operation);
}
for (const [action, operation] of [
  ['contextRebase', 'rebase'], ['contextReset', 'reset'], ['contextDrop', 'drop']
]) {
  click(action);
  assert.equal(posts.at(-1).type, 'rewriteHistoryCommit');
  assert.equal(posts.at(-1).payload.commit, B);
  assert.equal(posts.at(-1).payload.action, operation);
}
for (const [action, command] of [
  ['contextContinueRebase', 'continue'], ['contextAbortRebase', 'abort']
]) {
  click(action);
  assert.equal(posts.at(-1).type, 'resolveHistoryRebase');
  assert.equal(posts.at(-1).payload.command, command);
}
click('contextAddTag');
assert.equal(posts.at(-1).type, 'createTagFromCommit');
assert.equal(posts.at(-1).payload.commit, B);
assert.equal(posts.at(-1).payload.repositoryPath, '.');
click('contextCopyHash');
assert.equal(posts.at(-1).type, 'copyHistoryCommit');
assert.equal(posts.at(-1).payload.commit, B);
click('contextCopySubject');
assert.equal(posts.at(-1).payload.field, 'subject');
click('contextCheckoutCommit');
assert.equal(posts.at(-1).payload.fromHistory, true);
assert.equal(posts.at(-1).payload.commit, B);
click('contextCreateBranch');
assert.equal(node('baseBranch').value, B);
assert.equal(node('branchFromCommitCheckoutRow').hidden, false);
assert.equal(node('baseBranchInput').disabled, true);
assert.equal(repositoryCheckboxes[1].disabled, true);
click('closeModal', { modal: 'createBranchModal' });
assert.equal(node('baseBranchInput').disabled, false);
assert.equal(node('branchFromCommitCheckoutRow').hidden, true);
assert.equal(repositoryCheckboxes[1].disabled, false);
assert.equal(repositoryCheckboxes[2].disabled, true);
click('contextCreateBranch');
node('branchName').value = 'topic/from-history';
node('branchFromCommitCheckout').checked = false;
click('createBranch');
assert.equal(posts.at(-1).type, 'createBranchFromCommit');
assert.equal(posts.at(-1).payload.commit, B);
assert.equal(posts.at(-1).payload.checkout, false);
assert.equal(node('baseBranchInput').disabled, false);
assert.equal(node('branchFromCommitCheckoutRow').hidden, true);
click('contextCreateBranch');
click('openCreateBranchModal');
assert.equal(node('baseBranchInput').disabled, false);
assert.equal(node('baseBranchDropdown').style.pointerEvents, '');
assert.equal(node('branchFromCommitCheckoutRow').hidden, true);
assert.equal(repositoryCheckboxes[0].disabled, false);
assert.equal(repositoryCheckboxes[1].disabled, false);
assert.equal(repositoryCheckboxes[1].checked, true);
assert.equal(repositoryCheckboxes[2].disabled, true);
assert.equal(posts.at(-1).type, 'getBaseBranchesForCreate');
listeners.body_contextmenu({ target: { closest() { return null; } } });
assert.equal(node('historyContextMenu').hidden, true);
// A stash reads as one in the header: its own message, which stash it is and the branch it was made on.
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: B }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
listeners.window_message({ data: { type: 'commitDetailLoaded', payload: { repositoryPath: '.', targetRevision: B, detail: {
  hash: B, shortHash: B.slice(0, 7), parentHashes: [P], comparisonBaseHash: P, comparisonMode: 'parent', subject: 'On main: wip: try',
  authorName: 'Test', authoredAt: new Date().toISOString(), files: [{ path: 'untracked.txt', status: 'added' }], refs: [],
  stash: { ref: 'stash@{0}', branch: 'main', message: 'wip: <try>' } } } } });
assert.match(node('dashboardCommitSummary').innerHTML, /stash-avatar/);
assert.match(node('dashboardCommitSummary').innerHTML, /<strong>wip: &lt;try&gt;<\/strong><span>Stash stash@\{0\} · on main · /);
// A stash on its own gets Apply, Pop and Drop in the header; each names the stash by its hash.
assert.equal(node('stashActions').hidden, false, 'a stash has no Apply / Pop / Drop');
click('stashAction', { operation: 'pop' });
assert.equal(JSON.stringify(posts.at(-1)), JSON.stringify({ type: 'stashAction', payload: { repositoryPath: '.', stash: B, operation: 'pop' } }));
// Once it is applied, the next status of the repository opens the uncommitted changes it made.
listeners.window_message({ data: { type: 'stashActionCompleted', payload: { repositoryPath: '.', operation: 'pop',
  changedWorkingTree: true, removedStash: true } } });
listeners.window_message({ data: { type: 'workingTreeChangesLoaded', payload: { repositoryPath: '.', purpose: 'dashboard',
  changes: [{ path: 'untracked.txt', staged: false, unstaged: false, untracked: true, conflicted: false }] } } });
assert.match(node('dashboardCommitSummary').innerHTML, /<strong>Uncommitted changes<\/strong>/);
assert.equal(node('stashActions').hidden, true, 'the uncommitted changes kept the stash actions');
// Only once: a later status leaves the selection to the user.
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: A }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
detail(A, P);
listeners.window_message({ data: { type: 'workingTreeChangesLoaded', payload: { repositoryPath: '.', purpose: 'dashboard',
  changes: [{ path: 'untracked.txt', staged: false, unstaged: false, untracked: true, conflicted: false }] } } });
assert.doesNotMatch(node('dashboardCommitSummary').innerHTML, /Uncommitted changes/);
// An ordinary commit, or a stash compared with another commit, has none.
assert.equal(node('stashActions').hidden, true, 'an ordinary commit has stash actions');
listeners.body_click({ target: { dataset: { action: 'selectHistoryCommit', commit: B }, parentElement: document.body,
  tagName: 'BUTTON', closest() { return null; } }, preventDefault() {} });
listeners.window_message({ data: { type: 'commitDetailLoaded', payload: { repositoryPath: '.', targetRevision: B, detail: {
  hash: B, shortHash: B.slice(0, 7), parentHashes: [P], comparisonBaseHash: A, comparisonMode: 'range', subject: 'On main: wip',
  authorName: 'Test', authoredAt: new Date().toISOString(), files: [], refs: [],
  stash: { ref: 'stash@{0}', branch: 'main', message: 'wip' } } } } });
assert.equal(node('stashActions').hidden, true, 'a comparison has stash actions');
// A history filtered to a stash from the Stashes list names a position: Apply keeps the filter, but
// once a Pop or Drop removes a stash the reload that follows shows the whole history.
const lastHistoryBranch = () => posts.filter(message => message.type === 'getHistory').at(-1).payload.branch;
click('selectReference', { revision: 'stash@{0}' });
assert.equal(lastHistoryBranch(), 'stash@{0}');
listeners.window_message({ data: { type: 'stashActionCompleted', payload: { repositoryPath: '.', operation: 'apply',
  changedWorkingTree: true, removedStash: false } } });
listeners.window_message({ data: { type: 'reloadDashboardHistory', payload: { repositoryPaths: ['.'] } } });
assert.equal(lastHistoryBranch(), 'stash@{0}', 'Apply cleared the stash filter');
listeners.window_message({ data: { type: 'stashActionCompleted', payload: { repositoryPath: '.', operation: 'drop',
  changedWorkingTree: false, removedStash: true } } });
listeners.window_message({ data: { type: 'reloadDashboardHistory', payload: { repositoryPaths: ['.'] } } });
assert.equal(lastHistoryBranch(), undefined, 'a dropped stash stayed the history filter');
console.log('UI summary switch smoke passed');
