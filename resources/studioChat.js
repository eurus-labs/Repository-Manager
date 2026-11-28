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
  const runStatus = document.getElementById('run-status');
  const attachmentsEl = document.getElementById('attachments');
  const attachHint = document.getElementById('attach-hint');
  const addButton = document.getElementById('add');
  // Which folder chips have their file list open, by path: a re-render keeps them open.
  const openChips = new Set();
  let state = null;
  // Which "Activity (N)" lists the reader opened, by run id: a re-render keeps them open.
  const openActivity = new Set();
  let ticker = null;

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

  // A step's state in a word and a sign: never colour alone.
  const STEP = {
    pending: ['○', 'Not started'], running: ['▶', 'Running'], waiting: ['⏸', 'Waiting for you'], done: ['✓', 'Done'],
    skipped: ['–', 'Skipped'], failed: ['✗', 'Failed'], stopped: ['■', 'Stopped']
  };

  /** m:ss from a start time (ISO), as the reader's clock shows it. */
  function elapsed(since) {
    const started = Date.parse(since);
    if (!Number.isFinite(started)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  const modelName = selector => (state.models.find(model => model.selector === selector) || {}).name;

  function modelOptions(selected, first) {
    const options = [first];
    for (const model of state.models) options.push({ value: model.selector, label: model.vendor && model.vendor !== 'copilot' ? `${model.name} · ${model.vendor}` : model.name });
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

  /** What a chip says about a skill that uses scripts, as scriptsNote in src/studio/skillScripts.ts; the warning sign only where they will not run. */
  function scriptsNote(stepType, skill) {
    const mode = state.scriptRunner;
    if (mode === 'off') return { text: 'Uses scripts: turned off in settings', runs: false };
    if (stepType !== 'code') return { text: 'Uses scripts: this step type has no tools, so they are not run here; use a code step', runs: false };
    if (skill && skill.unavailable) return { text: `Uses scripts: none could be loaded: ${skill.unavailable}`, runs: false };
    if (skill && skill.none) return { text: 'Mentions scripts but has none in its folder, so none are run', runs: false };
    const where = mode === 'container' ? 'in a container' : mode === 'direct' ? 'directly on this machine' : 'in a container when Docker or Podman is available, else directly on this machine';
    return { text: `Uses scripts: run in this step after your approval (${where})`, runs: true };
  }

  function skillChips(step, editable) {
    if (!step.usesModel || (!step.skills.length && !editable)) return null;
    const set = skills => vscode.postMessage({ type: 'edit', operation: { op: 'setSkills', id: step.id, skills } });
    return el('div', { class: 'skills', 'data-skills': step.id },
      step.skills.map(ref => {
        const scripts = state.skills && state.skills[ref] && state.skills[ref].usesScripts ? scriptsNote(step.type, state.skills[ref]) : null;
        return el('span', { class: 'chip', title: `${ref}${scripts ? `\n${scripts.text}` : ''}` },
          skillLabel(ref), scripts && !scripts.runs ? el('span', { class: 'chip-warning', 'aria-label': 'its scripts are not run here' }, ' ⚠') : null,
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
    // Errors stop a run; warnings (plan 9) are advice to read first and leave Run on.
    const errors = draft.problems.filter(problem => problem.severity !== 'warning');
    const warnings = draft.problems.filter(problem => problem.severity === 'warning');
    const open = draft.status === 'current' || draft.status === 'proposed';
    const problems = errors.length
      ? el('details', { class: 'problems', open },
          el('summary', {}, `${errors.length} problem${errors.length === 1 ? '' : 's'}: it cannot run until they are fixed`),
          el('ul', {}, errors.slice(0, 12).map(problem => el('li', {}, el('code', {}, problem.where), ' ', problem.message))))
      : null;
    const advice = warnings.length
      ? el('details', { class: 'warnings', 'data-testid': 'warnings', open },
          el('summary', {}, 'Check before running'),
          el('ul', {}, warnings.slice(0, 12).map(problem => el('li', {}, el('code', {}, problem.where), ' ', problem.message))))
      : null;
    let actions = null;
    if (draft.status === 'current') {
      actions = el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'primary', disabled: busy || !state.folder || errors.length > 0,
          title: !state.folder ? 'Open a folder to run a plan' : errors.length ? 'Fix the problems first' : 'Run this plan',
          onclick: () => vscode.postMessage({ type: 'run' }) }, 'Run'),
        el('button', { type: 'button', disabled: busy || !state.folder, onclick: () => vscode.postMessage({ type: 'openDiagram' }) }, 'Open in diagram'),
        el('button', { type: 'button', disabled: busy || !state.folder, onclick: () => vscode.postMessage({ type: 'save' }) }, state.file ? 'Saved' : 'Save as workflow'),
        el('button', { type: 'button', disabled: busy || errors.length > 0, title: errors.length ? 'Fix the problems first' : 'Export this plan as a .workflow.json to share',
          onclick: () => vscode.postMessage({ type: 'export' }) }, 'Export…'));
    } else if (draft.status === 'proposed') {
      actions = el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'primary', disabled: busy, onclick: () => vscode.postMessage({ type: 'accept', id: message.id }) }, 'Accept change'),
        el('button', { type: 'button', disabled: busy, onclick: () => vscode.postMessage({ type: 'discard', id: message.id }) }, 'Discard'));
    }
    const header = el('div', { class: 'card-head' },
      el('span', { class: `status ${draft.status}` }, STATUS[draft.status] || draft.status),
      el('strong', {}, view.title));
    // The default applies to a step that uses a model and names none: engine.ts resolves `node.model ?? defaults.model`.
    const onDefault = view.steps.filter(step => step.usesModel && !step.model).length;
    const noteId = `default-model-note-${message.id}`;
    const defaults = editable && view.steps.some(step => step.usesModel)
      ? el('label', { class: 'default-model' }, 'Steps use ',
          el('select', { 'aria-label': 'Default model for the plan’s steps', 'aria-describedby': noteId, disabled: onDefault === 0,
            onchange: event => vscode.postMessage({ type: 'edit', operation: { op: 'setDefaultModel', value: event.target.value } }) },
            modelOptions(view.defaultModel, { value: '', label: 'the model chosen in the dashboard' })),
          el('span', { class: 'default-model-note', id: noteId },
            onDefault === 0 ? 'used by no step: each step that uses a model names its own' : `used by ${onDefault} step${onDefault === 1 ? '' : 's'}`))
      : null;
    const collapsed = draft.status === 'superseded' || draft.status === 'discarded';
    return el('article', { class: `card ${draft.status}`, 'data-card': draft.status },
      header,
      collapsed ? null : [draft.status === 'proposed' ? diffLine(draft.diff) : null, criteriaBlock(view, editable, draft.status === 'proposed' ? draft.diff : null),
        el('h4', {}, `Steps (${view.steps.length})`), defaults, stepsBlock(view, editable, draft.status === 'proposed' ? draft.diff : null), problems, advice, actions,
        draft.status === 'current' && state.file ? el('p', { class: 'muted' }, `Saved as ${state.file}: changes there show here.`) : null]);
  }

  /** The steps of a run with a word each, and under the running one its last lines; then every line, collapsed. */
  function runProgress(run) {
    const steps = run.steps || [];
    const activity = run.activity || [];
    const list = el('ol', { class: 'run-steps', 'aria-label': 'Steps of the run', 'aria-live': 'off' }, steps.map((step, index) => {
      const [sign, word] = STEP[step.outcome] || STEP.pending;
      const lines = step.outcome === 'running' ? activity.filter(line => line.node === step.id).slice(-5) : [];
      return el('li', { class: `run-step ${step.outcome}`, 'data-step': step.id, 'data-outcome': step.outcome },
        el('span', { class: 'sign', 'aria-hidden': 'true' }, sign),
        el('span', { class: 'step-title' }, step.title || step.id),
        el('span', { class: 'step-word' }, word,
          step.outcome === 'running' && step.since ? [' · ', el('span', { class: 'tick', 'data-since': step.since }, elapsed(step.since))] : null,
          step.outcome === 'done' && typeof step.executionMs === 'number' && step.executionMs >= 1000 ? ` · ${Math.round(step.executionMs / 1000)} s` : null),
        step.error && step.outcome === 'failed' ? el('span', { class: 'error-text step-error' }, step.error) : null,
        lines.length ? el('ul', { class: 'activity recent', 'aria-label': `What ${step.title || step.id} is doing`, 'aria-live': 'off' },
          lines.map(line => el('li', { class: line.ok === false ? 'bad' : '' }, line.text))) : null);
    }));
    const more = activity.length
      ? el('details', { class: 'all-activity', 'data-key': `activity-${run.id}`, open: openActivity.has(run.id),
          ontoggle: event => { if (event.target.open) openActivity.add(run.id); else openActivity.delete(run.id); } },
          el('summary', {}, `Activity (${activity.length})`),
          el('ul', { class: 'activity', 'aria-live': 'off' }, activity.map(line => el('li', { class: line.ok === false ? 'bad' : '' }, line.text))))
      : null;
    return [list, more];
  }

  function runCard(message) {
    const run = message.run;
    return el('article', { class: `card run ${run.status}`, 'data-run': run.status, 'aria-live': run.steps && run.steps.length ? 'off' : null },
      el('div', { class: 'card-head' }, el('span', { class: `status ${run.status}` }, RUN[run.status] || run.status), el('strong', {}, message.text)),
      run.steps && run.steps.length ? runProgress(run) : null,
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
    // Keep the reader's place: the thread follows new content only when it was already at the end,
    // and the focused control (such as an "Activity" summary) is focused again after the redraw.
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
    const top = thread.scrollTop;
    const focused = document.activeElement && thread.contains(document.activeElement) ? document.activeElement.closest('[data-key]') : null;
    const focusKey = focused ? focused.dataset.key : null;
    thread.replaceChildren();
    if (!state.messages.length) {
      thread.append(el('div', { class: 'empty' },
        el('h2', {}, 'Studio'),
        el('p', {}, 'Describe what you want done. The Studio proposes a plan of steps and what “done” means; you check it, change it by chatting or in the diagram, then Run.'),
        el('p', { class: 'muted' }, 'Each step that writes, runs or sends asks you first, showing exactly what it will do.'),
        state.folder ? null : el('p', { class: 'warning' }, 'Open a folder to run or save a plan.')));
    }
    for (const message of state.messages) {
      if (message.role === 'user') { thread.append(el('div', { class: 'message user' }, el('p', {}, message.text), message.attached ? el('div', { class: 'attached' }, message.attached) : null)); continue; }
      if (message.role === 'run') { thread.append(runCard(message)); continue; }
      if (message.role === 'error') { thread.append(el('div', { class: 'message error', role: 'status' }, el('p', {}, message.text))); continue; }
      thread.append(el('div', { class: 'message assistant' },
        message.text ? el('p', {}, message.text) : null,
        message.draft ? planCard(message) : null,
        message.model ? el('p', { class: 'who' }, message.model) : null));
    }
    if (state.busy === 'drafting') thread.append(el('div', { class: 'message assistant thinking', 'data-testid': 'thinking' }, el('p', {}, state.progress || 'Drafting…')));
    // Focus is restored without scrolling to it (Decision 9: the reader keeps their place), then the place is set.
    if (focusKey) { const again = thread.querySelector(`[data-key="${focusKey}"] summary`); if (again) again.focus({ preventScroll: true }); }
    thread.scrollTop = atBottom ? thread.scrollHeight : top;

    modelSelect.replaceChildren(...modelOptions(state.model, { value: '', label: state.models.length ? 'Dashboard model' : state.modelsLoaded ? 'No model yet: sign in to Copilot' : 'Loading models…' }));
    modelSelect.title = state.models.length ? 'The model that drafts the plan' : 'No chat model is available yet. Sign in to GitHub Copilot; the list fills in when the models load.';
    const stoppable = state.busy === 'drafting' || state.busy === 'running';
    send.textContent = state.busy && state.stopping ? 'Stopping…' : stoppable ? 'Stop' : 'Send';
    // aria-disabled, not disabled: the button keeps the keyboard focus while the run stops.
    send.setAttribute('aria-disabled', state.stopping ? 'true' : 'false');
    send.title = state.busy === 'running' ? 'Stop the run: the running step\'s changes are undone.' : state.busy === 'drafting' ? 'Stop drafting' : '';
    send.disabled = false;
    announceSteps();
    startTicker();
    input.disabled = Boolean(state.busy);
    renderAttachments();
    notice.hidden = !state.notice;
    notice.textContent = state.notice || '';
  }

  /** What a chip says it did at the last send, in words (never colour alone). */
  function outcomeWords(chip) {
    const outcome = chip.outcome;
    if (!outcome) return 'attached';
    if (outcome.notSent) return `not sent: ${outcome.notSent}`;
    const sent = outcome.sent;
    if (chip.kind === 'file') {
      if (sent.full) return 'sent in full';
      if (sent.summary) return 'sent as a summary';
      if (sent.outline) return 'sent as an outline';
      const again = outcome.files.find(file => file.reason && file.reason.startsWith('sent with'));
      return again ? again.reason : 'not sent';
    }
    const total = sent.full + sent.summary + sent.outline + sent.notSent;
    const parts = [sent.full && `${sent.full} full`, sent.summary && `${sent.summary} summary`, sent.outline && `${sent.outline} outline`, sent.notSent && `${sent.notSent} not sent`].filter(Boolean);
    return `${total} ${total === 1 ? 'file' : 'files'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
  }

  function fileWords(file) {
    return file.outcome === 'not sent' ? `not sent: ${file.reason || 'not sent'}` : file.outcome;
  }

  function renderAttachments() {
    const chips = state.attachments || [];
    const busy = Boolean(state.busy);
    attachmentsEl.hidden = !chips.length;
    attachHint.hidden = !state.folder;
    addButton.disabled = busy;
    attachmentsEl.replaceChildren(...chips.map(chip => {
      const words = outcomeWords(chip);
      const notSent = Boolean(chip.outcome && chip.outcome.notSent);
      return el('div', { class: `attachment${notSent ? ' attachment-problem' : ''}`, role: 'listitem', 'data-attachment': chip.path },
        el('div', { class: 'attachment-line' },
          el('span', { class: 'attachment-name', title: chip.path }, chip.kind === 'folder' ? `${chip.path}/` : chip.path),
          el('span', { class: 'attachment-outcome' }, words),
          chip.ignored ? el('span', { class: 'chip-warning', title: 'ignored by Git, may hold secrets' }, '⚠ ignored by Git, may hold secrets') : null,
          el('button', { type: 'button', class: 'icon', disabled: busy, 'aria-label': `Remove ${chip.path}`, onclick: () => vscode.postMessage({ type: 'detach', path: chip.path }) }, '×')),
        chip.kind === 'folder' && chip.outcome && !notSent ? el('details', { 'data-chip': chip.path, open: openChips.has(chip.path) || null, ontoggle: event => { if (event.target.open) openChips.add(chip.path); else openChips.delete(chip.path); } },
          el('summary', {}, 'Files'),
          el('ul', {}, chip.outcome.files.map(file => el('li', {}, `${file.path}: ${fileWords(file)}`)), chip.outcome.moreFiles ? el('li', {}, `… and ${chip.outcome.moreFiles} more`) : null),
          chip.outcome.mapNotSaved ? el('p', { class: 'muted' }, 'The map is open with unsaved changes, so it was not saved.') : null,
          chip.map ? el('button', { type: 'button', class: 'link', onclick: () => vscode.postMessage({ type: 'openMap', path: chip.map }) }, 'Open map') : null) : null);
    }));
  }

  /** The one status line: it changes only when a step starts or ends, so a reader hears that, not every line. */
  function announceSteps() {
    let text = '';
    const run = state.busy === 'running' ? [...state.messages].reverse().find(message => message.run && message.run.steps)?.run : null;
    if (run) {
      const steps = run.steps;
      const active = steps.findIndex(step => step.outcome === 'running' || step.outcome === 'waiting');
      if (active >= 0) text = `Step ${active + 1} of ${steps.length}, ${steps[active].title || steps[active].id}: ${steps[active].outcome}`;
      else text = `${steps.filter(step => step.outcome === 'done' || step.outcome === 'skipped').length} of ${steps.length} steps finished`;
    }
    if (runStatus.textContent !== text) runStatus.textContent = text;
  }

  /** The running step's time ticks here, once a second; the host sends nothing per tick. */
  function startTicker() {
    const running = thread.querySelector('.tick');
    if (!running) { if (ticker) { clearInterval(ticker); ticker = null; } return; }
    if (ticker) return;
    ticker = setInterval(() => {
      const ticks = thread.querySelectorAll('.tick');
      if (!ticks.length) { clearInterval(ticker); ticker = null; return; }
      ticks.forEach(tick => { tick.textContent = elapsed(tick.dataset.since); });
    }, 1000);
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (state && (state.busy === 'drafting' || state.busy === 'running')) { if (!state.stopping) vscode.postMessage({ type: 'cancel' }); return; }
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  addButton.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachments' }));
  // VS Code hands a webview a dropped file only with Shift held, as a URI list. Plain text keeps the box's own behavior.
  const URI_LISTS = ['application/vnd.code.uri-list', 'text/uri-list'];
  const carriesUris = event => Boolean(event.dataTransfer) && URI_LISTS.some(type => Array.from(event.dataTransfer.types || []).includes(type));
  for (const target of [form]) {
    target.addEventListener('dragover', event => { if (carriesUris(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
    target.addEventListener('drop', event => {
      if (!carriesUris(event)) return;
      event.preventDefault();
      const type = URI_LISTS.find(name => event.dataTransfer.getData(name));
      if (type) vscode.postMessage({ type: 'attach', uris: [event.dataTransfer.getData(type)] });
    });
  }
  modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'setModel', selector: modelSelect.value }));
  // Opening the menu asks VS Code again: the models may have loaded since the chat opened.
  modelSelect.addEventListener('mousedown', () => vscode.postMessage({ type: 'refreshModels' }));
  modelSelect.addEventListener('focus', () => vscode.postMessage({ type: 'refreshModels' }));
  window.addEventListener('message', event => {
    if (event.data && event.data.type === 'state') { state = event.data; render(); }
  });
  vscode.postMessage({ type: 'ready' });
})();
