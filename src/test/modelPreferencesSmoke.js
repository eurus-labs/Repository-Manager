const assert = require('node:assert/strict');
const { PINNED_MODELS_KEY, SELECTED_MODEL_KEY, sanitizePinnedModels, readPinnedModels, savePinnedModels,
  sanitizeSelectedModel, readSelectedModel, saveSelectedModel } = require('../../out/modelPreferences.js');

// The Model menu's pins and chosen model: what the webview sends is cleaned before it is saved for every workspace.
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

  // The chosen model: an id with its name (the id stands in for a missing or oversized name).
  assert.deepEqual(sanitizeSelectedModel({ id: 'deep', name: 'Deep model', extra: 1 }), { id: 'deep', name: 'Deep model' });
  assert.deepEqual(sanitizeSelectedModel({ id: 'deep' }), { id: 'deep', name: 'deep' });
  assert.deepEqual(sanitizeSelectedModel({ id: 'deep', name: 'n'.repeat(201) }), { id: 'deep', name: 'deep' });
  for (const value of [null, undefined, 'deep', { id: '' }, { id: 7 }, { id: 'x'.repeat(201) }]) {
    assert.equal(sanitizeSelectedModel(value), undefined, `${JSON.stringify(value)} was taken as a model`);
  }
  const chosen = memento();
  assert.equal(readSelectedModel(chosen), undefined);
  await saveSelectedModel(chosen, { id: 'deep', name: 'Deep model' });
  assert.deepEqual(readSelectedModel(chosen), { id: 'deep', name: 'Deep model' });
  // Default is saved as no model, replacing the earlier choice.
  await saveSelectedModel(chosen, null);
  assert.equal(chosen.values.get(SELECTED_MODEL_KEY), undefined);
  assert.equal(readSelectedModel(chosen), undefined);
  assert.equal(readSelectedModel(memento({ [SELECTED_MODEL_KEY]: 'deep' })), undefined);
  console.log('Model preferences smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
