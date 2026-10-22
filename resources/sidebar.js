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

  // The list is replaced as a whole; keep keyboard focus on the same item across a refresh.
  function render(html) {
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.mirrorKey : undefined;
    const scrollTop = root.scrollTop;
    root.innerHTML = html;
    root.scrollTop = scrollTop;
    if (focused) {
      const again = Array.from(root.querySelectorAll('[data-mirror-key]')).find(element => element.dataset.mirrorKey === focused);
      if (again) again.focus();
    }
  }

  window.addEventListener('message', event => {
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
