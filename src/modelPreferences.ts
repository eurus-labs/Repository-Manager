import type * as vscode from 'vscode';

/**
 * The dashboard's Model menu, kept for every workspace: the models pinned to its top, and the model
 * chosen (with its name, so the button can show it before the model list loads).
 */
export const PINNED_MODELS_KEY = 'repositoryManager.pinnedModels';
export const SELECTED_MODEL_KEY = 'repositoryManager.selectedModel';
const MAX_PINNED = 50;
const MAX_NAME_LENGTH = 200;
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

export interface SelectedModel { id: string; name: string }

/** A chosen model, or undefined for Default (the first model Copilot offers). */
export function sanitizeSelectedModel(value: unknown): SelectedModel | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const { id, name } = value as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) { return undefined; }
  const label = typeof name === 'string' && name && name.length <= MAX_NAME_LENGTH ? name : id;
  return { id, name: label };
}

export function readSelectedModel(state: vscode.Memento | undefined): SelectedModel | undefined {
  return sanitizeSelectedModel(state?.get(SELECTED_MODEL_KEY));
}

export async function saveSelectedModel(state: vscode.Memento | undefined, value: unknown): Promise<SelectedModel | undefined> {
  const model = sanitizeSelectedModel(value);
  await state?.update(SELECTED_MODEL_KEY, model);
  return model;
}
