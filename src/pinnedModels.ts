import type * as vscode from 'vscode';

/** Copilot models pinned to the top of the dashboard's Model menu, kept for every workspace. */
export const PINNED_MODELS_KEY = 'repositoryManager.pinnedModels';
const MAX_PINNED = 50;
const MAX_ID_LENGTH = 200;

/** The ids the webview sent, or a stored value: strings only, no duplicates, in order, bounded. */
export function sanitizePinnedModels(value: unknown): string[] {
  if (!Array.isArray(value)) { return []; }
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id === 'string' && id && id.length <= MAX_ID_LENGTH && !ids.includes(id)) { ids.push(id); }
    if (ids.length === MAX_PINNED) { break; }
  }
  return ids;
}

export function readPinnedModels(state: vscode.Memento | undefined): string[] {
  return sanitizePinnedModels(state?.get(PINNED_MODELS_KEY));
}

export async function savePinnedModels(state: vscode.Memento | undefined, value: unknown): Promise<string[]> {
  const ids = sanitizePinnedModels(value);
  await state?.update(PINNED_MODELS_KEY, ids);
  return ids;
}
