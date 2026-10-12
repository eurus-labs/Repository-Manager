const assert = require('node:assert/strict');
const { PINNED_MODELS_KEY, sanitizePinnedModels, readPinnedModels, savePinnedModels } = require('../../out/pinnedModels.js');

// Pinned Copilot models: what the webview sends is cleaned before it is saved for every workspace.
function memento(initial) {
  const values = new Map(Object.entries(initial || {}));
  return { get: key => values.get(key), update: async (key, value) => { values.set(key, value); }, values };
}

async function main() {
  // Strings only, no empties or duplicates, order kept, ids and the list bounded.
  assert.deepEqual(sanitizePinnedModels(['b', 'a', 'b', '', 7, null, { id: 'x' }, 'c']), ['b', 'a', 'c']);
  assert.deepEqual(sanitizePinnedModels('gpt'), []);
  assert.deepEqual(sanitizePinnedModels(undefined), []);
  assert.deepEqual(sanitizePinnedModels(['x'.repeat(201), 'ok']), ['ok']);
  assert.equal(sanitizePinnedModels(Array.from({ length: 80 }, (_, i) => `m${i}`)).length, 50);

  // Saved under one key and read back; a damaged stored value reads as no pins.
  const state = memento();
  assert.deepEqual(readPinnedModels(state), []);
  assert.deepEqual(await savePinnedModels(state, ['deep', 'deep', 3, 'fast']), ['deep', 'fast']);
  assert.deepEqual(state.values.get(PINNED_MODELS_KEY), ['deep', 'fast']);
  assert.deepEqual(readPinnedModels(state), ['deep', 'fast']);
  assert.deepEqual(readPinnedModels(memento({ [PINNED_MODELS_KEY]: 'deep' })), []);
  // Unpinning the last model saves an empty list rather than leaving the old one.
  await savePinnedModels(state, []);
  assert.deepEqual(readPinnedModels(state), []);
  // No global state (tests, a panel created before activation): nothing is read or saved, nothing throws.
  assert.deepEqual(readPinnedModels(undefined), []);
  assert.deepEqual(await savePinnedModels(undefined, ['deep']), ['deep']);
  console.log('Pinned models smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
