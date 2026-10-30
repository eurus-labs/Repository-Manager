// The Requirement editor: a clarification file (dou) as a form, the requirements it clarifies, and
// its Markdown. Ported from the Python dou-editor's page; the extension (RequirementEditorProvider)
// answers what the page used to ask its local server, and VS Code owns saving and unsaved state.
'use strict';
const vscode = acquireVsCodeApi();
const DISCUSSION = ['open', 'investigating', 'resolved'];
const STATUSES = { 1: ['open', 'proposed', 'agreed'], 2: DISCUSSION, 3: DISCUSSION };
const UNRESOLVED = new Set(['open', 'investigating', 'proposed']);
const DATE_FIELDS = new Set(['Created at', 'Updated at']);
const SHORT_FIELDS = new Set(['Related requirements', 'Requirement', 'Confirmed by', 'Next action', 'Current conclusion']);
const WIDE_FIELDS = new Set(['Scope', 'Desired outcome', 'Approach', 'Proposed acceptance criteria', 'Visual aids', 'Question', 'Questions', 'Current understanding', 'Analysis / Proposal', 'References', 'History', 'Resolution', 'Requirement impact']);
const SUMMARY_FIELDS = ['Question', 'Questions'];
// First checklist question if there is one, else the first line.
const summaryText = text => (text.split('\n').map(l => l.match(/^\s*[-*]\s*\[[ xX]\]\s*(.+)$/)).find(Boolean)?.[1] || text.split('\n')[0]).trim();
const openQuestions = text => text.split('\n').filter(l => /^\s*[-*]\s*\[ \]/.test(l)).length;
const CONCLUSION_FIELDS = ['Current conclusion', 'Resolution'];
// v3 fields are shown in four groups; each heading goes before the group's first field.
const GROUPS = { 'Scope': '1 · Scope & requirement', 'Questions': '2 · Analysis', 'History': '3 · History', 'Next action': '4 · Next action' };
const ROLES = ['Dev', 'PO', 'User', 'Expert', 'Reviewer'];  // free choice; not authentication
const EVENT_TYPES = ['response', 'question', 'proposal', 'conclusion', 'reopened', 'feedback'];
const HINTS = {
  'Desired outcome': 'The functionality, feature or result wanted, stated so it can be checked.',
  'Requirement': 'The one requirement this item clarifies, e.g. REQ-012; Pending until known; None when the item is not about a requirement.',
  'Questions': 'What is known, then each open question as "- [ ] …"; tick "- [x]" when answered. Unticked questions keep the requirement Not ready.',
  'Next action': 'Owner: next step, e.g. "Dev (Minh): ask the API owner for the retry contract".',
  'Approach': 'The proposed approach, with its impact, risks and how to verify it.',
  'Proposed acceptance criteria': 'Checkable conditions, one per line, proposed for the PO to decide. Record the PO decision as a History event.',
  'Visual aids': 'One per line: "Label: target". Target: an https link (previewed if it ends in .png/.jpg/.gif/.webp) or an image path relative to this file.',
};
const imageCache = new Map();  // image path -> Promise of a blob: URL
// Same rule as the server: "- AC1: Given ..., when ..., then ...". Other lines are notes.
const CRITERION = /^\s*[-*]\s*(AC\d+):\s*(\S.*?)\s*$/;
const STATE_TONE = { accepted: 'resolved', rejected: 'rejected', proposed: 'investigating', changed: 'investigating' };
// Field holding requirement IDs per schema version (v1 writes them inside Requirement impact).
const REQUIREMENT_FIELD = { 1: 'Requirement impact', 2: 'Related requirements', 3: 'Requirement' };
// Same rule as the server: REQ-012, FR-7, REQ-AUTH-3; not CLR-001-Q01.
const REQUIREMENT_ID = /(?<![\w-])[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*[-_]\d+(?![\w-])/g;
// A v3 Requirement field holds one ID written on purpose, e.g. REQ-012, REQ_012 or R_F4722.
const EXPLICIT_ID = /^[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*$/;

let doc = null;        // last parse result from the server, plus content/hash/filename
let values = [];       // current text of each field (LF line endings)
let baseline = [];     // the same, as parsed; unchanged fields are written back untouched
let controls = [];     // field index -> the element showing it
let refViews = [];     // redraw functions for reference lists and requirement chips
let index = [];        // items from the .md files beside the document (saved state)
let catalog = { configured: false, requirements: [] };  // from --requirements
let dirty = false, sourceMode = false, view = 'items';
let selected = null;     // the item (or file-level section) shown in the detail pane
let selectedReq = null;  // the requirement shown in the Requirements view
let statusFilter = 'all', reqFilter = 'all';

const $ = selector => document.querySelector(selector);
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(child => child != null));
  return node;
}
function message(text, error = false) {
  $('#message').textContent = text;
  $('#message').className = error ? 'error' : '';
}
function setDirty(value) {
  // VS Code shows the unsaved dot, asks before closing, and keeps a backup for hot exit. Every
  // edit is reported, not only the first, so the backup follows the latest text.
  if (value || value !== dirty) vscode.postMessage({ type: 'dirty', dirty: value });
  dirty = value;
  // In the form, how many fields differ from the file; the Markdown view edits the whole text.
  const edited = !sourceMode && doc ? values.filter((v, i) => v.trim() !== baseline[i]).length : 0;
  $('#state').textContent = !value ? 'All changes saved' : edited ? `● ${edited} unsaved field${edited === 1 ? '' : 's'}` : '● Unsaved changes';
  $('#state').className = value ? 'dirty' : '';
}

// Requests go to the extension, which answers with { ok, data } or { error }.
let requestId = 0;
const pending = new Map();
function api(method, path, body) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    vscode.postMessage({ type: 'request', id, method, path, body });
  });
}

// Local time with offset at second precision, e.g. 2026-10-27T14:05:09+07:00.
function isoNow() {
  const d = new Date(), pad = n => String(Math.abs(n)).padStart(2, '0'), offset = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}
