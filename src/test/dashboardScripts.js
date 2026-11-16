const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Test helper (not a suite): runs the dashboard scripts, in DASHBOARD_SCRIPTS order, in one shared
// vm context, as the page does. `skip` names scripts the caller replaces with its own stub.
const root = path.join(__dirname, '..', '..');
const { DASHBOARD_SCRIPTS } = require(path.join(root, 'out/webview/dashboardScripts'));

function loadDashboard(context, { skip = [] } = {}) {
  const sandbox = vm.createContext(context);
  // In a browser `window` is the global object, so anything a script publishes on the global is
  // `window.X`. A test passes `window` as a separate stub: copy the stub's own properties onto the
  // global (never over keys the context sets explicitly), then make `window` the global itself.
  const stub = context.window;
  if (stub && typeof stub === 'object' && stub !== sandbox) {
    for (const key of Object.keys(stub)) if (!(key in sandbox)) sandbox[key] = stub[key];
  }
  sandbox.window = sandbox;
  for (const name of DASHBOARD_SCRIPTS) {
    if (skip.includes(name)) continue;
    vm.runInContext(fs.readFileSync(path.join(root, 'resources', name), 'utf8'), sandbox, { filename: name });
  }
  return sandbox;
}

module.exports = { loadDashboard, DASHBOARD_SCRIPTS };
