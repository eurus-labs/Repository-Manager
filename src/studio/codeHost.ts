/**
 * What a Studio code step needs from VS Code: Copilot with tools (through the agent's router), Git,
 * editors' unsaved state, and the repository's npm scripts with the agent's per-repository approval.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { CopilotChatModel, CopilotRouter } from '../agent/lmRouter';
import { describeScript, git, readScripts, runNpmScript, samePathKey, ScriptApprovals } from '../agent/agentView';
import { readSelectedModel } from '../modelPreferences';
import { CodeServices } from './steps';
import { selectorOf } from './studioModels';

type LmModel = CopilotChatModel & { vendor: string; family: string };
type LmApi = typeof vscode & {
  lm?: { selectChatModels(selector: { vendor: string }): Thenable<LmModel[]> };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  LanguageModelChatMessage?: { User(text: string): unknown; Assistant?(text: string): unknown };
};

export function codeServices(context: vscode.ExtensionContext): CodeServices {
  const api = vscode as LmApi;
  const approvals = new ScriptApprovals(context.workspaceState);
  return {
    router(selector) {
      return new CopilotRouter({
        selectModel: async () => {
          if (!api.lm?.selectChatModels || !api.LanguageModelChatMessage) { throw new Error('Code steps need VS Code 1.91 or newer and GitHub Copilot.'); }
          const models = await api.lm.selectChatModels({ vendor: 'copilot' });
          if (selector) {
            const family = selector.slice(selector.indexOf(':') + 1);
            const found = models.find(model => selectorOf(model) === selector) ?? models.find(model => model.id === family);
            if (!found) { throw new Error(`The model "${selector}" is not available in this VS Code.`); }
            return found;
          }
          const chosen = readSelectedModel(context.globalState);
          const model = chosen ? models.find(item => item.id === chosen.id) : models[0];
          if (!model) { throw new Error('No Copilot model is available.'); }
          return model;
        },
        user: text => api.LanguageModelChatMessage!.User(text),
        assistant: api.LanguageModelChatMessage?.Assistant ? text => api.LanguageModelChatMessage!.Assistant!(text) : undefined
      });
    },
    git: {
      currentBranch: async root => (await git(root, ['branch', '--show-current'])).trim(),
      hasChanges: async root => Boolean((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()),
      createBranch: async (root, name) => { await git(root, ['switch', '-c', name]); }
    },
    isDirty: absolutePath => {
      const target = samePathKey(absolutePath);
      return vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && samePathKey(document.uri.fsPath) === target);
    },
    scripts: readScripts,
    allowedScripts: root => approvals.allowed(root, readScripts(root)),
    runScript: runNpmScript
  };
}

/**
 * Asks once for the scripts code steps will run as checks that are not approved yet (or whose
 * command changed since), as the agent does. False: not allowed.
 */
export async function approveChecks(context: vscode.ExtensionContext, root: string, names: string[]): Promise<boolean> {
  const approvals = new ScriptApprovals(context.workspaceState);
  const scripts = readScripts(root);
  const missing = [...new Set(names)].filter(name => scripts[name] === undefined);
  if (missing.length) {
    void vscode.window.showErrorMessage(`Not scripts of ${path.basename(root)}'s package.json: ${missing.join(', ')}. Change the code steps' checks.`);
    return false;
  }
  const allowed = approvals.allowed(root, scripts);
  const needed = [...new Set(names)].filter(name => !allowed.includes(name));
  if (!needed.length) { return true; }
  const choice = await vscode.window.showWarningMessage(`Allow the Studio to run these scripts of ${path.basename(root)} as checks? You are asked again only if a script's command changes.`,
    { modal: true, detail: needed.map(name => describeScript(scripts, name)).join('\n') }, 'Allow');
  if (choice !== 'Allow') { return false; }
  await approvals.approve(root, scripts, needed);
  return true;
}