function formatDate(value) {
  const date = new Date(value);
  return isNaN(date) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
const lf = text => text.replace(/\r\n/g, '\n');
const newline = () => (doc.content.includes('\r\n') ? '\r\n' : '\n');
const decode = text => JSON.parse(text.replace(/^```json\s*/, '').replace(/```\s*$/, ''));
const encode = list => '```json\n' + JSON.stringify(list, null, 2) + '\n```';
const fieldIndex = (item, label) => doc.fields.findIndex(f => f.inquiry === item && f.label === label);

// Rebuild the Markdown: spans are UTF-16 offsets (JavaScript string indexes), spliced from the end.
function content() {
  if (sourceMode) return $('#source').value.replace(/\n/g, newline());
  let text = doc.content;
  for (let i = doc.fields.length - 1; i >= 0; i--) {
    const value = values[i].trim();
    if (value === baseline[i]) continue;
    const f = doc.fields[i];
    text = text.slice(0, f.start) + ('\n' + value + '\n\n').replace(/\n/g, newline()) + text.slice(f.end);
  }
  return text;
}

function setValue(i, value) {
  values[i] = value;
  const control = controls[i];
  if (control && control.value !== undefined && control.value !== value) control.value = value;
  control?.closest('.field')?.classList.toggle('edited', value.trim() !== baseline[i]);
  setDirty(true);
  if (doc.fields[i].inquiry) drawFacts(doc.fields[i].inquiry);
  if (doc.fields[i].label === 'Status') {
    updateStatus(doc.fields[i].inquiry);
    const questions = fieldIndex(doc.fields[i].inquiry, 'Questions');
    if (doc.version === 3 && value === 'resolved' && questions >= 0 && openQuestions(values[questions]))
      message(`${doc.fields[i].inquiry}: tick every question before resolving; Save will refuse ${openQuestions(values[questions])} open question(s).`, true);
  }
  updateRailCounts();
  drawOutline();
  applyFilter();
}

function updateStatus(item) {
  const select = document.querySelector(`section[data-item="${item}"] select.status`);
  if (select) select.dataset.status = values[fieldIndex(item, 'Status')];
}

// What an item's list entry and header show: its progress, read from the current values.
function itemFacts(item) {
  const value = label => { const n = fieldIndex(item, label); return n < 0 ? null : values[n]; };
  const facts = { status: value('Status') };
  const questions = value('Questions');
  if (doc.version === 3 && questions !== null) {
    const boxes = questions.split('\n').filter(l => /^\s*[-*]\s*\[[ xX]\]/.test(l)).length;
    facts.questions = { total: boxes, done: boxes - openQuestions(questions) };
  }
  let history = [];
  try { history = value('History') === null ? null : decode(value('History')); } catch { history = []; }
  if (history) facts.responses = history.length;
  if (doc.version === 3) {
    let states = [];
    try { states = criteriaStates(value('Proposed acceptance criteria') || '', history || [], aidsOf(item)); } catch { /* reported on save */ }
    facts.criteria = { total: states.length, accepted: states.filter(s => s.state === 'accepted').length };
    const next = (value('Next action') || '').trim().match(/^([^:\n]{2,60}):\s*\S/);
    facts.owner = next ? next[1].trim() : '';
    facts.outcome = value('Desired outcome') || '';
  }
  facts.requirements = requirementsOf(doc.version, value(REQUIREMENT_FIELD[doc.version]) || '');
  const summary = SUMMARY_FIELDS.map(label => fieldIndex(item, label)).find(n => n >= 0);
  facts.summary = doc.version === 3 && !isPlaceholder(facts.outcome) ? facts.outcome.split('\n')[0].trim() : summary >= 0 ? summaryText(values[summary]) : '';
  return facts;
}

// The strip under an item's title: what keeps it from being resolved, and who acts next.
function drawFacts(item) {
  const section = document.getElementById(item);
  if (!section) return;
  const facts = itemFacts(item);
  const cell = (label, value, part) => el('div', { className: 'fact' }, el('span', { className: 'label', textContent: label }), el('strong', { textContent: value }),
    part ? el('span', { className: 'meter' }, Object.assign(el('span'), { style: `width: ${part.total ? Math.round(100 * part.done / part.total) : 0}%` })) : null);
  const cells = [];
  if (facts.questions) cells.push(cell('Questions', `${facts.questions.done} / ${facts.questions.total} answered`, facts.questions));
  if (facts.criteria) cells.push(cell('Acceptance', `${facts.criteria.accepted} / ${facts.criteria.total} accepted`, { done: facts.criteria.accepted, total: facts.criteria.total }));
  if (facts.responses !== undefined) cells.push(cell('Responses', String(facts.responses)));
  if (facts.owner !== undefined) {
    const owner = cell('Owner', facts.owner || 'None');
    if (!facts.owner && UNRESOLVED.has(facts.status)) owner.classList.add('missing');
    cells.push(owner);
  }
  section.querySelector('.facts').replaceChildren(...cells);
  section.querySelector('.facts').hidden = !cells.length;
  section.querySelector('.clarifies').replaceChildren(...(facts.requirements.length ? [el('span', { className: 'note', textContent: 'Clarifies' }),
    ...facts.requirements.flatMap(id => {
      const chip = el('button', { type: 'button', className: 'chip req', textContent: id, title: 'Open in Requirements' });
      chip.onclick = () => showView('reqs', id);
      return [chip, el('span', { textContent: definitions(id)[0]?.title || '' })];
    })] : []));
}

/* ---------- rendering ---------- */

function render() {
  baseline = doc.fields.map(f => lf(f.value));
  values = [...baseline];
  controls = [];
  refViews = [];
  const root = $('#form');
  root.replaceChildren();
  const sections = new Map();
  doc.fields.forEach((f, i) => {
    const key = f.inquiry || f.label;
    if (!sections.has(key)) {
      const section = f.inquiry ? itemSection(f.inquiry) : el('section', { id: 'section-' + f.label }, el('h2', { textContent: f.label }));
      sections.set(key, section);
      root.append(section);
    }
    const section = sections.get(key);
    // v3: each of the four groups is its own card; v1/v2 items keep their fields in one card.
    if (f.inquiry && doc.version === 3 && GROUPS[f.label]) section.querySelector('.item-body').append(groupCard(f.inquiry, GROUPS[f.label]));
    const field = renderField(f, i);
    if (!field) return;
    if (f.inquiry && f.label === 'Status') section.querySelector('.status-slot').append(field);
    else ([...section.querySelectorAll('.grid')].pop() || section).append(field);
  });
  for (const item of doc.items) { updateStatus(item.id); updateConclusion(item.id); drawFacts(item.id); }
  const ids = [...root.children].map(section => section.id);
  if (!ids.includes(selected)) selected = doc.items[0]?.id || ids[0] || null;
  updateRailCounts();
  drawOutline();
  applyFilter();
  showSelected();
}

function itemSection(item) {
  const head = el('div', { className: 'item-head' },
    el('div', { className: 'item-title' }, el('h2', { textContent: item }), el('div', { className: 'status-slot' })),
    el('div', { className: 'clarifies' }));
  const body = el('div', { className: 'item-body' });
  const section = el('section', { id: item }, head, el('div', { className: 'facts' }), body);
  section.dataset.item = item;
  if (doc.version >= 2) {
    const created = values[fieldIndex(item, 'Created at')], updated = values[fieldIndex(item, 'Updated at')];
    head.querySelector('.item-title').append(el('span', { className: 'dates', textContent: `Created ${formatDate(created)} · Updated ${formatDate(updated)}`, title: `${created} / ${updated}` }));
  }
  if (doc.version === 3) {
    section.insertBefore(el('nav', { className: 'jump', ariaLabel: 'Sections of ' + item }, ...Object.values(GROUPS).map((name, n) =>
      el('a', { href: `#${item}-g${n + 1}` }, el('span', { className: 'num', textContent: String(n + 1) }), name.replace(/^\d+ · /, '')))), body);
  } else {
    body.append(el('div', { className: 'group-card' }, el('div', { className: 'grid' })));
  }
  return section;
}

function groupCard(item, name) {
  const n = name.match(/^\d+/)[0];
  return el('div', { className: 'group-card', id: `${item}-g${n}` },
    el('h3', {}, el('span', { className: 'num', textContent: n }), name.replace(/^\d+ · /, '')), el('div', { className: 'grid' }));
}

/* ---------- selection: one item at a time in the detail pane ---------- */

function selectItem(id) {
  selected = id;
  showSelected();
  drawOutline();
  applyFilter();
}

function showSelected() {
  for (const section of $('#form').children) section.hidden = section.id !== selected;
}

function renderField(f, i) {
  if (DATE_FIELDS.has(f.label)) return null;  // shown in the item header; the server maintains them
  const wrapper = el('div', { className: 'field' + (WIDE_FIELDS.has(f.label) || !f.inquiry ? ' wide' : '') });
  // Context and Scope already carry their name in the section heading; Status sits beside the item ID.
  // History and Next action have their own group heading, so their label would repeat it.
  const ownGroup = (doc.version === 3 && (f.label === 'History' || f.label === 'Next action')) || f.label === 'Status';
  if (f.inquiry) wrapper.append(el('label', { className: 'label' + (ownGroup ? ' visually-hidden' : ''), textContent: f.label, htmlFor: 'f' + i }));
  if (f.inquiry && doc.version === 3 && HINTS[f.label]) wrapper.append(el('span', { className: 'hint', textContent: HINTS[f.label] }));
  if (doc.version >= 2 && f.label === 'History') wrapper.append(historyView(f.inquiry, i));
  else if (doc.version >= 2 && f.label === 'References') wrapper.append(referencesView(f.inquiry, i));
  else if (f.label === 'Status') {
    const select = el('select', { id: 'f' + i, className: 'status' }, ...STATUSES[doc.version].map(s => el('option', { value: s, textContent: s })));
    select.value = values[i];
    select.addEventListener('change', () => setValue(i, select.value));
    controls[i] = select;
    wrapper.append(select);
  } else {
    const area = el('textarea', { id: 'f' + i, value: values[i], className: SHORT_FIELDS.has(f.label) ? 'short' : '' });
    if (!f.inquiry) area.setAttribute('aria-label', f.label);
    area.addEventListener('input', () => setValue(i, area.value));
    controls[i] = area;
    wrapper.append(area);
    if (f.inquiry && doc.version === 3 && f.label === 'Questions') {
      const list = el('ul', { className: 'checklist' });
      const draw = () => {
        const lines = values[i].split('\n');
        list.replaceChildren(...lines.map((line, n) => {
          const m = line.match(/^(\s*[-*]\s*\[)([ xX])(\]\s*)(.*)$/);
          if (!m) return null;
          const box = el('input', { type: 'checkbox', checked: m[2] !== ' ' });
          box.onchange = () => {
            const next = values[i].split('\n');
            next[n] = m[1] + (box.checked ? 'x' : ' ') + m[3] + m[4];
            setValue(i, next.join('\n'));
            draw();
          };
          return el('li', {}, el('label', {}, box, el('span', { textContent: m[4] })));
        }).filter(Boolean));
      };
      area.addEventListener('input', draw);
      refViews.push(draw);
      draw();
      area.before(list);  // the checklist is what people use; the text below edits it in full
    }
    if (f.inquiry && doc.version === 3 && f.label === 'Next action') {
      const warning = el('div', { className: 'warn' });
      const check = () => {
        const status = values[fieldIndex(f.inquiry, 'Status')];
        warning.textContent = UNRESOLVED.has(status) && !/^[^:\n]{2,60}:\s*\S/.test(values[i].trim()) ? 'Name an owner: “Owner: next step”.' : '';
      };
      area.addEventListener('input', check);
      refViews.push(check);
      check();
      wrapper.append(warning);
    }
    if (f.inquiry && doc.version === 3 && f.label === 'Proposed acceptance criteria') {
      const draw = criteriaView(f.inquiry, i, area);
      area.addEventListener('input', () => draw());
      wrapper.append(draw.box);
    }
    if (f.inquiry && doc.version === 3 && f.label === 'Visual aids') {
      const draw = visualAids(i);
      // AC decisions record the Visual aids they were made on, so their state can change too.
      area.addEventListener('input', () => { draw.later(); redrawViews(); });
      wrapper.append(draw.box);
    }
    if (f.inquiry && f.label === REQUIREMENT_FIELD[doc.version]) {
      const chips = requirementChips(i);
      area.addEventListener('input', () => redrawViews());  // chips, criteria note, Ready counts
      wrapper.append(chips.box);
    }
  }
  return wrapper;
}

const requirementIds = text => [...new Set(text.match(REQUIREMENT_ID) || [])];
// v1/v2 mention IDs in free text; a v3 item names exactly one.
const requirementsOf = (version, text) => version === 3 ? (EXPLICIT_ID.test(text.trim()) ? [text.trim()] : []) : requirementIds(text);
const definitions = id => catalog.requirements.filter(r => r.id === id);

// Requirement IDs in a field, as chips that open the Requirements view.
function requirementChips(i) {
  const box = el('div', { className: 'chips' });
  const draw = () => box.replaceChildren(...requirementsOf(doc.version, values[i]).map(id => {
    const defs = definitions(id);
    const chip = el('button', { type: 'button', className: 'chip', textContent: id, title: defs[0]?.title || 'Open in Requirements' });
    chip.onclick = () => showView('reqs', id);
    const missing = catalog.configured && !defs.length ? el('span', { className: 'warn', textContent: 'not found' }) : null;
    return el('span', {}, chip, missing);
  }));
  draw.box = box;
  refViews.push(draw);
  draw();
  return draw;
}

// v3 has no Current conclusion field: the latest conclusion event, unless reopened later.
// Feedback after a settled conclusion is the signal to check whether it still holds.
function latestConclusion(history) {
  const at = history.findLastIndex(e => e.type === 'conclusion' || e.type === 'reopened');
  if (at < 0) return null;
  const feedback = history.slice(at + 1).filter(e => e.type === 'feedback');
  return { event: history[at], settled: history[at].type === 'conclusion', feedbackSince: feedback.length };
}

function updateConclusion(item) {
  const box = document.querySelector(`section[data-item="${item}"] .conclusion`);
  if (!box) return;
  let latest = null;
  try { latest = latestConclusion(decode(values[fieldIndex(item, 'History')])); } catch { /* shown on save */ }
  box.dataset.state = latest ? (latest.settled ? 'settled' : 'reopened') : 'none';
  box.textContent = !latest ? '' : latest.settled
    ? `Conclusion (${latest.event.author}, ${formatDate(latest.event.at)}): ${latest.event.content}`
      + (latest.feedbackSince ? `\n⚠ ${latest.feedbackSince} feedback since this conclusion. Submit a reopened event if it changes the outcome.` : '')
    : `Reopened by ${latest.event.author}: ${latest.event.content}`;
}

// "- Label: target" or "- target"; the target is an http(s) URL or a path relative to this file.
function visualAidEntries(text) {
  return text.split('\n').map(line => line.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean).map(line => {
    const match = line.match(/^(?:(.+?):\s+)?(\S+)$/);
    if (!match) return { text: line };
    const [, label, target] = match;
    if (/^https:\/\//i.test(target) && /\.(png|jpe?g|gif|webp)$/i.test(target.split(/[?#]/)[0])) return { label: label || target, remote: target };
    if (/^https?:\/\//i.test(target)) return { label: label || target, url: target };
    if (/\.(png|jpe?g|gif|webp)$/i.test(target)) return { label: label || target, image: target };
    if (target.includes('/') || /\.\w+$/.test(target)) return { label: label || target, path: target };
    return { text: line };
  });
}

function imageUrl(relative) {
  if (!imageCache.has(relative)) {
    imageCache.set(relative, (async () => {
      const { data, kind } = await api('GET', '/api/asset?path=' + encodeURIComponent(relative));
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type: kind }));
    })());
  }
  return imageCache.get(relative);
}

