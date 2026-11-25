// Models VS Code keeps for itself (docs/plans/plan-8-studio-chat-model-choice.md): the shared rules, and the
// dashboard's commit-message provider and the review's model pick built on them, with scripted models.
const assert = require('node:assert/strict');
const Module = require('node:module');

let listed = [];
const calls = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      version: '1.104.0',
      lm: { async selectChatModels() { return [...listed]; } },
      LanguageModelChatMessage: { User(value) { return value; } }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const shared = require('../../out/services/extensionModels.js');
const { CopilotSummaryProvider } = require('../../out/services/changeSummaryService.js');
const { SecurityReviewProvider } = require('../../out/services/securityReviewProvider.js');
Module._load = originalLoad;

const memento = () => { const values = new Map(); return { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } }; };
const token = { isCancellationRequested: false };
const model = (id, behaviour = 'answers') => ({
  id, name: `Model ${id}`, version: '1', maxInputTokens: 32000,
  async countTokens(text) { return Math.ceil(text.length / 4); },
  async sendRequest() {
    calls.push(id);
    if (behaviour === 'refuses') { throw new Error(`Model ${id} is only available to VS Code core.`); }
    if (behaviour === 'refuses-late') {
      return { text: (async function* () { throw new Error(`Model ${id} is only available to VS Code core.`); })() };
    }
    return { text: (async function* () { yield `answer from ${id}`; })() };
  }
});
const drain = async response => { let text = ''; for await (const part of response.text) { text += part; } return text; };

async function main() {
  // ---- The shared rules.
  assert.equal(shared.isCoreOnlyError(new Error('Model copilot-dictation-cleanup-luna is only available to VS Code core.')), true);
  assert.equal(shared.isCoreOnlyError(new Error('fetch failed')), false);
  assert.equal(shared.isCoreOnlyError(new Error('Cancelled')), false);
  assert.equal(shared.isCoreOnlyError(undefined), false);
  const state = memento();
  await shared.markUnusable(state, '1.104.0', 'a');
  await shared.markUnusable(state, '1.104.0', 'a');
  await shared.markUnusable(state, '1.104.0', 'b');
  assert.deepEqual(state.get('repositoryManager.unusableModels'), { vscodeVersion: '1.104.0', ids: ['a', 'b'] });
  assert.deepEqual(shared.usable([{ id: 'a' }, { id: 'c' }], state, '1.104.0'), [{ id: 'c' }]);
  assert.deepEqual(shared.usable([{ id: 'a' }, { id: 'c' }], state, '1.105.0'), [{ id: 'a' }, { id: 'c' }], 'a new VS Code version did not clear the list');
  await shared.markUnusable(state, '1.105.0', 'z');
  assert.deepEqual([...shared.unusable(state, '1.105.0')], ['z'], 'marking under a new version did not start the list again');
  assert.deepEqual(shared.usable([{ id: 'a' }], undefined, '1'), [{ id: 'a' }], 'no state, nothing marked');

  // ---- The dashboard's list and commit messages.
  let forgotten = 0;
  let globalState = memento();
  const dashboard = () => new CopilotSummaryProvider({ state: () => globalState, onChosenRefused: () => { forgotten++; } });
  listed = [model('internal-a', 'refuses'), model('gpt')];
  let provider = dashboard();
  assert.deepEqual((await provider.listModels()).map(item => item.id), ['internal-a', 'gpt']);
  // No model selected: the refusing first model is marked, and the next one answers.
  calls.length = 0;
  assert.deepEqual(await provider.complete('Write a message', undefined, token), { text: 'answer from gpt', model: 'Model gpt' });
  assert.deepEqual(calls, ['internal-a', 'gpt']);
  assert.deepEqual((await provider.listModels()).map(item => item.id), ['gpt'], 'a marked model is still listed');
  assert.equal(forgotten, 0);
  // A refusal on the first fragment is the same refusal.
  globalState = memento();
  listed = [model('internal-a', 'refuses-late'), model('gpt')];
  calls.length = 0;
  assert.equal((await dashboard().complete('Write a message', undefined, token)).text, 'answer from gpt');
  assert.deepEqual(calls, ['internal-a', 'gpt']);
  // The selected model refuses: reported, forgotten, marked, not retried.
  globalState = memento();
  listed = [model('gpt'), model('internal-a', 'refuses')];
  calls.length = 0;
  await assert.rejects(dashboard().complete('Write a message', 'internal-a', token),
    { message: 'Model internal-a is kept by VS Code for its own use and cannot be used by extensions. It was removed from the Model menu; choose another model.' });
  assert.deepEqual(calls, ['internal-a'], 'a chosen model was retried on another model');
  assert.equal(forgotten, 1);
  assert.deepEqual((await dashboard().listModels()).map(item => item.id), ['gpt']);
  // Every model refuses: one request each, then an error.
  globalState = memento();
  listed = [model('internal-a', 'refuses'), model('internal-b', 'refuses')];
  calls.length = 0;
  await assert.rejects(dashboard().complete('Write a message', undefined, token), /No Copilot model available/);
  assert.deepEqual(calls, ['internal-a', 'internal-b']);
  // Another error is not a refusal: nothing is marked.
  globalState = memento();
  const broken = model('broken');
  broken.sendRequest = async () => { throw new Error('fetch failed'); };
  listed = [broken, model('gpt')];
  await assert.rejects(dashboard().complete('Write a message', undefined, token), /fetch failed/);
  assert.equal(shared.unusable(globalState, '1.104.0').size, 0);

  // ---- The review's pick.
  const review = rules => new SecurityReviewProvider({ lm: { async selectChatModels() { return [...listed]; } }, LanguageModelChatMessage: { User: value => value } }, rules);
  globalState = memento();
  forgotten = 0;
  listed = [model('internal-a', 'refuses'), model('gpt')];
  const rules = { state: () => globalState, onChosenRefused: () => { forgotten++; } };
  calls.length = 0;
  const picked = await review(rules).selectModel(undefined);
  assert.equal(await drain(await picked.sendRequest(['x'], {}, token)), 'answer from gpt');
  assert.deepEqual(calls, ['internal-a', 'gpt']);
  assert.equal(picked.id, 'gpt', 'the pick did not read as the model that answered');
  globalState = memento();
  listed = [model('gpt'), model('internal-a', 'refuses')];
  calls.length = 0;
  const chosen = await review(rules).selectModel('internal-a');
  await assert.rejects(chosen.sendRequest(['x'], {}, token), /kept by VS Code for its own use/);
  assert.deepEqual(calls, ['internal-a']);
  assert.equal(forgotten, 1);
  await assert.rejects(review(rules).selectModel('internal-a'), /unavailable/);

  console.log('Extension models smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
