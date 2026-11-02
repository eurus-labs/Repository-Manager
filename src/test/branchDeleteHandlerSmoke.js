const assert = require('node:assert/strict');
const Module = require('node:module');

// The extension, not the webview, asks how to delete a branch: one modal VS Code dialog.
const dialogs = [];
let answer;
const fakeVscode = { window: {
  async showWarningMessage(message, options, ...actions) { dialogs.push({ message, options, actions }); return answer; },
  showInformationMessage() {}, showErrorMessage() {}
} };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handleDeleteBranch } = require('../../out/handlers/webviewMessageHandler.js');
Module._load = originalLoad;

async function main() {
  const deleted = [];
  const ctx = {
    gitOps: {
      async deleteBranch(submodule, branch, deleteRemote) { deleted.push({ submodule, branch, deleteRemote }); return { success: true, message: 'ok' }; },
      async getBranches() { return []; }
    },
    panel: { webview: { postMessage: async () => true } },
    async reloadDashboardHistory() {},
    async refresh() {}
  };

  // With a remote branch, the dialog offers local only or local and origin; it is modal.
  answer = 'Delete Local and origin/topic';
  await handleDeleteBranch(ctx, { submodule: 'lib-a', branch: 'topic', hasRemote: true });
  assert.deepEqual(dialogs.at(-1).actions, ['Delete Local Branch', 'Delete Local and origin/topic']);
  assert.equal(dialogs.at(-1).options.modal, true);
  assert.match(dialogs.at(-1).options.detail, /origin\/topic also exists/);
  assert.deepEqual(deleted.at(-1), { submodule: 'lib-a', branch: 'topic', deleteRemote: true });

  answer = 'Delete Local Branch';
  await handleDeleteBranch(ctx, { submodule: 'lib-a', branch: 'topic', hasRemote: true });
  assert.equal(deleted.at(-1).deleteRemote, false);

  // Without one, only the local choice exists, and the remote is never touched.
  await handleDeleteBranch(ctx, { submodule: '.', branch: 'local-only', hasRemote: false });
  assert.deepEqual(dialogs.at(-1).actions, ['Delete Local Branch']);
  assert.deepEqual(deleted.at(-1), { submodule: '.', branch: 'local-only', deleteRemote: false });

  // Dismissing the dialog deletes nothing; an old payload's deleteRemote is ignored.
  const before = deleted.length;
  answer = undefined;
  await handleDeleteBranch(ctx, { submodule: '.', branch: 'kept', hasRemote: true });
  answer = 'Delete Local Branch';
  await handleDeleteBranch(ctx, { submodule: '.', branch: 'old', deleteRemote: true });
  assert.equal(deleted.length, before + 1);
  assert.equal(deleted.at(-1).deleteRemote, false);
  // Git, not the page, says whether origin has the branch: a page that did not know yet (a menu
  // opened before its branch list arrived) still gets the choice to delete origin's too.
  ctx.gitOps.getBranches = async () => [{ name: 'early', hasRemote: true }, { name: 'gone', hasRemote: undefined }];
  answer = 'Delete Local and origin/early';
  await handleDeleteBranch(ctx, { submodule: '.', branch: 'early', hasRemote: false });
  assert.deepEqual(dialogs.at(-1).actions, ['Delete Local Branch', 'Delete Local and origin/early']);
  assert.deepEqual(deleted.at(-1), { submodule: '.', branch: 'early', deleteRemote: true });
  // And the other way: a stale page saying it has one does not offer to delete a remote that is gone.
  answer = 'Delete Local Branch';
  await handleDeleteBranch(ctx, { submodule: '.', branch: 'gone', hasRemote: true });
  assert.deepEqual(dialogs.at(-1).actions, ['Delete Local Branch']);
  // If Git cannot be asked, the page's word is kept.
  ctx.gitOps.getBranches = async () => { throw new Error('git failed'); };
  await handleDeleteBranch(ctx, { submodule: '.', branch: 'topic', hasRemote: true });
  assert.deepEqual(dialogs.at(-1).actions, ['Delete Local Branch', 'Delete Local and origin/topic']);
  console.log('Branch delete handler smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