function openImage(src, label) {
  const close = el('button', { type: 'button', textContent: 'Close' });
  const dialog = el('dialog', {}, el('h2', { textContent: label }), el('img', { src, alt: label, referrerPolicy: 'no-referrer' }), el('div', { className: 'actions' }, close));
  close.onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}

function visualAids(i) {
  const box = el('div', { className: 'aids' });
  let timer;
  const draw = () => box.replaceChildren(...visualAidEntries(values[i]).map(entry => {
    if (entry.url) {
      return el('div', {}, el('a', { href: entry.url, target: '_blank', rel: 'noopener noreferrer', textContent: entry.label, title: entry.url }));
    }
    if (entry.remote) {
      // Loaded by the browser straight from that site (with whatever login it has there),
      // without sending this page's address. Falls back to the link when it cannot load.
      const host = new URL(entry.remote).host;
      const name = entry.label === entry.remote ? new URL(entry.remote).pathname.split('/').pop() || host : entry.label;
      const link = el('a', { href: entry.remote, target: '_blank', rel: 'noopener noreferrer', textContent: name, title: entry.remote });
      const image = el('img', { src: entry.remote, alt: entry.label, title: 'Click to enlarge', referrerPolicy: 'no-referrer' });
      const figure = el('figure', { className: 'aid' }, image, el('figcaption', {}, link));
      image.onclick = () => openImage(entry.remote, entry.label);
      image.onerror = () => image.replaceWith(el('div', { className: 'warn fallback',
        textContent: `Preview unavailable: ${host} did not return the image here (it may need you to sign in). Open the link instead.` }));
      return figure;
    }
    if (entry.image) {
      // Caption is the label; the path stays available as a tooltip.
      const figure = el('figure', { className: 'aid' }, el('figcaption', { textContent: entry.label === entry.image ? entry.image.split('/').pop() : entry.label, title: entry.image }));
      imageUrl(entry.image).then(src => {
        const image = el('img', { src, alt: entry.label, title: 'Click to enlarge' });
        image.onclick = () => openImage(src, entry.label);
        figure.prepend(image);
      }, error => figure.append(el('div', { className: 'warn', textContent: error.message })));
      return figure;
    }
    if (entry.path) return el('div', {}, entry.label, el('span', { className: 'note', textContent: ` (${entry.path}; only PNG, JPEG, GIF and WebP images are previewed)` }));
    return el('div', { className: 'note', textContent: entry.text });
  }));
  draw.later = () => { clearTimeout(timer); timer = setTimeout(draw, 400); };
  draw.box = box;
  draw();
  return draw;
}

/* ---------- acceptance criteria and PO decisions ---------- */

const aidsOf = item => { const i = fieldIndex(item, 'Visual aids'); return i >= 0 ? values[i] : null; };

function parseCriteria(text) {
  return text.split('\n').map(line => line.match(CRITERION)).filter(Boolean).map(m => ({ id: m[1], text: m[2] }));
}

// Latest PO decision per criterion; a decision only counts for the exact text it was made on.
// Latest PO decision per criterion; it only counts for the exact criterion text, and
// for the Visual aids text, that the PO saw when deciding.
function criteriaStates(text, history, aids = null) {
  const latest = {};
  for (const event of history) {
    if (!Array.isArray(event.criteria)) continue;  // v3: a response listing criteria is a decision
    for (const entry of event.criteria) latest[entry.id] = { ...entry, author: event.author, at: event.at };
  }
  return parseCriteria(text).map(c => {
    const d = latest[c.id];
    const aidsChanged = d && aids !== null && typeof d.aids === 'string' && d.aids.trim() !== aids.trim();
    const state = !d ? 'proposed' : d.text !== c.text || aidsChanged ? 'changed' : d.decision;
    return { ...c, state, why: aidsChanged && d.text === c.text ? 'visual aids changed' : '', by: d && state !== 'changed' ? `${d.author}, ${formatDate(d.at)}` : '' };
  });
}

function criteriaView(item, i, area) {
  const history = () => decode(values[fieldIndex(item, 'History')]);
  const list = el('ul', { className: 'criteria' });
  const unlinked = el('div', { className: 'warn' });
  const add = el('button', { type: 'button', textContent: '+ Criterion' });
  const decide = el('button', { type: 'button', className: 'primary', textContent: 'PO decision…' });
  const draw = () => {
    let states = [];
    try { states = criteriaStates(values[i], history(), aidsOf(item)); } catch { /* invalid History is reported on save */ }
    list.replaceChildren(...states.map(c => {
      const badge = el('span', { className: 'badge', title: c.why, textContent: c.state === 'changed' ? 'changed since decision' + (c.why ? ` (${c.why})` : '') : c.state === 'rejected' ? 'rejected · rewrite or remove' : c.state });
      badge.dataset.status = STATE_TONE[c.state];
      return el('li', {}, el('strong', { textContent: c.id }), el('span', { className: 'text', textContent: c.text }), badge, c.by ? el('span', { className: 'note', textContent: c.by }) : null);
    }));
    decide.disabled = !states.length;
    decide.title = states.length ? '' : 'Add a criterion first';
    // Criteria count toward a requirement's Ready only when the item names one.
    const requirement = values[fieldIndex(item, 'Requirement')] ?? '';
    unlinked.textContent = states.length && !EXPLICIT_ID.test(requirement.trim()) ? 'These criteria count toward Ready only once Requirement names a requirement.' : '';
  };
  add.onclick = () => {
    // Never reuse an ID, including ones only left in earlier decisions.
    const used = [...parseCriteria(values[i]).map(c => c.id), ...history().flatMap(e => (e.criteria || []).map(c => c.id))];
    const next = 'AC' + (Math.max(0, ...used.map(id => Number(id.slice(2)))) + 1);
    const current = /^(-\s*)?(pending)?$/i.test(values[i].trim()) ? '' : values[i].trimEnd() + '\n';
    setValue(i, `${current}- ${next}: `);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    draw();
  };
  decide.onclick = () => decisionDialog(item, i, criteriaStates(values[i], history(), aidsOf(item)));
  draw.box = el('div', {}, list, unlinked, el('div', { className: 'criteria-actions' }, add, decide));
  refViews.push(draw);
  draw();
  return draw;
}

