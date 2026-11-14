/**
 * The Studio's models through vscode.lm (docs/agent-studio.md, "Workflow format additions"). A
 * workflow names a model as `<vendor>:<family>`, so a shared file means the same model on every
 * machine that has it; this resolves that name to one of the models VS Code offers here, from any
 * vendor (Copilot's, and others an extension or a key adds), as Copilot Chat's model menu does.
 */
import * as vscode from 'vscode';
import { readSelectedModel } from '../modelPreferences';
import { StudioModel } from './steps';

export interface LmModel {
  id: string; name: string; vendor: string; family: string; version?: string; maxInputTokens: number;
  countTokens(value: string): Thenable<number>;
  sendRequest(messages: unknown[], options: Record<string, never>, token: vscode.CancellationToken): Thenable<{ text: AsyncIterable<string> }>;
}
type LmApi = typeof vscode & {
  lm?: { selectChatModels(selector?: { vendor?: string }): Thenable<LmModel[]>; onDidChangeChatModels?: vscode.Event<void> };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  LanguageModelChatMessage?: { User(text: string): unknown };
};

export interface ModelChoice { selector: string; name: string; id: string; vendor: string }

const MAX_REPLY_CHARS = 60_000;

/** `<vendor>:<family>`; a model that gives no family (some custom endpoints) is named by its id. */
export const selectorOf = (model: Pick<LmModel, 'vendor' | 'family'> & { id?: string }) => `${model.vendor}:${model.family || model.id || ''}`;

/** Every chat model this VS Code offers now, one per vendor and family, in the order it lists them. */
/**
 * Every chat model this VS Code offers now: all vendors, and Copilot's asked for by name too. An
 * empty selector did not list Copilot's models in VS Code (reported 2026-11-13: only other vendors
 * were offered while Copilot answered), so both lists are read and merged, Copilot's first.
 */
export async function lmModels(): Promise<LmModel[]> {
  const api = vscode as LmApi;
  if (!api.lm?.selectChatModels) { return []; }
  const read = async (selector: { vendor?: string }) => {
    try { return await api.lm!.selectChatModels(selector); } catch { return [] as LmModel[]; }
  };
  const [copilot, all] = await Promise.all([read({ vendor: 'copilot' }), read({})]);
  const seen = new Set<string>();
  return [...copilot, ...all].filter(model => {
    const key = `${model.vendor}\u0000${model.id}`;
    if (!model.id || seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
}

export async function listModels(): Promise<ModelChoice[]> {
  const seen = new Set<string>();
  const choices: ModelChoice[] = [];
  for (const model of await lmModels()) {
    const selector = selectorOf(model);
    if (seen.has(selector)) { continue; }
    seen.add(selector);
    choices.push({ selector, name: model.name || model.family || model.id, id: model.id, vendor: model.vendor });
  }
  return choices;
}

/** Fires when VS Code's models change (Copilot finished loading, a model was added or removed). */
export function onModelsChanged(listener: () => void): vscode.Disposable | undefined {
  return (vscode as LmApi).lm?.onDidChangeChatModels?.(listener);
}

/** The model a selector names here: its family first, then a model whose id is that name. */
export function resolveSelector<T extends { vendor: string; id: string } & ({ selector: string } | { family: string })>(selector: string, models: T[]): T | undefined {
  const vendor = selector.slice(0, selector.indexOf(':'));
  const family = selector.slice(selector.indexOf(':') + 1);
  const selectorOfItem = (model: T) => 'selector' in model ? model.selector : selectorOf(model);
  return models.find(model => selectorOfItem(model) === selector) ?? models.find(model => model.vendor === vendor && model.id === family);
}

/** The selector of the model the dashboard has chosen, when it is still offered. */
export function dashboardSelector(context: vscode.ExtensionContext, models: ModelChoice[]): string | undefined {
  const chosen = readSelectedModel(context.globalState)?.id;
  return models.find(model => model.id === chosen)?.selector;
}

/** The model a selector names, or the dashboard's model, or the first one offered. */
export async function pickModel(context: vscode.ExtensionContext, selector: string | undefined): Promise<LmModel> {
  const models = await lmModels();
  if (selector) {
    const found = resolveSelector(selector, models);
    if (!found) { throw new Error(`The model "${selector}" is not available in this VS Code. Choose another model.`); }
    return found;
  }
  const chosen = readSelectedModel(context.globalState)?.id;
  const model = (chosen && models.find(item => item.id === chosen)) || models.find(item => item.vendor === 'copilot') || models[0];
  if (!model) { throw new Error('No chat model is available. Sign in to GitHub Copilot (or add a model) and try again.'); }
  return model;
}

/** One prompt, one reply, through vscode.lm with the model a selector names. */
export function studioModel(context: vscode.ExtensionContext): StudioModel {
  return {
    async complete(prompt, signal, selector) {
      const api = vscode as LmApi;
      if (!api.LanguageModelChatMessage) { throw new Error('The Studio needs VS Code\'s language model API (VS Code 1.104 or newer).'); }
      const model = await pickModel(context, selector);
      if (await model.countTokens(prompt) > model.maxInputTokens - 1024) {
        throw new Error(`What would be sent does not fit ${model.name}. Choose a model with a larger context window, or send less.`);
      }
      const source = new vscode.CancellationTokenSource();
      const timer = setInterval(() => { if (signal.cancelled) { source.cancel(); } }, 200);
      try {
        const response = await model.sendRequest([api.LanguageModelChatMessage.User(prompt)], {}, source.token);
        let text = '';
        for await (const fragment of response.text) {
          if (source.token.isCancellationRequested) { throw new Error('Cancelled'); }
          text += fragment;
          if (text.length > MAX_REPLY_CHARS) { throw new Error('The model\'s reply is longer than expected. Try again, or choose another model.'); }
        }
        return { text, model: model.name || model.id };
      } finally {
        clearInterval(timer);
        source.dispose();
      }
    }
  };
}
