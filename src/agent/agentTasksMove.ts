/**
 * The Agent's Tasks view is gone (3.0.0): new work starts in the Studio chat. Tasks people
 * started before are moved into Studio chats when the extension starts (src/studio/agentMigration.ts).
 * A task left running when VS Code closed is first put back where a person decides, as the agent
 * did: a step that was running has what it wrote undone. Nothing is deleted.
 */
import * as vscode from 'vscode';
import { samePathKey } from './repositoryScripts';
import { moveAgentTasks } from '../studio/agentMigration';

export async function registerAgentTasksMove(context: vscode.ExtensionContext): Promise<void> {
  if (!context.storageUri) { return; }
  const isDirty = (absolutePath: string) => {
    const target = samePathKey(absolutePath);
    return vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && samePathKey(document.uri.fsPath) === target);
  };
  const moved = await moveAgentTasks(context.storageUri.fsPath, isDirty);
  if (!moved) { return; }
  const open = 'Open Chat History';
  const answer = await vscode.window.showInformationMessage(`Moved ${moved} agent task${moved === 1 ? '' : 's'} to the Studio chat: each is a chat with its goal, what was done, and the steps left as a plan.`, open);
  if (answer === open) {
    await vscode.commands.executeCommand('repositoryManager.studio.chat.focus');
    await vscode.commands.executeCommand('repositoryManager.studio.chatHistory');
  }
}
