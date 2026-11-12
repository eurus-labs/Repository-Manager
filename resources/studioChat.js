// The Studio Chat page (src/studio/studioChat.ts). It draws what the host sends and sends back
// what the person does; the host owns the conversation and the plan. No alert/confirm/prompt:
// the host asks when something needs an answer.
(function () {
  const vscode = acquireVsCodeApi();
  const thread = document.getElementById('thread');
  const notice = document.getElementById('notice');
  const form = document.getElementById('composer');
  const input = document.getElementById('message');
  const modelSelect = document.getElementById('model');
  const send = document.getElementById('send');
  let state = null;

  const el = (tag, attributes = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  const EFFECT = {
    read: null, gate: ['waits for you', 'gate'], write: ['writes · asks first', 'write'],
    command: ['runs · asks first', 'write'], code: ['changes code · you review', 'write'], external: ['sends · asks first', 'external'], unknown: ['unknown step', 'problem']
  };
  const STATUS = { current: 'Plan', proposed: 'Proposed change', superseded: 'Earlier plan', discarded: 'Discarded', accepted: 'Accepted' };
  const RUN = { running: 'Running…', waiting: 'Waiting for your answer', done: 'Done', failed: 'Failed', stopped: 'Stopped' };

  const modelName = selector => (state.models.find(model => model.selector === selector) || {}).name;

  function modelOptions(selected, first) {
    const options = [first];
    for (const model of state.models) options.push({ value: model.selector, label: model.name });
    if (selected && !state.models.some(model => model.selector === selected)) options.push({ value: selected, label: `${selected} (not in this VS Code)` });
    return options.map(option => el('option', { value: option.value, selected: option.value === (selected || '') }, option.label));
  }

  function diffLine(diff) {
    if (!diff) return null;
    const parts = [];
    if (diff.added.length) parts.push(el('span', { class: 'added' }, `+ ${diff.added.join(', ')}`));
    if (diff.removed.length) parts.push(el('span', { class: 'removed' }, `− ${diff.removed.join(', ')}`));
    if (diff.changed.length) parts.push(el('span', { class: 'changed' }, `~ ${diff.changed.join(', ')}`));
    if (diff.criteriaAdded.length || diff.criteriaRemoved.length) parts.push(el('span', { class: 'changed' }, `criteria: +${diff.criteriaAdded.length} −${diff.criteriaRemoved.length}`));
    if (diff.other.length) parts.push(el('span', { class: 'changed' }, `~ ${diff.other.join(', ')}`));
    return el('p', { class: 'diff', 'data-testid': 'diff' }, parts);
  }

  function criteriaBlock(view, editable, diff) {
    const items = view.criteria;
    const save = list => vscode.postMessage({ type: 'edit', operation: { op: 'setCriteria', criteria: list } });
    const rows = items.map((text, index) => editable
      ? el('li', {},
          el('input', { type: 'text', value: text, 'aria-label': `Criterion ${index + 1}`,
            onchange: event => { const next = [...items]; next[index] = event.target.value; save(next); } }),
          el('button', { type: 'button', class: 'icon', title: 'Remove this criterion', 'aria-label': `Remove criterion ${index + 1}`,
            onclick: () => save(items.filter((_, other) => other !== index)) }, '×'))
      : el('li', { class: diff && diff.criteriaAdded.includes(text) ? 'added' : '' }, text));
    const removed = diff ? diff.criteriaRemoved.map(text => el('li', { class: 'removed' }, text)) : [];
    return el('section', { class: 'criteria' },
      el('h4', {}, 'Done when'),
      items.length || removed.length ? el('ul', {}, rows, removed) : el('p', { class: 'muted' }, 'No criteria: the plan cannot run until it has one.'),
      editable ? el('button', { type: 'button', class: 'link', onclick: () => save([...items, 'New criterion']) }, '+ Add criterion') : null);
  }

  /** A skill's name when it was listed; otherwise its folder and short commit. */
  function skillLabel(ref) {
    const known = state.skills && state.skills[ref];
    if (known) return known.name;
    const match = /\/([^/@]+)@([0-9a-f]{7})/.exec(ref);
    return match ? `${match[1]}@${match[2]}` : ref;
  }

  function skillChips(step, editable) {
    if (!step.usesModel || (!step.skills.length && !editable)) return null;
    const set = skills => vscode.postMessage({ type: 'edit', operation: { op: 'setSkills', id: step.id, skills } });
    return el('div', { class: 'skills', 'data-skills': step.id },
      step.skills.map(ref => {
        const scripts = state.skills && state.skills[ref] && state.skills[ref].usesScripts;
        return el('span', { class: 'chip', title: `${ref}${scripts ? '\nUses scripts: they are not run here.' : ''}` },
          skillLabel(ref), scripts ? el('span', { class: 'chip-warning', 'aria-label': 'uses scripts, not run here' }, ' ⚠') : null,
          editable ? el('button', { type: 'button', class: 'icon', 'aria-label': `Remove skill ${skillLabel(ref)}`, onclick: () => set(step.skills.filter(other => other !== ref)) }, '×') : null);
      }),
      editable ? el('button', { type: 'button', class: 'link', onclick: () => vscode.postMessage({ type: 'addSkill', id: step.id }) }, '+ Skill') : null);
  }

  function stepsBlock(view, editable, diff) {
    return el('ol', { class: 'steps' }, view.steps.map(step => {
      const badge = EFFECT[step.effect];
      const mark = diff ? (diff.added.includes(step.id) ? 'added' : diff.changed.includes(step.id) ? 'changed' : '') : '';
      const model = step.usesModel
        ? (editable
          ? el('select', { class: 'step-model', 'aria-label': `Model for ${step.title}`,
              onchange: event => vscode.postMessage({ type: 'edit', operation: { op: 'setNode', id: step.id, field: 'model', value: event.target.value } }) },
              modelOptions(step.model, { value: '', label: `Plan default${view.defaultModel ? ` (${modelName(view.defaultModel) || view.defaultModel})` : ''}` }))
          : el('span', { class: 'muted' }, step.model ? (modelName(step.model) || step.model) : 'plan default'))
        : null;
      return el('li', { class: `step ${mark}`, 'data-step': step.id },
        el('div', { class: 'step-head' }, el('strong', {}, step.title), el('code', {}, step.type),
          badge ? el('span', { class: `badge ${badge[1]}` }, badge[0]) : null, step.usesModel ? el('span', { class: 'badge model' }, 'model') : null),
        model, skillChips(step, editable));
    }), diff ? diff.removed.map(id => el('li', { class: 'step removed' }, el('div', { class: 'step-head' }, el('strong', {}, id), el('span', { class: 'badge' }, 'removed')))) : []);
  }

  function planCard(message) {
    const draft = message.draft;
    const view = draft.view;
    const editable = draft.status === 'current' && !state.busy;
    const busy = Boolean(state.busy);
    const problems = draft.problems.length
      ? el('details', { class: 'problems', open: draft.status === 'current' || draft.status === 'proposed' },
          el('summary', {}, `${draft.problems.length} problem${draft.problems.length === 1 ? '' : 's'}: it cannot run until they are fixed`),
          el('ul', {}, draft.problems.slice(0, 12).map(problem => el('li', {}, el('code', {}, problem.where), ' ', problem.message))))
      : null;
    let actions = null;
    if (draft.status === 'current') {
      actions = el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'primary', disabled: busy || !state.folder || draft.problems.length > 0,
          title: !state.folder ? 'Open a folder to run a plan' : draft.problems.length ? 'Fix the problems first' : 'Run this plan',
          onclick: () => vscode.postMessage({ type: 'run' }) }, 'Run'),
        el('button', { type: 'button', disabled: busy || !state.folder, onclick: () => vscode.postMessage({ type: 'openDiagram' }) }, 'Open in diagram'),
        el('button', { type: 'button', disabled: busy || !state.folder, onclick: () => vscode.postMessage({ type: 'save' }) }, state.file ? 'Saved' : 'Save as workflow'));
    } else if (draft.status === 'proposed') {
      actions = el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'primary', disabled: busy, onclick: () => vscode.postMessage({ type: 'accept', id: message.id }) }, 'Accept change'),
        el('button', { type: 'button', disabled: busy, onclick: () => vscode.postMessage({ type: 'discard', id: message.id }) }, 'Discard'));
    }
    const header = el('div', { class: 'card-head' },
      el('span', { class: `status ${draft.status}` }, STATUS[draft.status] || draft.status),
      el('strong', {}, view.title));
    const defaults = editable && view.steps.some(step => step.usesModel)
      ? el('label', { class: 'default-model' }, 'Steps use ',
          el('select', { 'aria-label': 'Default model for the plan’s steps',
            onchange: event => vscode.postMessage({ type: 'edit', operation: { op: 'setDefaultModel', value: event.target.value } }) },
            modelOptions(view.defaultModel, { value: '', label: 'the model chosen in the dashboard' })))
      : null;
    const collapsed = draft.status === 'superseded' || draft.status === 'discarded';
    return el('article', { class: `card ${draft.status}`, 'data-card': draft.status },
      header,
      collapsed ? null : [draft.status === 'proposed' ? diffLine(draft.diff) : null, criteriaBlock(view, editable, draft.status === 'proposed' ? draft.diff : null),
        el('h4', {}, `Steps (${view.steps.length})`), defaults, stepsBlock(view, editable, draft.status === 'proposed' ? draft.diff : null), problems, actions,
        draft.status === 'current' && state.file ? el('p', { class: 'muted' }, `Saved as ${state.file}: changes there show here.`) : null]);
  }

  function runCard(message) {
    const run = message.run;
    return el('article', { class: `card run ${run.status}`, 'data-run': run.status },
      el('div', { class: 'card-head' }, el('span', { class: `status ${run.status}` }, RUN[run.status] || run.status), el('strong', {}, message.text)),
      run.error ? el('p', { class: 'error-text' }, run.error) : null,
      run.written && run.written.length ? el('p', {}, 'Wrote ', run.written.map((file, index) => [index ? ', ' : '', el('code', {}, file)])) : null,
      run.status === 'done' && run.criteria && run.criteria.length
        ? el('section', { class: 'criteria' }, el('h4', {}, 'Check it against'), el('ul', {}, run.criteria.map(text => el('li', {}, text))),
            el('p', { class: 'muted' }, 'The run does not check these itself: look at what it wrote.'))
        : null,
      run.status === 'waiting' ? el('p', { class: 'muted' }, 'Closed without an answer: Show Workflow Runs takes it up again.') : null);
  }

  function render() {
    if (!state) return;
    thread.replaceChildren();
    if (!state.messages.length) {
      thread.append(el('div', { class: 'empty' },
        el('h2', {}, 'Studio'),
        el('p', {}, 'Describe what you want done. The Studio proposes a plan of steps and what “done” means; you check it, change it by chatting or in the diagram, then Run.'),
        el('p', { class: 'muted' }, 'Each step that writes, runs or sends asks you first, showing exactly what it will do.'),
        state.folder ? null : el('p', { class: 'warning' }, 'Open a folder to run or save a plan.')));
    }
    for (const message of state.messages) {
      if (message.role === 'user') { thread.append(el('div', { class: 'message user' }, el('p', {}, message.text))); continue; }
      if (message.role === 'run') { thread.append(runCard(message)); continue; }
      if (message.role === 'error') { thread.append(el('div', { class: 'message error', role: 'status' }, el('p', {}, message.text))); continue; }
      thread.append(el('div', { class: 'message assistant' },
        message.text ? el('p', {}, message.text) : null,
        message.draft ? planCard(message) : null,
        message.model ? el('p', { class: 'who' }, message.model) : null));
    }
    if (state.busy === 'drafting') thread.append(el('div', { class: 'message assistant thinking', 'data-testid': 'thinking' }, el('p', {}, 'Drafting…')));
    thread.scrollTop = thread.scrollHeight;

    modelSelect.replaceChildren(...modelOptions(state.model, { value: '', label: state.models.length ? 'Dashboard model' : 'No Copilot model' }));
    send.textContent = state.busy === 'drafting' ? 'Stop' : 'Send';
    send.disabled = state.busy === 'running';
    input.disabled = Boolean(state.busy);
    notice.hidden = !state.notice;
    notice.textContent = state.notice || '';
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (state && state.busy === 'drafting') { vscode.postMessage({ type: 'cancel' }); return; }
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'setModel', selector: modelSelect.value }));
  window.addEventListener('message', event => {
    if (event.data && event.data.type === 'state') { state = event.data; render(); }
  });
  vscode.postMessage({ type: 'ready' });
})();