function decisionDialog(item, i, states) {
  const author = el('input', { type: 'text', value: remembered('po-author', remembered('author')), ariaLabel: 'PO name' });
  // One choice per criterion: accept, reject, or leave it as it is (undecided, or the earlier decision).
  const rows = states.map(c => {
    const leave = c.state === 'proposed' || c.state === 'changed' ? 'Later' : `Keep ${c.state}`;
    const choice = (value, label) => el('label', { className: 'opt' },el('input', { type: 'radio', name: 'decide-' + c.id, value, checked: !value }), el('span', { textContent: label }));
    const group = el('span', { className: 'decide', role: 'radiogroup', ariaLabel: 'Decision for ' + c.id },
      choice('accepted', 'Accept'), choice('rejected', 'Reject'), choice('', leave));
    const value = () => group.querySelector('input:checked').value;
    return { c, value, row: el('div', { className: 'criterion' }, el('strong', { textContent: c.id }), el('span', { textContent: c.text }), group) };
  });
  const tally = el('span', { className: 'note' });
  const warning = el('p', { className: 'warn' });
  const count = () => {
    const picked = rows.map(r => r.value());
    const n = value => picked.filter(p => p === value).length;
    tally.textContent = `${n('accepted')} accepted · ${n('rejected')} rejected · ${n('')} unchanged`;
    const rejected = rows.filter(r => r.value() === 'rejected').map(r => r.c.id);
    warning.textContent = rejected.length ? `${rejected.join(', ')} will need to be rewritten or removed before the requirement can be Ready.` : '';
  };
  const note = el('textarea', { placeholder: 'Optional note, e.g. why AC2 is rejected' });
  const record = el('button', { type: 'submit', className: 'primary', textContent: 'Record decision and save' });
  const cancel = el('button', { type: 'button', textContent: 'Cancel' });
  const form = el('form', {}, el('h2', { textContent: `PO decision · ${item}` }),
    el('p', { className: 'note', textContent: 'Recorded as role PO, together with the Visual aids shown now. The editor checks the role, not who you are; the approval of record is the pull request review.' }),
    el('label', { className: 'field' }, el('span', { className: 'label', textContent: 'PO name' }), author),
    el('fieldset', { className: 'criteria-pick' }, el('legend', { className: 'label', textContent: 'Criteria' }), ...rows.map(r => r.row)), warning,
    el('label', { className: 'field' }, el('span', { className: 'label', textContent: 'Note' }), note),
    el('div', { className: 'actions' }, tally, cancel, record));
  form.addEventListener('change', count);
  count();
  const dialog = el('dialog', {}, form);
  cancel.onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  form.onsubmit = async event => {
    event.preventDefault();
    const aids = aidsOf(item);
    const criteria = rows.filter(r => r.value()).map(r => ({ id: r.c.id, decision: r.value(), text: r.c.text, ...(aids === null ? {} : { aids }) }));
    if (!author.value.trim() || !criteria.length) { message('Enter the PO name and decide at least one criterion.', true); return; }
    remember('po-author', author.value.trim());
    const summary = criteria.map(c => `${c.id} ${c.decision}`).join(', ');
    const history = fieldIndex(item, 'History');
    const events = decode(values[history]);
    events.push({ id: 'EV-' + crypto.randomUUID(), at: isoNow(), author: author.value.trim(), role: 'PO',
      content: note.value.trim() ? `${summary}. ${note.value.trim()}` : summary, criteria });
    setValue(history, encode(events));
    dialog.close();
    redrawViews();
    await save();
  };
  document.body.append(dialog);
  dialog.showModal();
}

/* ---------- requirement readiness ---------- */

const isPlaceholder = text => /^(-\s*)?(pending|tbd)?$/i.test(text.trim());

// Reasons a requirement is not ready; an empty list means Ready.
const normalized = text => text.toLowerCase().replace(/[\s.]+/g, ' ').trim();

// What keeps a requirement from Ready, each with the step that removes it (the first is the
// Next action); an empty list means Ready. The requirement's acceptance criteria are those
// proposed in the items that clarify it.
function readiness(items, defs) {
  const reasons = [];
  const add = (rule, text, next, item) => reasons.push({ rule, text, next, item });
  if (!catalog.configured) add('found', 'No requirements source is set, so accepted criteria cannot be checked against the requirement text.', 'Set the requirements source.');
  else if (!defs.length) add('found', `Not found in ${catalog.root}.`, 'Check the ID, or add the requirement to the requirement documents.');
  if (!items.length) add('found', 'No clarification item is linked to this requirement.', 'Create a clarification for this requirement.');
  const requirementText = normalized(defs.map(d => d.title + '\n' + d.excerpt).join('\n'));
  let criteriaCount = 0;
  for (const item of items) {
    const v = item.values;
    if (UNRESOLVED.has(v.Status)) add('resolved', `${item.id} is ${v.Status}.`, `Settle ${item.id} and set its Status to resolved.`, item);
    if (item.version !== 3) continue;
    const open = openQuestions(v.Questions || '');
    if (open) add('questions', `${item.id}: ${open} open question${open === 1 ? '' : 's'}.`, `Answer and tick the open questions in ${item.id}.`, item);
    const states = criteriaStates(v['Proposed acceptance criteria'] || '', safeHistory(item), v['Visual aids'] ?? null);
    if (!states.length) continue;  // a pure question needs no criteria of its own
    criteriaCount += states.length;
    if (isPlaceholder(v['Desired outcome'] || '')) add('outcome', `${item.id}: desired outcome missing.`, `Write the desired outcome in ${item.id}.`, item);
    const undecided = states.filter(s => s.state === 'proposed' || s.state === 'changed');
    if (undecided.length) {
      add('criteria', `${item.id}: PO has not decided ${undecided.map(s => s.id + (s.state === 'changed' ? ` (changed since decision${s.why ? ': ' + s.why : ''})` : '')).join(', ')}.`,
        `Ask the PO to decide ${undecided.map(s => s.id).join(', ')} in ${item.id}.`, item);
    }
    // A rejected criterion must be rewritten (which makes it "changed") or removed.
    const rejected = states.filter(s => s.state === 'rejected');
    if (rejected.length) add('criteria', `${item.id}: ${rejected.map(s => s.id).join(', ')} rejected by the PO.`, `Rewrite or remove ${rejected.map(s => s.id).join(', ')} in ${item.id}.`, item);
    // Ready means the requirement itself says it: each accepted criterion appears in its text.
    if (defs.length) {
      const missing = states.filter(s => s.state === 'accepted' && !requirementText.includes(normalized(s.text)));
      if (missing.length) {
        const ids = missing.map(s => s.id).join(', ');
        add('written', `${item.id}: ${ids} accepted but not yet written into ${defs[0].file}.`, `Write ${ids} into ${defs[0].file}.`, item);
      }
    }
  }
  if (!criteriaCount) {
    add('criteria', 'No accepted criteria are available.', items.length ? 'Propose acceptance criteria in a clarification for this requirement.' : 'Create a clarification for this requirement.');
  }
  return reasons;
}
// The conditions of Ready, in the order the docs list them; each reason above names one.
const READY_RULES = [
  ['found', 'Found in the requirement documents and clarified by at least one item'],
  ['resolved', 'Every item for it is resolved'],
  ['questions', 'No unticked questions'],
  ['criteria', 'At least one criterion, each accepted by the PO on its current text'],
  ['outcome', 'Items that propose criteria have a Desired outcome'],
  ['written', 'Accepted criteria are written into the requirement text'],
];

// Names and roles, kept by the extension for every editor on this machine.
let memory = {};
function remembered(key, fallback = '') {
  return typeof memory[key] === 'string' && memory[key] ? memory[key] : fallback;
}
function remember(key, value) {
  memory[key] = value;
  vscode.postMessage({ type: 'remember', key, value });
}

