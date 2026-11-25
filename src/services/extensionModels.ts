/**
 * Models VS Code keeps for its own use. `vscode.lm` lists them to extensions, but a request fails with
 * "Model <id> is only available to VS Code core." (the only signal seen; no public field marks them),
 * so a model is learned as unusable from that refusal and kept in `globalState` until VS Code changes.
 * No `vscode` import: every model menu and pick shares these rules (docs/plans/plan-8-*.md).
 */
export const UNUSABLE_MODELS_KEY = 'repositoryManager.unusableModels';
const MAX_IDS = 200;

export interface ModelState { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> | Promise<void> | void }

/** VS Code's wording for a model an extension may not use. Matched in this one place. */
export function isCoreOnlyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('only available to VS Code core');
}

/** The ids learned as unusable under this VS Code version; another version starts the list again. */
export function unusable(state: ModelState | undefined, vscodeVersion: string): Set<string> {
  const stored = state?.get<{ vscodeVersion?: unknown; ids?: unknown }>(UNUSABLE_MODELS_KEY);
  if (!stored || stored.vscodeVersion !== vscodeVersion || !Array.isArray(stored.ids)) { return new Set(); }
  return new Set(stored.ids.filter((id): id is string => typeof id === 'string'));
}

export async function markUnusable(state: ModelState | undefined, vscodeVersion: string, id: string): Promise<void> {
  if (!state || !id) { return; }
  const ids = unusable(state, vscodeVersion);
  ids.add(id);
  await state.update(UNUSABLE_MODELS_KEY, { vscodeVersion, ids: [...ids].slice(-MAX_IDS) });
}

export function usable<T extends { id: string }>(models: T[], state: ModelState | undefined, vscodeVersion: string): T[] {
  const marked = unusable(state, vscodeVersion);
  return marked.size ? models.filter(model => !marked.has(model.id)) : models;
}

/** What the person is told when the model they chose refuses. */
export const refusedChoiceMessage = (name: string) =>
  `${name} is kept by VS Code for its own use and cannot be used by extensions. It was removed from the Model menu; choose another model.`;

/** Where the provider learns which models VS Code keeps for itself, and what to do when the chosen one is one. */
export interface ModelRules {
  state?: () => ModelState | undefined;
  /** The model the person chose refused: forget the choice (the dashboard's Model menu returns to Default). */
  onChosenRefused?: () => void | Promise<void>;
}

/** The model the person chose refused: it is marked, and the person is told; nothing is retried. */
export class ChosenModelRefused extends Error {
  constructor(readonly selector: string, readonly modelName: string) { super(refusedChoiceMessage(modelName)); }
}

interface GuardableModel {
  id: string;
  name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendRequest(messages: any[], options: any, token: any): Thenable<{ text: AsyncIterable<string> }>;
}

export interface GuardOptions<T> {
  state: ModelState | undefined;
  vscodeVersion: string;
  /** The models that may replace a refusing one (when the person named none): any order, marked ones included. */
  alternatives: () => Promise<T[]>;
  /** Whether the person chose this model: it is then reported, not replaced. */
  chosen: boolean;
  /** Called once a chosen model is marked, so the stored choice can be reset. */
  onChosenRefused?: (model: T) => void | Promise<void>;
  /** The error when no model is left. */
  noneLeft: string;
}

/**
 * The model, with `sendRequest` made safe against a model VS Code keeps for itself. A refusal marks the
 * model. A chosen model throws `refusedChoiceMessage` and is not replaced; otherwise each next usable model is
 * asked once, and the wrapper reads as that model from then on (id, name, version, limits).
 */
export function guardModel<T extends GuardableModel>(first: T, options: GuardOptions<T>): T {
  let current = first;
  const refused = new Set<string>();
  const sendRequest = async (messages: unknown[], requestOptions: unknown, token: unknown) => {
    for (;;) {
      // This attempt's model: another request may switch `current` while this one waits.
      const attempt = current;
      try {
        const response = await attempt.sendRequest(messages, requestOptions, token);
        // A refusal may come with the first fragment instead of the call: read it here, before the caller does.
        const iterator = response.text[Symbol.asyncIterator]();
        const head = await iterator.next();
        return { ...response, text: (async function* () {
          if (head.done) { return; }
          yield head.value;
          for (let next = await iterator.next(); !next.done; next = await iterator.next()) { yield next.value; }
        })() };
      } catch (error) {
        if (!isCoreOnlyError(error)) { throw error; }
        const model = attempt;
        refused.add(model.id);
        await markUnusable(options.state, options.vscodeVersion, model.id);
        if (options.chosen) {
          await options.onChosenRefused?.(model);
          throw new ChosenModelRefused(model.id, model.name || model.id);
        }
        const unused = usable(await options.alternatives(), options.state, options.vscodeVersion).filter(item => !refused.has(item.id));
        if (!unused.length) { throw new Error(options.noneLeft); }
        // Only the first request to find the model refused switches; the others use what it chose.
        if (current === attempt) { current = unused[0]; }
      }
    }
  };
  return new Proxy(first, {
    get(_target, property) {
      if (property === 'sendRequest') { return sendRequest; }
      const value = Reflect.get(current, property);
      return typeof value === 'function' ? value.bind(current) : value;
    }
  });
}
