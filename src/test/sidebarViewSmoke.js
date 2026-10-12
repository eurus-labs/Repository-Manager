const assert = require('node:assert/strict');
const Module = require('node:module');

// The Side Bar view shows the dashboard's copy of the repository list and sends clicks back.
const fakeVscode = { Uri: { joinPath: (base, ...parts) => ({ scheme: 'file', path: [base.path, ...parts].join('/'), toString() { return this.path; } }) } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { RepositoryManagerLauncher } = require('../../out/repositoryManagerLauncher.js');
Module._load = originalLoad;

function createView(visible) {
  const listeners = {};
  const posted = [];
  const view = {
    visible,
    posted,
    webview: {
      options: {}, html: '',
      asWebviewUri: uri => ({ scheme: 'vscode-webview', toString: () => `webview:${uri.path}` }),
      postMessage: async message => { posted.push(message); return true; },
      onDidReceiveMessage: listener => { listeners.message = listener; }
    },
    onDidChangeVisibility: listener => { listeners.visibility = listener; },
    onDidDispose: listener => { listeners.dispose = listener; },
    send: message => listeners.message(message),
    show() { view.visible = true; listeners.visibility(); }
  };
  return view;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  let open = false;
  let opened = 0;
  const toDashboard = [];
  const sidebar = new RepositoryManagerLauncher({ path: '/ext', scheme: 'file' }, {
    isOpen: () => open,
    open: async () => { opened++; open = true; },
    post: message => { toDashboard.push(message); return Promise.resolve(true); }
  });
  assert.equal(RepositoryManagerLauncher.current, sidebar);

  // A visible view opens the dashboard; its HTML loads the Side Bar script and the shared styles.
  const view = createView(true);
  sidebar.resolveWebviewView(view);
  await tick();
  assert.equal(opened, 1, 'showing the Side Bar did not open the dashboard');
  assert.match(view.webview.html, /webview:\/ext\/resources\/sidebar\.js/);
  assert.match(view.webview.html, /webview:\/ext\/resources\/webview\.css/);
  assert.match(view.webview.html, /Content-Security-Policy/);

  // Copies from the dashboard are shown; a recreated view gets the last one at once.
  sidebar.update('<p>list v1</p>');
  assert.deepEqual(view.posted.at(-1), { type: 'sidebarSnapshot', payload: { html: '<p>list v1</p>' } });
  const again = createView(true);
  sidebar.resolveWebviewView(again);
  await again.send({ type: 'sidebarReady' });
  assert.deepEqual(again.posted.at(-1), { type: 'sidebarSnapshot', payload: { html: '<p>list v1</p>' } });
  assert.deepEqual(toDashboard.at(-1), { type: 'publishSidebar' }, 'a new view did not ask for a fresh copy');
  assert.equal(opened, 1, 'an open dashboard was opened again');

  // Clicks go to the dashboard while it is open.
  await again.send({ type: 'sidebarAction', payload: { key: 'k', event: 'click' } });
  assert.deepEqual(toDashboard.at(-1), { type: 'sidebarAction', payload: { key: 'k', event: 'click' } });

  // Once it closes, the list is marked closed, and a click opens the dashboard instead of acting.
  open = false;
  sidebar.dashboardClosed();
  assert.deepEqual(again.posted.at(-1), { type: 'sidebarClosed' });
  const forwarded = toDashboard.length;
  await again.send({ type: 'sidebarAction', payload: { key: 'k', event: 'click' } });
  assert.equal(toDashboard.length, forwarded, 'a click from a closed dashboard was forwarded');
  assert.equal(opened, 2);
  // A view recreated while the dashboard is closed says so instead of showing an empty list.
  open = false;
  const closed = createView(false);
  sidebar.resolveWebviewView(closed);
  await closed.send({ type: 'sidebarReady' });
  assert.deepEqual(closed.posted.at(-1), { type: 'sidebarClosed' });
  // Its button opens the dashboard; so does showing the view again.
  await closed.send({ type: 'openDashboard' });
  assert.equal(opened, 3);
  open = false;
  closed.show();
  await tick();
  assert.equal(opened, 4);

  // The view's title bar always has a button that brings the dashboard forward, open or not.
  const manifest = require('../../package.json');
  const titleButton = (manifest.contributes.menus['view/title'] || [])
    .find(item => item.command === 'repositoryManager.openPanel');
  assert.ok(titleButton, 'the Side Bar has no button to open the dashboard');
  assert.equal(titleButton.when, `view == ${RepositoryManagerLauncher.viewType}`);
  assert.equal(titleButton.group, 'navigation', 'the button is hidden in the ... menu');
  const command = manifest.contributes.commands.find(item => item.command === 'repositoryManager.openPanel');
  assert.ok(command.icon, 'a title-bar button without an icon shows as text');
  console.log('Side Bar view smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