function historyView(item, i) {
  const v3 = doc.version === 3;
  const box = el('div');
  const list = el('ol', { className: 'timeline' });
  const draw = () => {
    const events = decode(values[i]);
    list.replaceChildren(...events.map(e => {
      const kind = Array.isArray(e.criteria) ? 'AC decision' : e.type;
      const initials = String(e.author || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
      const role = el('span', { className: 'role', textContent: e.role });
      role.dataset.role = e.role;
      const li = el('li', {}, el('span', { className: 'avatar', textContent: initials, ariaHidden: 'true' }),
        el('div', { className: 'event' },
          el('div', { className: 'meta' }, el('strong', { textContent: e.author }), role, kind ? el('span', { className: 'chip', textContent: kind }) : null,
            el('time', { textContent: formatDate(e.at), title: e.at }), e.source ? el('span', { textContent: e.source }) : null),
          el('div', { className: 'body', textContent: e.content })));
      li.dataset.type = Array.isArray(e.criteria) ? 'decision' : e.type || 'response';
      return li;
    }));
    if (!events.length) list.replaceChildren(el('li', { className: 'empty', textContent: 'No responses yet.' }));
  };
  refViews.push(draw);

  // Inline composer: write a response and submit it (adds it, then saves the file).
  const author = el('input', { type: 'text', placeholder: 'Your name', value: remembered('author'), ariaLabel: 'Author' });
  const role = el('select', { ariaLabel: 'Role' }, ...ROLES.map(r => el('option', { textContent: r })));
  role.value = remembered('role', 'Dev');
  const type = v3 ? null : el('select', { ariaLabel: 'Event type' }, ...EVENT_TYPES.map(r => el('option', { textContent: r })));
  const source = el('input', { type: 'text', className: 'source', placeholder: 'Source (optional), e.g. Sprint 12 review, demo with the PO', ariaLabel: 'Source' });
  const text = el('textarea', { placeholder: v3 ? 'Write a response…' : 'Write a response, question, proposal, conclusion or feedback…', ariaLabel: 'Response' });
  // New input on a resolved item usually means it needs another look.
  const reopen = el('input', { type: 'checkbox', checked: true });
  const reopenLabel = el('label', { className: 'note reopen' }, reopen, ' Reopen this item (Status → investigating)');
  const syncReopen = () => { reopenLabel.hidden = !v3 || values[fieldIndex(item, 'Status')] !== 'resolved'; };
  refViews.push(syncReopen);
  const submit = el('button', { type: 'submit', className: 'primary', textContent: 'Submit' });
  // v3 has no event type, so the source takes its place in the first row.
  const form = el('form', { className: 'composer' }, el('div', { className: 'row' }, author, role, v3 ? source : type), v3 ? null : source, text,
    el('div', { className: 'actions' }, reopenLabel, el('span', { className: 'note', textContent: 'Submit adds the response and saves the file.' }), submit));
  form.onsubmit = async event => {
    event.preventDefault();
    const entry = { author: author.value.trim(), role: role.value, ...(v3 ? {} : { type: type.value }), content: text.value.trim() };
    if (source.value.trim()) entry.source = source.value.trim();
    if (!entry.author || !entry.content) { message('Fill in your name and the content before submitting.', true); return; }
    remember('author', entry.author);
    remember('role', entry.role);
    const events = decode(values[i]);
    events.push({ id: 'EV-' + crypto.randomUUID(), at: isoNow(), ...entry });
    setValue(i, encode(events));
    if (!v3 && entry.type === 'conclusion') setValue(fieldIndex(item, 'Current conclusion'), entry.content);
    if ((!v3 && entry.type === 'reopened') || (v3 && !reopenLabel.hidden && reopen.checked)) setValue(fieldIndex(item, 'Status'), 'investigating');
    draw();
    updateConclusion(item);
    text.value = '';
    source.value = '';
    await save();
  };
  syncReopen();
  draw();
  box.append(list, form, el('p', { className: 'note', textContent: 'History is append-only. Submit a new response to correct an earlier one.' }));
  return box;
}

function referencesView(item, i) {
  const box = el('div');
  const list = el('ul', { className: 'refs' });
  const backlinks = el('p', { className: 'note' });
  const draw = () => {
    const refs = decode(values[i]);
    list.replaceChildren(...refs.map((ref, n) => {
      const matches = index.filter(x => x.id === ref.item_id);
      const local = doc.items.some(x => x.id === ref.item_id);
      const open = el('button', { type: 'button', className: 'link', textContent: ref.item_id });
      open.onclick = () => openReference(ref.item_id, matches);
      const remove = el('button', { type: 'button', className: 'icon', textContent: '×', title: 'Remove reference', ariaLabel: 'Remove reference to ' + ref.item_id });
      remove.onclick = () => { const next = decode(values[i]); next.splice(n, 1); setValue(i, encode(next)); redrawViews(); };
      return el('li', {}, el('span', { className: 'chip', textContent: ref.relation }), open, `— ${ref.reason}`,
        local || matches.length === 1 ? null : el('span', { className: 'warn', textContent: matches.length ? '(ambiguous)' : '(not found beside this file)' }), remove);
    }));
    if (!refs.length) list.replaceChildren(el('li', { className: 'empty', textContent: 'No references.' }));
    // Includes unsaved edits of this file, so a new reference shows on its target at once.
    const incoming = traceItems().filter(x => x.id !== item && safeRefs(x).some(r => r.item_id === item));
    backlinks.textContent = incoming.length ? 'Referenced by: ' + incoming.map(x => `${x.id} (${x.file})`).join(', ') : '';
  };
  const add = el('button', { type: 'button', textContent: '+ Add reference' });
  add.onclick = () => openDialog('Reference another item', [
    { name: 'item', label: 'Item ID', suggestions: [...new Set([...doc.items.map(x => x.id), ...index.map(x => x.id)])].filter(id => id !== item) },
    { name: 'relation', label: 'Relation', options: ['related_to', 'depends_on', 'follows_up', 'supersedes'] },
    { name: 'reason', label: 'Reason', multiline: true },
  ], v => {
    const refs = decode(values[i]);
    refs.push({ item_id: v.item.toUpperCase(), relation: v.relation, reason: v.reason });
    setValue(i, encode(refs));
    redrawViews();
  });
  refViews.push(draw);
  draw();
  box.append(list, add, backlinks);
  return box;
}

function safeHistory(entry) {
  try { return decode(entry.values.History || '[]'); } catch { return []; }
}

function safeRefs(entry) {
  try { return decode(entry.values.References || '[]'); } catch { return []; }
}

function openReference(id, matches) {
  const local = document.getElementById(id);
  if (local) {
    statusFilter = 'all';
    $('#search').value = '';
    selectItem(id);
    local.scrollIntoView({ behavior: 'smooth' });
  } else if (matches.length === 1) {
    const close = el('button', { type: 'button', textContent: 'Close' });
    const dialog = el('dialog', {}, el('h2', { textContent: `${id} · ${matches[0].file}` }),
      el('pre', { textContent: Object.entries(matches[0].values).map(([k, v]) => `${k}\n${v}`).join('\n\n') }),
      el('div', { className: 'actions' }, close));
    close.onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
  } else {
    message(`${id} is unavailable or ambiguous. Keep referenced Markdown files in the same folder.`, true);
  }
}

function openDialog(title, fields, submit) {
  const form = el('form', { method: 'dialog' }, el('h2', { textContent: title }));
  const inputs = {};
  for (const spec of fields) {
    let input;
    if (spec.options) input = el('select', {}, ...spec.options.map(o => el('option', { textContent: o })));
    else if (spec.multiline) input = el('textarea');
    else input = el('input', { type: 'text', autocomplete: 'off' });
    if (spec.suggestions) {
      const list = el('datalist', { id: 'dl-' + spec.name }, ...spec.suggestions.map(s => el('option', { value: s })));
      input.setAttribute('list', list.id);
      form.append(list);
    }
    input.required = true;
    inputs[spec.name] = input;
    form.append(el('label', { className: 'field' }, el('span', { className: 'label', textContent: spec.label }), input));
  }
  const cancel = el('button', { type: 'button', textContent: 'Cancel' });
  form.append(el('div', { className: 'actions' }, cancel, el('button', { type: 'submit', className: 'primary', textContent: 'Add' })));
  const dialog = el('dialog', {}, form);
  cancel.onclick = () => dialog.close();
  form.onsubmit = event => {
    event.preventDefault();
    const result = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value.trim()]));
    if (Object.values(result).some(v => !v)) return;
    dialog.close();
    submit(result);
  };
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}

function redrawViews() {
  refViews.forEach(draw => draw());
  updateRailCounts();
  if (view === 'reqs') drawTrace();
}

/* ---------- requirements view ---------- */

// Items of every clarification file beside this one; this file's items use unsaved values.
function traceItems() {
  const own = doc.items.map(item => {
    const itemValues = {};
    doc.fields.forEach((f, i) => { if (f.inquiry === item.id) itemValues[f.label] = values[i]; });
    return { file: doc.filename, version: doc.version, id: item.id, values: itemValues, local: true };
  });
  return [...index.filter(x => x.file !== doc.filename), ...own];
}

function itemLine(item) {
  const status = item.values.Status;
  const badge = el('span', { className: 'badge', textContent: status });
  badge.dataset.status = status;
  const open = el('button', { type: 'button', className: 'link', textContent: item.id });
  open.onclick = () => openItem(item);
  const question = SUMMARY_FIELDS.map(label => item.values[label]).find(Boolean) || '';
  const latest = item.version === 2 ? latestConclusion(safeHistory(item)) : null;
  const conclusion = UNRESOLVED.has(status) || item.version === 3 ? '' : CONCLUSION_FIELDS.map(label => item.values[label]).find(Boolean) || '';
  const feedback = latest?.settled && latest.feedbackSince ? el('span', { className: 'warn', textContent: `${latest.feedbackSince} feedback since conclusion` }) : null;
  return el('li', {}, badge, open, el('span', { className: 'note', textContent: item.local ? '(this file)' : `(${item.file})` }), feedback,
    el('div', { className: 'text', textContent: summaryText(question) + (conclusion ? '\nConclusion: ' + conclusion.split('\n')[0] : '') }));
}

const reqTabs = new Map();  // requirement ID -> the tab its card shows; kept across redraws

function drawTrace() {
  const byRequirement = groupByRequirement();
  const query = $('#req-search').value.trim().toLowerCase();
  // Document order of the requirement files; IDs that are not found come last.
  const order = id => { const n = catalog.requirements.findIndex(r => r.id === id); return n < 0 ? Infinity : n; };
  const ids = [...byRequirement.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b, undefined, { numeric: true }));
  const cards = [], outline = [];
  const counts = { all: ids.length, notready: 0, ready: 0, empty: 0, unresolved: 0, missing: 0 };
  for (const id of ids) {
    const items = byRequirement.get(id), defs = definitions(id);
    const unresolved = items.some(item => UNRESOLVED.has(item.values.Status));
    const missing = catalog.configured && !defs.length;
    const reasons = readiness(items, defs);
    const matches = { all: true, ready: !reasons.length, notready: reasons.length > 0, empty: !items.length, unresolved, missing };
    for (const key of Object.keys(counts)) if (key !== 'all' && matches[key]) counts[key]++;
    const text = [id, ...defs.map(d => d.title + '\n' + d.excerpt), ...items.map(item => item.id + '\n' + Object.values(item.values).join('\n'))].join('\n').toLowerCase();
    if (!matches[reqFilter] || (query && !text.includes(query))) continue;
    cards.push(requirementCard(id, items, defs, reasons));
    outline.push(requirementEntry(id, items, defs, reasons));
  }
  const unresolvedCount = counts.unresolved, missingCount = counts.missing, readyCount = counts.ready, emptyCount = counts.empty;
  // The detail pane shows one requirement: the chosen one while it is listed, else the first.
  if (!cards.some(card => card.id === 'req-' + selectedReq)) selectedReq = cards[0]?.id.slice(4) ?? null;
  for (const card of cards) card.hidden = card.id !== 'req-' + selectedReq;
  for (const entry of outline) entry.querySelector('button').setAttribute('aria-current', String(entry.dataset.req === selectedReq));
  drawSegs($('#req-filter'), [['all', 'All'], ['notready', 'Not ready'], ['ready', 'Ready'], ['empty', 'No clarification'], ['unresolved', 'Unresolved'], ['missing', 'Not found']]
    .filter(([key]) => key === 'all' || counts[key] || key === reqFilter).map(([key, label]) => [key, label, counts[key]]), reqFilter, value => { reqFilter = value; drawTrace(); });
  $('#req-summary').textContent = `${ids.length} requirement${ids.length === 1 ? '' : 's'} · ${readyCount} ready · ${emptyCount} without a clarification · ${unresolvedCount} with unresolved clarifications`
    + (missingCount ? ` · ${missingCount} not found` : '')
    + (catalog.skipped?.length ? ` · ${catalog.skipped.length} file(s) skipped` : '')
    + (catalog.truncated ? ' · scan limit reached' : '')
    + '. This file includes unsaved edits; other files are shown as saved.';
  const empty = ids.length ? (cards.length ? null : el('p', { className: 'empty', textContent: 'No requirement matches the filter.' }))
    : el('p', { className: 'empty', textContent: catalog.configured ? `No requirement found in ${catalog.root}.` : catalog.sync?.state === 'syncing' ? 'Fetching requirements…' : 'No requirements yet: set a requirements source above.' });
  $('#source-bar').replaceChildren(...sourceBar());
  $('#req-list').replaceChildren(...[empty, ...cards].filter(Boolean));
  $('#outline').replaceChildren(...outline);
}

