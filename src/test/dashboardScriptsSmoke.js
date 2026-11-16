const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadDashboard } = require('./dashboardScripts');

// The dashboard page loads the ordered list in DASHBOARD_SCRIPTS; the template, the package and
// the Node harness all follow that one list.
const root = path.join(__dirname, '..', '..');
const { DASHBOARD_SCRIPTS } = require(path.join(root, 'out/webview/dashboardScripts'));
const { getHtmlForWebview } = require(path.join(root, 'out/webview/template'));

// a) one script tag per entry, in order, with the page nonce, after the initial-data script.
const html = getHtmlForWebview([], {
  scriptUris: DASHBOARD_SCRIPTS.map(name => ({ toString: () => `https://resource/${name}` })),
  styleUri: { toString: () => 'https://resource/webview.css' }
});
const nonce = /<script nonce="([^"]+)">window\.__initialRepositories/.exec(html)[1];
const initialAt = html.indexOf('window.__initialRepositories');
const tags = [...html.matchAll(/<script nonce="([^"]+)" src="([^"]+)"><\/script>/g)];
assert.deepEqual(tags.map(tag => tag[2]), DASHBOARD_SCRIPTS.map(name => `https://resource/${name}`));
assert.ok(tags.every(tag => tag[1] === nonce && tag.index > initialAt));
assert.equal(html.split('<script').length - 1, DASHBOARD_SCRIPTS.length + 1);
assert.ok(DASHBOARD_SCRIPTS.indexOf('dashboardFormat.js') < DASHBOARD_SCRIPTS.indexOf('webview.js'));

// b) every listed file exists and the VSIX does not exclude it (vsce's own file list).
for (const name of DASHBOARD_SCRIPTS) assert.ok(fs.existsSync(path.join(root, 'resources', name)), `${name} exists`);
const packaged = execFileSync(path.join(root, 'node_modules/.bin/vsce'), ['ls'], { cwd: root, encoding: 'utf8' })
  .split('\n').map(line => line.trim());
for (const name of DASHBOARD_SCRIPTS) assert.ok(packaged.includes(`resources/${name}`), `${name} ships in the VSIX`);

// c) the shared helpers.
const { escapeHtml, shortRevision } = require('../../resources/dashboardFormat.js');
assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#039;&lt;/a&gt;');
assert.equal(escapeHtml(null), '');
assert.equal(escapeHtml(undefined), '');
assert.equal(shortRevision('a'.repeat(40)), 'aaaaaaaa');
assert.equal(shortRevision('main'), 'main');
assert.equal(shortRevision(''), '');
assert.equal(Object.isFrozen(require('../../resources/dashboardFormat.js')), true);

// d) the order is load-bearing: webview.js without dashboardFormat.js in the context fails to start.
const stubContext = () => {
  const element = new Proxy({}, { get: () => () => null });
  const window = { __initialRepositories: [], addEventListener() {} };
  return { window, document: element, acquireVsCodeApi: () => ({ getState: () => null, setState() {}, postMessage() {} }),
    console, setTimeout, clearTimeout, requestAnimationFrame: () => 1, ResizeObserver: class { observe() {} } };
};
assert.throws(() => loadDashboard(stubContext(), { skip: ['dashboardFormat.js'] }), /RepositoryDashboardFormat|escapeHtml|undefined/);

console.log('dashboardScriptsSmoke ok');
