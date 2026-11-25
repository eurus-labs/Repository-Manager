// Side Bar view of the dashboard's repositories, branches and references.
// The dashboard owns all state and renders this list; the Side Bar only shows the latest copy it
// received and sends clicks back, so the two can never disagree for longer than one message.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('sidebarRoot');

  function showClosed() {
    root.innerHTML = '<section class="sidebar-section sidebar-closed"><p class="sidebar-placeholder">The dashboard is closed.</p>' +
      '<button type="button" class="btn btn-primary" data-sidebar-command="openDashboard">Open Repository Manager</button></section>';
  }

  // A node's identity across snapshots: tag plus its id or data-mirror-key. A key used twice under
  // one parent identifies nothing, so those nodes match by position like unkeyed ones.
  function groupKeys(nodes) {
    const keyOf = node => node.nodeType !== 1 ? undefined : (node.id || node.getAttribute('data-mirror-key') || undefined);
    const seen = new Map();
    nodes.forEach(node => { const key = keyOf(node); if (key !== undefined) seen.set(key, (seen.get(key) || 0) + 1); });
    return nodes.map(node => {
      if (node.nodeType !== 1) return '#' + node.nodeType;
      const key = keyOf(node);
      return key !== undefined && seen.get(key) === 1 ? 'k|' + node.tagName + '|' + key : 'u|' + node.tagName;
    });
  }

  function patchAttributes(oldEl, newEl) {
    const names = element => Array.from(element.attributes, attr => (attr.namespaceURI || '') + '|' + attr.name);
    const wanted = names(newEl);
    const current = names(oldEl);
    // Serialization follows attribute order, so a changed order is rebuilt rather than patched.
    if (wanted.length !== current.length || wanted.some((name, index) => name !== current[index])) {
      Array.from(oldEl.attributes).forEach(attr => oldEl.removeAttributeNS(attr.namespaceURI, attr.localName));
      Array.from(newEl.attributes).forEach(attr => oldEl.setAttributeNS(attr.namespaceURI, attr.name, attr.value));
      return;
    }
    Array.from(newEl.attributes).forEach(attr => {
      if (oldEl.getAttributeNS(attr.namespaceURI, attr.localName) !== attr.value) oldEl.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
    });
  }

  // Makes parent's children the same as source's, reusing the nodes that match (see groupKeys).
  function patchChildren(parent, source) {
    const oldNodes = Array.from(parent.childNodes);
    const newNodes = Array.from(source.childNodes);
    const oldGroups = new Map();
    groupKeys(oldNodes).forEach((group, index) => {
      if (!oldGroups.has(group)) oldGroups.set(group, []);
      oldGroups.get(group).push(oldNodes[index]);
    });
    const used = new Set();
    const result = groupKeys(newNodes).map((group, index) => {
      const next = newNodes[index];
      const candidates = oldGroups.get(group);
      const match = candidates && candidates.length ? candidates.shift() : undefined;
      if (!match) return document.importNode(next, true);
      used.add(match);
      if (next.nodeType === 1) {
        patchAttributes(match, next);
        patchChildren(match, next);
      } else if (match.nodeValue !== next.nodeValue) {
        match.nodeValue = next.nodeValue;
      }
      return match;
    });
    oldNodes.forEach(node => { if (!used.has(node)) parent.removeChild(node); });
    let cursor = parent.firstChild;
    result.forEach(node => {
      if (node === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(node, cursor);
    });
  }

  // The dashboard's snapshots hold none of this; anything else in a snapshot is dropped before it
  // reaches the document.
  const BLOCKED_ELEMENTS = 'script, iframe, frame, object, embed, link, meta, base, form';
  const URL_ATTRIBUTES = ['href', 'src', 'xlink:href', 'action', 'formaction', 'srcdoc'];
  function neutralize(fragment) {
    fragment.querySelectorAll(BLOCKED_ELEMENTS).forEach(element => element.remove());
    fragment.querySelectorAll('*').forEach(element => {
      Array.from(element.attributes).forEach(attribute => {
        const name = attribute.name.toLowerCase();
        // Browsers drop tabs, newlines and leading control characters inside a URL scheme.
        const value = attribute.value.replace(/[\u0000-\u0020]/g, '').toLowerCase();
        if (name.startsWith('on') || (URL_ATTRIBUTES.includes(name) && /^(javascript|data|vbscript):/.test(value))) {
          element.removeAttribute(attribute.name);
        }
      });
    });
  }

  // The snapshot changes only the nodes that differ, so hover, transitions and focus survive a
  // refresh that touches one row. The result is the same DOM that root.innerHTML = html would give.
  function render(html) {
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.mirrorKey : undefined;
    const scrollTop = root.scrollTop;
    const template = document.createElement('template');
    template.innerHTML = html;
    neutralize(template.content);
    patchChildren(root, template.content);
    root.scrollTop = scrollTop;
    // A focused node that was removed: put focus back on its twin.
    if (focused && !(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.mirrorKey === focused)) {
      const again = Array.from(root.querySelectorAll('[data-mirror-key]')).find(element => element.dataset.mirrorKey === focused);
      if (again) again.focus();
    }
  }

  window.addEventListener('message', event => {
    // VS Code delivers host messages with target.contentWindow.postMessage(message, window.origin)
    // (src/vs/workbench/contrib/webview/browser/pre/index.html), so they carry this page's origin.
    // event.source is not checked: that page sets window.parent = window.
    if (event.origin !== window.origin) return;
    const message = event.data || {};
    if (message.type === 'sidebarSnapshot' && message.payload && typeof message.payload.html === 'string') render(message.payload.html);
    if (message.type === 'sidebarClosed') showClosed();
  });

  function forward(event, kind) {
    const command = event.target.closest('[data-sidebar-command]');
    if (command) {
      event.preventDefault();
      vscode.postMessage({ type: command.dataset.sidebarCommand });
      return;
    }
    const target = event.target.closest('[data-mirror-key]');
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    vscode.postMessage({ type: 'sidebarAction', payload: { key: target.dataset.mirrorKey, event: kind,
      ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey } });
  }
  document.body.addEventListener('click', event => forward(event, 'click'));
  document.body.addEventListener('dblclick', event => forward(event, 'dblclick'));

  vscode.postMessage({ type: 'sidebarReady' });
})();