// Filter buttons with their counts; the pressed one is the current filter.
function drawSegs(box, options, current, pick) {
  box.replaceChildren(...options.map(([value, label, count]) => {
    const button = el('button', { type: 'button', className: 'seg', textContent: count === undefined ? label : `${label} ${count}` });
    button.dataset.value = value;
    button.setAttribute('aria-pressed', String(value === current));
    button.onclick = () => pick(value);
    return button;
  }));
}

// A requirement in the list: its ID, Ready state, title, and one bar segment per Ready condition.
function requirementEntry(id, items, defs, reasons) {
  const failed = new Set(reasons.map(r => r.rule));
  const met = READY_RULES.filter(([rule]) => !failed.has(rule)).length;
  const state = el('span', { className: 'pill', textContent: !reasons.length ? 'Ready' : !items.length ? 'No clarification' : `Not ready · ${met}/${READY_RULES.length}` });
  state.dataset.status = !reasons.length ? 'resolved' : items.length ? 'investigating' : 'none';
  const resolved = items.filter(item => !UNRESOLVED.has(item.values.Status)).length;
  const button = el('button', { type: 'button', className: 'entry' },
    el('span', { className: 'entry-top' }, el('span', { className: 'entry-id', textContent: id }), state),
    el('span', { className: 'entry-text', textContent: defs[0]?.title || (catalog.configured ? 'Not found in the source' : '') }),
    items.length ? el('span', { className: 'bars', ariaHidden: 'true' }, ...READY_RULES.map(([rule]) => el('span', { className: failed.has(rule) ? '' : 'met' }))) : null,
    el('span', { className: 'entry-meta', textContent: items.length ? `${items.length} clarification${items.length === 1 ? '' : 's'} · ${resolved}/${items.length} resolved` : defs[0] ? `${defs[0].file}:${defs[0].line}` : '' }));
  button.onclick = () => { selectedReq = id; drawTrace(); };
  const li = el('li', {}, button);
  li.dataset.req = id;
  return li;
}

// One requirement: its title and place, then Requirement / Clarifications / Acceptance tabs.
function requirementCard(id, items, defs, reasons) {
  const def = defs[0];
  const ready = el('span', { className: 'badge ready', textContent: reasons.length ? 'Not ready' : 'Ready', title: reasons.map(r => r.text).join('\n') });
  ready.dataset.status = reasons.length ? 'investigating' : 'resolved';
  let where;
  if (!catalog.configured) where = el('span', { className: 'note', textContent: 'Set a requirements source to show the title and text.' });
  else if (!def) where = el('span', { className: 'warn', textContent: `Not found in ${catalog.root}. Check the ID or add the requirement.` });
  else {
    // With a Git source, locations open the file at the synced commit on the hosting site.
    // From a folder, a location opens the file in VS Code at that line.
    const places = defs.map(d => catalog.web
      ? el('a', { href: `${catalog.web}${d.file.split('/').map(encodeURIComponent).join('/')}?plain=1#L${d.line}`, target: '_blank', rel: 'noopener noreferrer', textContent: `${d.file}:${d.line}` })
      : catalog.source?.kind === 'folder' ? openLocation(d) : `${d.file}:${d.line}`);
    where = el('span', {}, ...places.flatMap((x, n) => n ? [' · ', x] : [x]), ' · Source document', defs.length > 1 ? ` · defined ${defs.length} times` : '');
  }
  const criteria = acceptanceOf(items);
  const panels = {
    requirement: () => requirementPanel(id, def),
    clarifications: () => clarificationsPanel(id, def, items),
    acceptance: () => acceptancePanel(criteria),
  };
  const tabs = [['requirement', 'Requirement'], ['clarifications', `Clarifications · ${items.length}`], ['acceptance', `Acceptance · ${criteria.length}`]];
  let panel = panels[reqTabs.get(id) || 'requirement']();
  const bar = el('div', { className: 'subtabs', role: 'tablist', ariaLabel: id });
  for (const [key, label] of tabs) {
    const tab = el('button', { type: 'button', role: 'tab', textContent: label });
    tab.dataset.tab = key;
    tab.setAttribute('aria-selected', String(key === (reqTabs.get(id) || 'requirement')));
    tab.onclick = () => {
      reqTabs.set(id, key);
      bar.querySelectorAll('[role=tab]').forEach(t => t.setAttribute('aria-selected', String(t === tab)));
      const next = panels[key]();
      panel.replaceWith(next);
      panel = next;
    };
    bar.append(tab);
  }
  return el('section', { id: 'req-' + id, className: 'req-card' },
    el('div', { className: 'req-head' }, el('span', { className: 'req-id', textContent: id }), ready),
    el('h2', { className: 'req-name', textContent: def?.title || id }),
    el('div', { className: 'req-meta' }, where),
    nextAction(id, def, items, reasons), readinessList(reasons),
    el('div', { className: 'req-tabs' }, bar, panel));
}

// Each condition of Ready, met or not, with the reasons that keep it unmet.
function readinessList(reasons) {
  const met = READY_RULES.filter(([rule]) => !reasons.some(r => r.rule === rule)).length;
  return el('div', { className: 'readiness' },
    el('h3', {}, 'Readiness ', el('span', { className: 'note', textContent: `${met} of ${READY_RULES.length} conditions met` })),
    el('ul', {}, ...READY_RULES.map(([rule, label]) => {
      const why = reasons.filter(r => r.rule === rule);
      const li = el('li', { className: why.length ? 'unmet' : 'met' }, el('span', { className: 'mark', ariaLabel: why.length ? 'Not met' : 'Met', role: 'img' }),
        el('span', { className: 'condition' }, el('span', { textContent: label }), ...why.map(r => el('span', { className: 'why', textContent: r.text }))));
      return li;
    })));
}

function requirementPanel(id, def) {
  const box = el('div', { className: 'subpanel', role: 'tabpanel' });
  box.append(def?.excerpt ? el('blockquote', { className: 'req-text', textContent: def.excerpt })
    : el('p', { className: 'empty', textContent: catalog.configured ? 'This requirement is not in the source, so there is no text to show.' : 'Set a requirements source to show the text.' }));
  return box;
}

// The step that removes the first reason the requirement is not Ready, with its button.
function nextAction(id, def, items, reasons) {
  const next = reasons[0];
  let action = null;
  if (next && !catalog.configured) {
    action = el('button', { type: 'button', textContent: 'Set source…' });
    action.onclick = () => sourceDialog(catalog.source || { kind: 'none' });
  } else if (next && !items.length && doc.version === 3) {
    action = createButton(id, def);
  } else if (next?.item) {
    action = el('button', { type: 'button', className: 'primary', textContent: `Open ${next.item.id}` });
    action.onclick = () => openItem(next.item);
  }
  const box = el('div', { className: 'next-action' + (next ? '' : ' done') },
    el('div', {}, el('span', { className: 'label', textContent: 'Next action' }), el('p', { textContent: next ? next.next : 'None: this requirement is Ready.' })), action);
  return box;
}

function clarificationsPanel(id, def, items) {
  const box = el('div', { className: 'subpanel', role: 'tabpanel' });
  box.append(items.length ? el('ul', { className: 'linked' }, ...items.map(itemLine))
    : el('p', { className: 'empty', textContent: 'No clarification is linked to this requirement yet.' }));
  if (doc.version === 3) box.append(el('div', { className: 'criteria-actions' }, createButton(id, def)));
  return box;
}

// Acceptance criteria proposed for a requirement by its v3 items, with the PO's latest decision.
function acceptanceOf(items) {
  return items.filter(item => item.version === 3).flatMap(item =>
    criteriaStates(item.values['Proposed acceptance criteria'] || '', safeHistory(item), item.values['Visual aids'] ?? null).map(c => ({ ...c, item })));
}

function acceptancePanel(criteria) {
  const box = el('div', { className: 'subpanel', role: 'tabpanel' });
  if (!criteria.length) {
    box.append(el('p', { className: 'empty', textContent: 'No acceptance criteria proposed yet. A clarification proposes them in its Proposed acceptance criteria; the PO accepts or rejects each one.' }));
    return box;
  }
  box.append(el('ul', { className: 'criteria' }, ...criteria.map(c => {
    const badge = el('span', { className: 'badge', title: c.why, textContent: c.state === 'changed' ? 'changed since decision' : c.state === 'rejected' ? 'rejected · rewrite or remove' : c.state });
    badge.dataset.status = STATE_TONE[c.state];
    const open = el('button', { type: 'button', className: 'link', textContent: c.item.id });
    open.onclick = () => openItem(c.item);
    return el('li', {}, el('strong', { textContent: c.id }), badge, el('span', { textContent: c.text }), el('span', { className: 'note' }, open, c.by ? ` · ${c.by}` : ''));
  })));
  return box;
}

function createButton(id, def) {
  const create = el('button', { type: 'button', className: 'create primary', textContent: '+ Create clarification' });
  create.onclick = () => createItemFor(id, def);
  return create;
}

function openItem(item) {
  if (item.local) { showView('items'); openReference(item.id, []); }
  else openReference(item.id, [item]);
}

function openLocation(definition) {
  const link = el('button', { type: 'button', className: 'link', textContent: `${definition.file}:${definition.line}`, title: 'Open in the editor' });
  link.onclick = () => vscode.postMessage({ type: 'openLocation', file: definition.file, line: definition.line });
  return link;
}

function markRail() {
  $('#tab-items').setAttribute('aria-selected', String(!sourceMode && view === 'items'));
  $('#tab-reqs').setAttribute('aria-selected', String(!sourceMode && view === 'reqs'));
  $('#mode').setAttribute('aria-selected', String(sourceMode));
  // The list pane belongs to the form views; the Markdown view takes the whole width.
  document.body.classList.toggle('raw', sourceMode);
  $('#items-tools').hidden = $('#items-foot').hidden = view !== 'items';
  $('#reqs-tools').hidden = view !== 'reqs';
  $('.list-pane').setAttribute('aria-label', view === 'reqs' ? 'Requirements' : 'Clarification items');
}

