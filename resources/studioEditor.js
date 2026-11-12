// The Studio's visual editor (docs/agent-studio.md, "Visual editor"). It draws the workflow the
// host sends and sends back edits; it keeps no copy of its own, so the JSON file stays the only
// source. Gates the engine places are drawn locked: the page cannot remove them.
(function () {
  const vscode = acquireVsCodeApi();
  const NODE_W = 200;
  const NODE_H = 68;
  const PAD = 40;
  let data = null;
  let selected = (vscode.getState() || {}).selected || null; // { kind: 'node', id } | null
  let notice = '';

  const $ = id => document.getElementById(id);
  const send = operation => vscode.postMessage({ type: 'edit', operation });
  const svg = (tag, attrs = {}) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  };
  const el = (tag, attrs = {}, ...children) => {
    const element = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'text') element.textContent = value;
      else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else if (value === true) element.setAttribute(key, '');
      else if (value !== false && value !== undefined && value !== null) element.setAttribute(key, String(value));
    });
    children.flat(Infinity).forEach(child => { if (child !== null && child !== undefined && child !== false) element.append(child); });
    return element;
  };
  const stepOf = type => (data && data.catalog || []).find(step => step.type === type);
  const remember = () => vscode.setState({ selected });
  const select = value => { selected = value; remember(); render(); };

  /** A labelled field that sends its value when it changes (on blur or Enter), not on each key. */
  function field(label, value, onCommit, { multiline = false, placeholder = '', key, hint, required } = {}) {
    const id = `f-${key || label}`.replace(/[^\w-]/g, '-');
    const input = multiline
      ? el('textarea', { id, rows: Math.min(10, Math.max(2, String(value || '').split('\n').length)), placeholder, 'data-key': key || label })
      : el('input', { id, type: 'text', placeholder, 'data-key': key || label });
    input.value = value == null ? '' : String(value);
    input.addEventListener('change', () => onCommit(input.value));
    if (!multiline) input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); });
    return el('div', { class: 'field' },
      el('label', { for: id }, label, required ? el('span', { class: 'required', title: 'Required', text: ' *' }) : null),
      input, hint ? el('small', { text: hint }) : null);
  }

  function choice(label, value, options, onCommit, key) {
    const id = `f-${key || label}`.replace(/[^\w-]/g, '-');
    const select = el('select', { id, 'data-key': key || label, onchange: event => onCommit(event.target.value) },
      options.map(([optionValue, text]) => el('option', { value: optionValue, text, selected: optionValue === value })));
    return el('div', { class: 'field' }, el('label', { for: id, text: label }), select);
  }

  function section(title, ...children) {
    return el('section', { class: 'group' }, el('h3', { text: title }), children);
  }

  // ------------------------------------------------------------------------------------- canvas

  function nodeProblems(id) {
    return (data.problems || []).filter(problem => problem.nodes.includes(id));
  }

  function drawCanvas() {
    const canvas = $('canvas');
    const edgesLayer = $('edges');
    const nodesLayer = $('nodes');
    edgesLayer.replaceChildren();
    nodesLayer.replaceChildren();
    const workflow = data.workflow;
    const placed = data.positions;
    const xs = Object.values(placed).map(point => point[0]);
    const ys = Object.values(placed).map(point => point[1]);
    const minX = Math.min(0, ...xs) - PAD;
    const minY = Math.min(0, ...ys) - PAD;
    const width = Math.max(...xs.map(x => x + NODE_W), 400) - minX + PAD;
    const height = Math.max(...ys.map(y => y + NODE_H), 200) - minY + PAD;
    canvas.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
    canvas.setAttribute('width', width);
    canvas.setAttribute('height', height);

    (workflow.edges || []).forEach((edge, index) => {
      const from = placed[edge.from];
      const to = placed[edge.to];
      if (!from || !to) return;
      const x1 = from[0] + NODE_W, y1 = from[1] + NODE_H / 2, x2 = to[0], y2 = to[1] + NODE_H / 2;
      const bend = Math.max(40, Math.abs(x2 - x1) / 2);
      const group = svg('g', { class: `edge${selected && selected.kind === 'node' && (selected.id === edge.from || selected.id === edge.to) ? ' near' : ''}`, 'data-edge': index });
      group.append(svg('path', { d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}` }));
      group.append(svg('path', { class: 'arrow', d: `M${x2 - 8},${y2 - 5} L${x2},${y2} L${x2 - 8},${y2 + 5}` }));
      if (edge.when) {
        // As much of the condition as fits between the boxes; all of it on hover.
        const fits = Math.max(4, Math.floor((x2 - x1 - 12) / 6.5));
        const label = svg('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 8, 'text-anchor': 'middle', class: 'when' });
        label.textContent = edge.when.length > fits ? `${edge.when.slice(0, fits - 1)}…` : edge.when;
        const tip = svg('title');
        tip.textContent = `Only when ${edge.when}`;
        group.append(tip, label);
      }
      edgesLayer.append(group);
    });

    workflow.nodes.forEach(node => {
      if (!node || typeof node.id !== 'string') return;
      const at = placed[node.id] || [0, 0];
      const step = stepOf(node.type);
      const issues = nodeProblems(node.id);
      const locked = step && step.asks;
      const group = svg('g', {
        class: ['node', selected && selected.kind === 'node' && selected.id === node.id ? 'selected' : '', issues.length ? 'invalid' : '', node.type === 'gate' ? 'gate' : '', step && step.effect !== 'read' ? 'effect' : ''].filter(Boolean).join(' '),
        transform: `translate(${at[0]},${at[1]})`, tabindex: 0, role: 'button', 'data-node': node.id,
        'aria-label': `${node.title || node.id}, ${node.type}${node.type === 'gate' ? ', waits for your answer' : locked ? `, asks before it ${step.asks}` : ''}${issues.length ? `, ${issues.length} problem${issues.length === 1 ? '' : 's'}` : ''}`
      });
      group.append(svg('rect', { width: NODE_W, height: NODE_H, rx: 8 }));
      const title = svg('text', { x: 12, y: 24, class: 'title' });
      const name = node.title || node.id;
      title.textContent = name.length > 25 ? `${name.slice(0, 24)}…` : name;
      const kind = svg('text', { x: 12, y: 44, class: 'kind' });
      kind.textContent = `${node.type}${node.forEach ? ' · for each' : ''}`;
      group.append(title, kind);
      if (locked) {
        // The engine's gate: drawn on the node, and not a thing the page can remove.
        const wrap = svg('g', { class: 'lock-wrap' });
        const tip = svg('title');
        tip.textContent = 'The engine asks you here, with exactly what will happen. A workflow cannot remove this.';
        const badge = svg('text', { x: 12, y: 60, class: 'lock' });
        badge.textContent = node.type === 'gate' ? '⏸ waits for your answer' : `🔒 asks before it ${step.asks}`;
        wrap.append(tip, badge);
        group.append(wrap);
      }
      if (step && step.usesModel) {
        const model = svg('text', { x: NODE_W - 12, y: 24, 'text-anchor': 'end', class: 'model' });
        model.textContent = 'AI';
        group.append(model);
      }
      if (issues.length) {
        const mark = svg('text', { x: NODE_W - 12, y: 44, 'text-anchor': 'end', class: 'problem-mark' });
        mark.textContent = `⚠ ${issues.length}`;
        group.append(mark);
      }
      group.addEventListener('pointerdown', event => startDrag(event, node.id, at));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select({ kind: 'node', id: node.id }); }
        if (event.key === 'Delete' && data.editable) { send({ op: 'removeNode', id: node.id }); select(null); }
      });
      nodesLayer.append(group);
    });
  }

  // Drag a node to move it; a click without moving selects it. Only the drop is sent.
  function startDrag(event, id, at) {
    if (!data.editable || event.button !== 0) return;
    const canvas = $('canvas');
    const scale = canvas.viewBox.baseVal.width / canvas.getBoundingClientRect().width || 1;
    const start = [event.clientX, event.clientY];
    const group = event.currentTarget;
    let moved = false;
    group.setPointerCapture(event.pointerId);
    const move = moveEvent => {
      const dx = (moveEvent.clientX - start[0]) * scale, dy = (moveEvent.clientY - start[1]) * scale;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (moved) group.setAttribute('transform', `translate(${at[0] + dx},${at[1] + dy})`);
    };
    const up = upEvent => {
      group.removeEventListener('pointermove', move);
      group.removeEventListener('pointerup', up);
      if (!moved) { select({ kind: 'node', id }); return; }
      send({ op: 'move', id, at: [at[0] + (upEvent.clientX - start[0]) * scale, at[1] + (upEvent.clientY - start[1]) * scale] });
    };
    group.addEventListener('pointermove', move);
    group.addEventListener('pointerup', up);
  }

  // -------------------------------------------------------------------------------------- panel

  function workflowPanel() {
    const workflow = data.workflow;
    const inputs = Object.entries(workflow.inputs || {});
    const prompts = Object.entries(workflow.prompts || {});
    const types = Object.entries(workflow.types || {});
    const typeOptions = [['', '(any JSON object)'], ...types.map(([name]) => [name, name])];
    const effects = data.effects;
    const adder = (label, op, placeholder) => {
      const input = el('input', { type: 'text', placeholder, 'aria-label': label });
      const add = () => { if (input.value.trim()) send({ op, name: input.value.trim() }); };
      input.addEventListener('keydown', event => { if (event.key === 'Enter') add(); });
      return el('div', { class: 'adder' }, input, el('button', { type: 'button', text: label, onclick: add }));
    };
    return [
      el('h2', { text: 'Workflow' }),
      field('Title', workflow.title, value => send({ op: 'setWorkflow', field: 'title', value }), { required: true }),
      field('ID', workflow.id, value => send({ op: 'setWorkflow', field: 'id', value }), { required: true, hint: 'Lowercase letters, digits and dashes.' }),
      field('Version', workflow.version, value => send({ op: 'setWorkflow', field: 'version', value }), { required: true }),
      field('Description', workflow.description, value => send({ op: 'setWorkflow', field: 'description', value }), { multiline: true }),
      effects ? section('When it runs', el('ul', { class: 'effects' },
        el('li', { text: effects.promptNodes.length ? `Sends to the Copilot model: ${effects.promptNodes.join(', ')}` : 'Sends nothing to a model' }),
        effects.effects.map(item => el('li', { text: `Asks you before "${item.node}" ${(stepOf(item.type) || {}).asks || item.effect}` })),
        effects.gates.map(gate => el('li', { text: `Stops for your answer at ${gate}` })))) : null,
      section('Inputs', inputs.map(([name, input]) => el('div', { class: 'item' },
        el('div', { class: 'item-head' }, el('code', { text: `\${inputs.${name}}` }),
          el('button', { type: 'button', class: 'link', text: 'Remove', 'aria-label': `Remove input ${name}`, onclick: () => send({ op: 'removeInput', name }) })),
        choice('Type', input.type, [['string', 'Text'], ['folder', 'Folder'], ['repository', 'Repository and revision']], value => send({ op: 'setInput', name, field: 'type', value }), `input-${name}-type`),
        field('Title', input.title, value => send({ op: 'setInput', name, field: 'title', value }), { key: `input-${name}-title` }),
        field('Default', input.default === undefined ? '' : typeof input.default === 'string' ? input.default : JSON.stringify(input.default),
          value => send({ op: 'setInput', name, field: 'default', value }), { key: `input-${name}-default` }))),
        adder('Add input', 'addInput', 'name')),
      section('Prompts', prompts.map(([name, prompt]) => el('div', { class: 'item' },
        el('div', { class: 'item-head' }, el('code', { text: name }),
          el('button', { type: 'button', class: 'link', text: 'Remove', 'aria-label': `Remove prompt ${name}`, onclick: () => send({ op: 'removePrompt', name }) })),
        field('Instructions', prompt.instructions, value => send({ op: 'setPrompt', name, field: 'instructions', value }), { multiline: true, key: `prompt-${name}-instructions` }),
        choice('Output type', prompt.output || '', typeOptions, value => send({ op: 'setPrompt', name, field: 'output', value }), `prompt-${name}-output`))),
        adder('Add prompt', 'addPrompt', 'name')),
      section('Types', types.map(([name, schema]) => el('div', { class: 'item' },
        el('div', { class: 'item-head' }, el('code', { text: name }),
          el('button', { type: 'button', class: 'link', text: 'Remove', 'aria-label': `Remove type ${name}`, onclick: () => send({ op: 'removeType', name }) })),
        field('JSON Schema', JSON.stringify(schema, null, 2), value => send({ op: 'setType', name, schema: value }), { multiline: true, key: `type-${name}` }))),
        adder('Add type', 'addType', 'Name'))
    ];
  }

  function nodePanel(node) {
    const step = stepOf(node.type) || { required: [], optional: [], title: node.type };
    const workflow = data.workflow;
    const settings = data.settings[node.id] || {};
    const keys = [...step.required, ...step.optional, ...Object.keys(settings).filter(key => !step.required.includes(key) && !step.optional.includes(key))];
    const outgoing = (workflow.edges || []).map((edge, index) => ({ edge, index })).filter(item => item.edge.from === node.id);
    const incoming = (workflow.edges || []).filter(edge => edge.to === node.id);
    const others = workflow.nodes.filter(other => other.id !== node.id && !outgoing.some(item => item.edge.to === other.id));
    const issues = nodeProblems(node.id);
    const target = el('select', { 'aria-label': 'Next step' }, others.map(other => el('option', { value: other.id, text: other.title ? `${other.title} (${other.id})` : other.id })));
    return [
      el('div', { class: 'item-head' }, el('h2', { text: node.title || node.id }),
        el('button', { type: 'button', class: 'link', text: 'Back to workflow', onclick: () => select(null) })),
      el('p', { class: 'kind', text: `${step.title} · ${node.type}` }),
      node.type === 'gate' ? el('p', { class: 'locked', text: '⏸ The run stops here until you continue it, showing what "show" holds.' })
        : step.asks ? el('p', { class: 'locked', text: `🔒 The engine asks you before this step ${step.asks}, showing exactly what will happen. A workflow cannot turn this off.` }) : null,
      issues.length ? el('ul', { class: 'node-problems' }, issues.map(problem => el('li', { text: problem.message }))) : null,
      field('ID', node.id, value => { if (value && value !== node.id) { selected = { kind: 'node', id: value }; remember(); send({ op: 'renameNode', id: node.id, to: value }); } },
        { hint: 'Renaming updates the edges and the ${…} references that read it.' }),
      field('Title', node.title, value => send({ op: 'setNode', id: node.id, field: 'title', value })),
      node.type === 'prompt' ? choice('Prompt', node.prompt || '', [['', '(choose)'], ...Object.keys(workflow.prompts || {}).map(name => [name, name])],
        value => send({ op: 'setNode', id: node.id, field: 'prompt', value }), 'node-prompt') : null,
      field('For each', node.forEach, value => send({ op: 'setNode', id: node.id, field: 'forEach', value }),
        { placeholder: '${compare.output.changes}', hint: 'Runs once per item, with ${item} and ${index}.' }),
      section('Settings', keys.length ? keys.map(key => field(key, settings[key], value => send({ op: 'setSetting', id: node.id, key, value }),
        { multiline: true, key: `setting-${key}`, required: step.required.includes(key), hint: key === keys[0] ? 'Text, JSON, or ${references}.' : undefined }))
        : el('p', { class: 'muted', text: 'This step has no settings.' })),
      section('Then',
        outgoing.length ? outgoing.map(({ edge, index }) => el('div', { class: 'item' },
          el('div', { class: 'item-head' }, el('span', { text: `→ ${edge.to}` }),
            el('button', { type: 'button', class: 'link', text: 'Remove', 'aria-label': `Remove the edge to ${edge.to}`, onclick: () => send({ op: 'removeEdge', index }) })),
          field('Only when', edge.when, value => send({ op: 'setEdgeWhen', index, value }), { key: `edge-${index}-when`, placeholder: '${compare.output.counts.changed} > 0' })))
          : el('p', { class: 'muted', text: 'Nothing runs after this step.' }),
        others.length ? el('div', { class: 'adder' }, target, el('button', { type: 'button', text: 'Add next step', onclick: () => send({ op: 'addEdge', from: node.id, to: target.value }) })) : null),
      incoming.length ? section('After', el('p', { class: 'muted', text: incoming.map(edge => edge.from).join(', ') })) : null,
      el('button', { type: 'button', class: 'danger', text: 'Delete step', title: 'Ctrl+Z undoes it', onclick: () => { send({ op: 'removeNode', id: node.id }); select(null); } })
    ];
  }

  // ------------------------------------------------------------------------------------- render

  function render() {
    if (!data) return;
    const workflow = data.workflow;
    $('title').textContent = workflow ? workflow.title || workflow.id || 'Workflow' : 'Workflow';
    $('subtitle').textContent = workflow ? `${workflow.id || '?'} · ${workflow.version || '?'} · ${workflow.nodes.length} step${workflow.nodes.length === 1 ? '' : 's'}` : '';
    const message = data.error || notice;
    $('notice').hidden = !message;
    $('notice').textContent = message;
    ['arrange', 'run'].forEach(id => { $(id).disabled = !data.editable; });
    $('run').title = data.problems && data.problems.length ? 'Fix the problems first' : 'Run this workflow (Run Workflow…)';
    if (data.problems && data.problems.length) $('run').disabled = true;

    $('palette').replaceChildren(...(data.catalog || []).map(step => el('button', {
      type: 'button', class: 'step', disabled: !data.editable, 'data-type': step.type,
      title: `${step.type}${step.asks ? ` · asks before it ${step.asks}` : ''}${step.usesModel ? ' · uses the model' : ''}${step.description ? `\n${step.description}` : ''}`,
      onclick: () => send({ op: 'addNode', type: step.type })
    }, el('strong', { text: step.title }), el('small', { text: step.type }))));

    const problems = data.problems || [];
    $('problem-count').textContent = problems.length ? `(${problems.length})` : '';
    $('problems').replaceChildren(...(problems.length ? problems.map(problem => el('li', {},
      el('button', { type: 'button', class: 'problem', onclick: () => { if (problem.nodes[0]) select({ kind: 'node', id: problem.nodes[0] }); } },
        el('code', { text: problem.where }), ` ${problem.message}`))) : [el('li', { class: 'muted', text: data.editable ? 'None' : '' })]));

    if (!data.editable) {
      $('edges').replaceChildren();
      $('nodes').replaceChildren();
      $('panel').replaceChildren();
      return;
    }
    if (selected && !workflow.nodes.some(node => node.id === selected.id)) { selected = null; remember(); }
    drawCanvas();
    // Keep the field being edited focused when the page is drawn again.
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : undefined;
    const node = selected && workflow.nodes.find(candidate => candidate.id === selected.id);
    $('panel').replaceChildren(...(node ? nodePanel(node) : workflowPanel()).filter(Boolean));
    if (focused) { const again = $('panel').querySelector(`[data-key="${CSS.escape(focused)}"]`); if (again) again.focus(); }
  }

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'load') { data = message; notice = ''; render(); }
    if (message.type === 'editFailed') { notice = message.message; render(); }
  });
  $('arrange').addEventListener('click', () => send({ op: 'arrange' }));
  $('json').addEventListener('click', () => vscode.postMessage({ type: 'openAsJson' }));
  $('run').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
  $('canvas').addEventListener('click', event => { if (event.target === $('canvas')) select(null); });
  vscode.postMessage({ type: 'ready' });
})();
