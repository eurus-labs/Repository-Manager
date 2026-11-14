/**
 * What a Studio code step needs from VS Code: Copilot with tools (through the agent's router), Git,
 * editors' unsaved state, and the repository's npm scripts with the agent's per-repository approval.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { CopilotChatModel, CopilotRouter } from '../agent/lmRouter';
import { approveScripts, git, readScripts, runNpmScript, samePathKey, ScriptApprovals } from '../agent/repositoryScripts';
import { CodeServices } from './steps';
import { pickModel } from './studioModels';

type LmApi = typeof vscode & {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  LanguageModelChatMessage?: { User(text: string): unknown; Assistant?(text: string): unknown };
};

export function codeServices(context: vscode.ExtensionContext): CodeServices {
  const api = vscode as LmApi;
  const approvals = new ScriptApprovals(context.workspaceState);
  return {
    router(selector) {
      return new CopilotRouter({
        // Any vendor's model, as the chat's model menu offers: the selector's, or the dashboard's.
        selectModel: async () => {
          if (!api.LanguageModelChatMessage) { throw new Error('Code steps need VS Code\'s language model API (VS Code 1.104 or newer).'); }
          return await pickModel(context, selector) as unknown as CopilotChatModel;
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
  const scripts = readScripts(root);
  const missing = [...new Set(names)].filter(name => scripts[name] === undefined);
  if (missing.length) {
    void vscode.window.showErrorMessage(`Not scripts of ${path.basename(root)}'s package.json: ${missing.join(', ')}. Change the code steps' checks.`);
    return false;
  }
  return approveScripts(new ScriptApprovals(context.workspaceState), root, names,
    async (question, detail) => await vscode.window.showWarningMessage(question, { modal: true, detail }, 'Allow') === 'Allow');
}