// Tab target; leaving source mode validates the Markdown first and keeps you there if it is invalid.
async function goTo(name) {
  if (!doc) return;
  if (sourceMode) {
    try {
      await reparse(content());
    } catch (e) {
      message('Fix the Markdown before leaving source mode:\n' + e.message, true);
      return;
    }
    message('Source validated.');
  }
  showView(name);
}

function updateRailCounts() {
  if (!doc) return;
  $('#count-items').textContent = String(doc.items.length);
  const groups = groupByRequirement();
  const ready = [...groups].filter(([id, items]) => !readiness(items, definitions(id)).length).length;
  $('#count-reqs').textContent = groups.size ? String(groups.size) : '';
  $('#tab-reqs').title = groups.size ? `Requirements: ${ready} of ${groups.size} ready (Alt+2)` : 'Requirements (Alt+2)';
}

function groupByRequirement() {
  const groups = new Map(catalog.requirements.map(r => [r.id, []]));
  for (const item of traceItems()) {
    for (const id of requirementsOf(item.version, item.values[REQUIREMENT_FIELD[item.version]] || '')) {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    }
  }
  return groups;
}

function showView(name, focus) {
  view = name;
  markRail();
  $('#form-view').hidden = name !== 'items';
  $('#trace').hidden = name !== 'reqs';
  if (focus) { reqFilter = 'all'; $('#req-search').value = ''; selectedReq = focus; }
  if (name === 'reqs') drawTrace();
  else { drawOutline(); applyFilter(); }
  if (focus) window.scrollTo(0, 0);
}

// The list pane in Clarifications: file-level sections, then one entry per item with its progress.
function drawOutline() {
  if (view === 'reqs') return drawTrace();
  const entry = (id, top, text, meta) => {
    const button = el('button', { type: 'button', className: 'entry' }, el('span', { className: 'entry-top' }, ...top),
      text ? el('span', { className: 'entry-text', textContent: text }) : null, meta?.length ? el('span', { className: 'entry-meta' }, ...meta) : null);
    button.setAttribute('aria-current', String(id === selected));
    button.onclick = () => selectItem(id);
    const li = el('li', {}, button);
    li.dataset.item = id;
    return li;
  };
  const entries = doc.fields.filter(f => !f.inquiry && f.label).map(f => entry('section-' + f.label, [el('span', { className: 'entry-id', textContent: f.label })], 'About the whole file', null));
  for (const item of doc.items) {
    const facts = itemFacts(item.id);
    const dot = el('span', { className: 'dot' });
    const pill = el('span', { className: 'pill', textContent: facts.status });
    dot.dataset.status = pill.dataset.status = facts.status;
    const meta = [
      ...facts.requirements.map(id => el('span', { className: 'entry-req', textContent: id })),
      facts.questions?.total ? el('span', { textContent: `${facts.questions.done}/${facts.questions.total} questions` }) : null,
      facts.criteria?.total ? el('span', { textContent: `${facts.criteria.accepted}/${facts.criteria.total} AC accepted` }) : null,
      facts.responses ? el('span', { textContent: `${facts.responses} response${facts.responses === 1 ? '' : 's'}` }) : null,
      facts.owner === '' && UNRESOLVED.has(facts.status) ? el('span', { className: 'warn', textContent: 'No owner' }) : null,
    ].filter(Boolean);
    const short = item.id.startsWith(doc.id + '-') ? item.id.slice(doc.id.length + 1) : item.id;
    const li = entry(item.id, [dot, el('span', { className: 'entry-id', textContent: short, title: item.id }), pill], facts.summary, meta);
    li.querySelector('button').setAttribute('aria-label', `${item.id}, ${facts.status}: ${facts.summary}`);
    entries.push(li);
  }
  $('#outline').replaceChildren(...entries);
}

function applyFilter() {
  if (!doc) return;
  if (view === 'reqs') return drawTrace();
  const query = $('#search').value.trim().toLowerCase();
  const counts = { all: doc.items.length };
  for (const s of STATUSES[doc.version]) counts[s] = 0;
  for (const item of doc.items) {
    const status = values[fieldIndex(item.id, 'Status')];
    if (status in counts) counts[status]++;
    const text = doc.fields.map((f, i) => (f.inquiry === item.id ? values[i] : '')).join('\n').toLowerCase();
    const hidden = (statusFilter !== 'all' && status !== statusFilter) || (query && !text.includes(query) && !item.id.toLowerCase().includes(query));
    const entry = document.querySelector(`#outline li[data-item="${item.id}"]`);
    if (entry) entry.hidden = hidden;
  }
  drawSegs($('#filter'), [['all', 'All', counts.all], ...STATUSES[doc.version].map(s => [s, s[0].toUpperCase() + s.slice(1), counts[s]])],
    statusFilter, value => { statusFilter = value; applyFilter(); });
}

/* ---------- modes and actions ---------- */

function showForm() {
  sourceMode = false;
  $('#raw').hidden = true;
  $('#form-view').hidden = view !== 'items';
  $('#trace').hidden = view !== 'reqs';
  markRail();
}

function showSource(text) {
  $('#source').value = lf(text);
  sourceMode = true;
  $('#form-view').hidden = true;
  $('#trace').hidden = true;
  $('#raw').hidden = false;
  markRail();
}

// Re-parse unsaved text on the server (nothing is written) and show it as a form.
async function reparse(text) {
  const parsed = await api('POST', '/api/parse', { content: text });
  if (parsed.id !== doc.id) throw Error('The artifact ID cannot change.');
  doc = { ...doc, ...parsed, content: text };
  showForm();
  render();
  setDirty(true);
}

function setupFilter() {
  if (!STATUSES[doc.version].includes(statusFilter)) statusFilter = 'all';
}

