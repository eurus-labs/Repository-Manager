/**
 * The Studio's models through vscode.lm (docs/agent-studio.md, "Workflow format additions"). A
 * workflow names a model as `<vendor>:<family>`, so a shared file means the same model on every
 * machine that has it; this resolves that name to one of the models VS Code offers here.
 */
import * as vscode from 'vscode';
import { CopilotSummaryProvider } from '../services/changeSummaryService';
import { readSelectedModel } from '../modelPreferences';
import { StudioModel } from './steps';

interface LmModel { id: string; name: string; vendor: string; family: string }
type LmApi = typeof vscode & { lm?: { selectChatModels(selector: { vendor?: string }): Thenable<LmModel[]> } };

export interface ModelChoice { selector: string; name: string; id: string }

export const selectorOf = (model: Pick<LmModel, 'vendor' | 'family'>) => `${model.vendor}:${model.family}`;

/** The Copilot models this VS Code offers, one per family, in the order it lists them. */
export async function listModels(): Promise<ModelChoice[]> {
  const api = vscode as LmApi;
  if (!api.lm?.selectChatModels) { return []; }
  const models = await api.lm.selectChatModels({ vendor: 'copilot' });
  const seen = new Set<string>();
  const choices: ModelChoice[] = [];
  for (const model of models) {
    const selector = selectorOf(model);
    if (seen.has(selector)) { continue; }
    seen.add(selector);
    choices.push({ selector, name: model.name || model.family, id: model.id });
  }
  return choices;
}

/** The model a selector names here: its family first, then a model whose id is that name. */
export function resolveSelector(selector: string, models: ModelChoice[]): ModelChoice | undefined {
  const [vendor, family] = [selector.slice(0, selector.indexOf(':')), selector.slice(selector.indexOf(':') + 1)];
  return models.find(model => model.selector === selector) ?? models.find(model => model.selector.startsWith(`${vendor}:`) && model.id === family);
}

/** The selector of the model the dashboard has chosen, when it is still offered. */
export function dashboardSelector(context: vscode.ExtensionContext, models: ModelChoice[]): string | undefined {
  const chosen = readSelectedModel(context.globalState)?.id;
  return models.find(model => model.id === chosen)?.selector;
}

/** Copilot through vscode.lm: the model a selector names, or the dashboard's model without one. */
export function studioModel(context: vscode.ExtensionContext): StudioModel {
  const provider = new CopilotSummaryProvider();
  return {
    async complete(prompt, signal, selector) {
      let id = readSelectedModel(context.globalState)?.id;
      if (selector) {
        const found = resolveSelector(selector, await listModels());
        if (!found) { throw new Error(`The model "${selector}" is not available in this VS Code. Choose another model.`); }
        id = found.id;
      }
      const source = new vscode.CancellationTokenSource();
      const timer = setInterval(() => { if (signal.cancelled) { source.cancel(); } }, 200);
      try {
        return await provider.complete(prompt, id, source.token, 60_000);
      } finally {
        clearInterval(timer);
        source.dispose();
      }
    }
  };
}