// The `title:` of the front matter, shown as the editor's heading.
function documentTitle(text) {
  const meta = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return (meta?.[1].match(/^title:[ \t]*(.+?)[ \t]*\r?$/m)?.[1] || '').replace(/^["']|["']$/g, '');
}

async function load(note = 'Loaded. Changes are written only when you save (Ctrl+S).', draft, draftHash) {
  try {
    doc = await api('GET', '/api/document');
    imageCache.clear();  // pick up replaced image files
    $('#doc-title').textContent = documentTitle(doc.content) || doc.id;
    $('#filename').textContent = `${doc.id} · ${doc.filename} · schema v${doc.version}`;
    showForm();
    setupFilter();
    render();
    setDirty(false);
    message(note);
    loadIndex();
    // Unsaved edits VS Code kept from an earlier window (hot exit), on top of the file as it is now.
    // The edits belong to the version of the file they were made on: if it changed since, Save
    // is refused rather than replacing what someone else wrote meanwhile.
    if (draft && draft !== doc.content) {
      const changed = draftHash && draftHash !== doc.hash;
      try {
        await reparse(draft);
        message(changed ? 'Restored unsaved edits, but the file changed on disk since. Save will be refused: download your draft, then Reload.'
          : 'Restored unsaved edits. Save to keep them.', changed);
      } catch {
        showSource(draft);
        setDirty(true);
        message('Restored unsaved edits as Markdown: they do not validate yet.', true);
      }
      if (draftHash) doc.hash = draftHash;
    }
  } catch (e) {
    message(e.message, true);
  }
}

let syncPoll = null;
async function loadIndex() {
  try {
    [index, catalog] = await Promise.all([api('GET', '/api/index'), api('GET', '/api/requirements')]);
    useCatalog(catalog);
  } catch (e) {
    message('Reference index unavailable: ' + e.message, true);
  }
}

// Show a catalog and, while a Git sync runs, check back every second.
function useCatalog(next) {
  catalog = next;
  catalog.requirements ??= [];
  redrawViews();
  clearTimeout(syncPoll);
  if (catalog.sync?.state === 'syncing') {
    syncPoll = setTimeout(async () => {
      try { useCatalog(await api('GET', '/api/requirements')); } catch (e) { message('Requirements unavailable: ' + e.message, true); }
    }, 1000);
  }
}

/* ---------- requirements source ---------- */

function ago(iso) {
  const seconds = (Date.now() - new Date(iso)) / 1000;
  if (!isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return formatDate(iso);
}

// "Source: requirements/ · Local folder · Read-only requirements", with its actions.
function sourceBar() {
  const source = catalog.source || { kind: 'none' }, sync = catalog.sync || {};
  const locked = source.from === 'command line';
  const where = source.kind === 'git' ? source.repo : source.kind === 'folder' ? source.folder.replace(/\/?$/, '/') : 'not set';
  const facts = source.kind === 'git' ? ['Git repository', `branch ${source.ref}`, `folder ${source.path}`] : source.kind === 'folder' ? ['Local folder'] : [];
  if (sync.state === 'syncing') facts.push('Syncing…');
  else if (sync.state === 'error') facts.push('Sync failed');
  if (source.kind === 'git' && sync.commit) facts.push(`commit ${sync.commit.slice(0, 8)}${sync.synced_at ? `, synced ${ago(sync.synced_at)}` : ''}`);
  if (source.kind !== 'none') facts.push('Read-only requirements');
  const text = el('div', { className: 'source-text' }, el('div', {}, el('strong', { textContent: 'Source: ' }), el('span', { className: 'source-where', textContent: where })),
    facts.length ? el('div', { className: 'note', textContent: '· ' + facts.join(' · ') }) : null,
    source.kind === 'none' ? el('div', { className: 'note', textContent: 'Choose where the requirement files are: a Git repository (the editor keeps its own copy and signs in with your Git login) or a folder on this computer.' }) : null);
  if (sync.error) {
    text.append(el('div', { className: 'warn', textContent: sync.error }));
    if (source.kind === 'git') text.append(el('div', { className: 'note' }, 'Check your Git login in a terminal: ', el('code', { textContent: `git ls-remote ${source.repo}` }),
      sync.commit ? '. Showing the earlier copy until a sync succeeds.' : ''));
  }
  const syncNow = el('button', { type: 'button', textContent: 'Sync now', disabled: sync.state === 'syncing' });
  syncNow.onclick = async () => {
    try { useCatalog(await api('POST', '/api/requirements/sync', {})); } catch (e) { message(e.message, true); }
  };
  const change = el('button', { type: 'button', textContent: source.kind === 'none' ? 'Set source…' : 'Change source…', disabled: locked, className: source.kind === 'none' ? 'primary' : '',
    title: `Saved in ${source.from || '.dou-editor.json'} at the root of this repository; commit it to share with the team.` });
  change.onclick = () => sourceDialog(source);
  return [text, el('div', { className: 'source-actions' }, ...(source.kind === 'git' ? [syncNow] : []), change)];
}

function sourceDialog(current) {
  const kind = name => el('label', { className: 'kind' }, el('input', { type: 'radio', name: 'kind', value: name, checked: (current.kind === 'none' ? 'git' : current.kind) === name }), ' ',
    name === 'git' ? 'Git repository' : 'Folder on this computer');
  const repo = el('input', { type: 'text', value: current.repo || '', placeholder: 'https://github.com/org/requirements.git or git@github.com:org/requirements.git' });
  const ref = el('input', { type: 'text', value: current.ref || 'main', placeholder: 'main' });
  const path = el('input', { type: 'text', value: current.path || 'docs/source', placeholder: 'docs/source' });
  const folder = el('input', { type: 'text', value: current.folder || '', placeholder: '../requirements/docs/source' });
  const field = (label, input, hint) => el('label', { className: 'field' }, el('span', { className: 'label', textContent: label }), input, hint ? el('span', { className: 'hint', textContent: hint }) : null);
  const gitFields = el('div', {}, field('Repository URL', repo, 'Git signs in with your saved login (credential manager or SSH key). Never put a token in the URL.'),
    field('Branch or tag', ref, 'Ready is judged on this ref, usually main.'), field('Folder in the repository', path, 'Where the .rst files are, e.g. docs/source.'));
  const folderFields = el('div', {}, field('Folder', folder, 'Absolute, or relative to the root of this repository.'));
  const save = el('button', { type: 'submit', className: 'primary', textContent: 'Save and sync' });
  const cancel = el('button', { type: 'button', textContent: 'Cancel' });
  const remove = el('button', { type: 'button', textContent: 'Remove source' });
  const form = el('form', {}, el('h2', { textContent: 'Requirements source' }), el('div', { className: 'kinds' }, kind('git'), kind('folder')), gitFields, folderFields,
    el('div', { className: 'actions' }, current.kind === 'none' ? null : remove, cancel, save));
  const sync = () => { const git = form.querySelector('input[name=kind]:checked').value === 'git'; gitFields.hidden = !git; folderFields.hidden = git; };
  form.addEventListener('change', sync);
  const dialog = el('dialog', {}, form);
  const submit = async body => {
    try {
      useCatalog(await api('POST', '/api/requirements/source', body));
      dialog.close();
      message(body.kind === 'none' ? 'Requirements source removed.' : `Requirements source saved in ${catalog.source.from}.`);
    } catch (e) { message(e.message, true); }
  };
  cancel.onclick = () => dialog.close();
  remove.onclick = () => submit({ kind: 'none' });
  form.onsubmit = event => {
    event.preventDefault();
    const git = form.querySelector('input[name=kind]:checked').value === 'git';
    submit(git ? { kind: 'git', repo: repo.value.trim(), ref: ref.value.trim(), path: path.value.trim() } : { kind: 'folder', folder: folder.value.trim() });
  };
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  sync();
  dialog.showModal();
}

async function save() {
  if (!doc || $('#save').disabled) return;
  $('#save').disabled = true;
  try {
    // VS Code saves the editor; the extension asks this page for its text (below) and writes it.
    await api('POST', '/api/save', {});
  } catch (e) {
    message(e.message, true);
  } finally {
    $('#save').disabled = false;
  }
}

window.addEventListener('message', async event => {
  const msg = event.data || {};
  if (msg.type === 'response') {
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    if (msg.ok) request.resolve(msg.data); else request.reject(Error(msg.error || 'Request failed.'));
  } else if (msg.type === 'init') {
    memory = msg.memory || {};
    await load(undefined, msg.draft, msg.draftHash);
  } else if (msg.type === 'getContent') {
    // Saving or a backup: the text to write, and the version of the file it was edited from.
    const text = doc ? content() : null;
    if (msg.purpose === 'save' && doc) saving = { content: text, sourceMode, values: fieldValues() };
    vscode.postMessage({ type: 'content', id: msg.id, content: text, hash: doc?.hash ?? null });
  } else if (msg.type === 'saved') {
    await afterSave();
  } else if (msg.type === 'saveFailed') {
    saving = null;
    message(msg.error, true);
  } else if (msg.type === 'revert') {
    await load('Reloaded from disk.');
  } else if (msg.type === 'changedOnDisk' && !dirty) {
    await load('The file changed on disk; reloaded.');
  } else if (msg.type === 'changedOnDisk') {
    message('The file changed on disk. Save will be refused: download your draft, then Reload.', true);
  }
});

// What was saved, so edits typed while the file was being written are not lost by the reload.
let saving = null;
const fieldKey = f => (f.inquiry || '') + '\n' + f.label;
const fieldValues = () => new Map(doc.fields.map((f, i) => [fieldKey(f), values[i]]));

async function afterSave() {
  const saved = saving;
  saving = null;
  if (!saved || content() === saved.content) { await load('Saved to Markdown.'); return; }
  if (sourceMode) {
    // The Markdown being edited stays as it is, now on top of the saved file.
    const text = $('#source').value;
    await load();
    showSource(text);
    setDirty(true);
    message('Saved. Edits made while saving are kept and not saved yet.');
    return;
  }
  const later = [];
  doc.fields.forEach((f, i) => { if (saved.values.has(fieldKey(f)) && values[i] !== saved.values.get(fieldKey(f))) later.push([fieldKey(f), values[i]]); });
  await load();
  for (const [key, value] of later) {
    const i = doc.fields.findIndex(f => fieldKey(f) === key);
    if (i >= 0) setValue(i, value);
  }
  redrawViews();
  message(later.length ? `Saved. ${later.length} field${later.length === 1 ? '' : 's'} edited while saving ${later.length === 1 ? 'is' : 'are'} kept and not saved yet.` : 'Saved to Markdown.');
}

async function createItemFor(id, definition) {
  showView('items');
  await addItem({ 'Requirement': id, 'Scope': definition?.title ? `Requirement ${id}: ${definition.title}\nIn scope: Pending\nOut of scope: Pending` : 'Pending' });
}

async function addItem(prefill = {}) {
  if (!doc) return;
  const used = doc.items.map(item => Number(item.id.slice(item.id.lastIndexOf('-Q') + 2)));
  const id = `${doc.id}-Q${String(Math.max(0, ...used) + 1).padStart(2, '0')}`;
  const now = isoNow();
  const json = '```json\n[]\n```';
  const fields = doc.version === 3
    ? { 'Created at': now, 'Updated at': now, 'Status': 'open', 'Scope': 'Pending', 'Desired outcome': 'Pending', 'Requirement': 'None',
        'Questions': 'Known: Pending\n- [ ] Describe the open question.', 'Approach': 'Pending', 'Proposed acceptance criteria': '- Pending',
        'Visual aids': 'None yet', 'References': json, 'History': json, 'Next action': 'Pending', ...prefill }
    : doc.version === 2
    ? { 'Created at': now, 'Updated at': now, 'Status': 'open', 'Related requirements': 'Pending', 'Current understanding': 'Pending',
        'Questions': 'Describe the question.', 'Analysis / Proposal': 'Pending', 'References': json, 'History': json,
        'Current conclusion': 'Pending', 'Next action': 'Pending' }
    : { 'Question': 'Describe the question.', 'Status': 'open', 'Resolution': 'Pending', 'Confirmed by': 'Pending', 'Requirement impact': 'Pending' };
  const block = `### ${id}\n\n` + Object.entries(fields).map(([k, v]) => `**${k}**\n\n${v}\n`).join('\n');
  const text = content().trimEnd() + newline() + newline() + block.replace(/\n/g, newline());
  try {
    await reparse(text);
    statusFilter = 'all';
    $('#search').value = '';
    selectItem(id);
    const section = document.getElementById(id);
    section.scrollIntoView({ behavior: 'smooth' });
    section.querySelector('textarea')?.focus({ preventScroll: true });
    message(`Added ${id}. Updated at is set when you save.`);
  } catch (e) {
    message(e.message, true);
  }
}

$('#save').onclick = save;
// The extension asks before discarding unsaved edits (webviews cannot show confirm()).
$('#reload').onclick = () => { if (!dirty) load(); else vscode.postMessage({ type: 'reload' }); };
$('#download').onclick = () => {
  if (!doc) return;
  vscode.postMessage({ type: 'download', content: content(), filename: doc.filename.replace(/\.md$/, '.draft.md') });
};
$('#mode').onclick = () => { if (doc && !sourceMode) showSource(content()); };
$('#add').onclick = () => addItem();
$('#tab-items').onclick = () => goTo('items');
$('#tab-reqs').onclick = () => goTo('reqs');
$('#source').addEventListener('input', () => setDirty(true));
$('#search').addEventListener('input', applyFilter);
$('#req-search').addEventListener('input', drawTrace);
// Ctrl+S is VS Code's own Save, which reaches the extension and comes back as getContent.
document.addEventListener('keydown', e => {
  // Alt+1/2/3 switch views like the tabs.
  const rail = { '1': '#tab-items', '2': '#tab-reqs', '3': '#mode' }[e.key];
  if (e.altKey && !e.ctrlKey && !e.metaKey && rail) { e.preventDefault(); $(rail).click(); }
});
new ResizeObserver(() => document.documentElement.style.setProperty('--header-h', $('header').offsetHeight + 'px')).observe($('header'));
vscode.postMessage({ type: 'ready' });
