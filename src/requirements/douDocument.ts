/**
 * Clarification ("dou") documents: Markdown files that record questions about requirements, one
 * item per `### <ID>-Q<n>` heading with fixed field labels. Parsing returns the span of every
 * editable field, so the editor rewrites only the fields that changed and leaves every other byte
 * as it was. Saving checks the rules a team relies on (history is append-only, Created at never
 * changes, items are never removed) and stamps Updated at on the items that changed.
 *
 * Ported from the Python dou-editor (server.py) with the same rules and messages. Differences that
 * matter for the port: offsets are UTF-16 indexes (what JavaScript strings use, and what the
 * webview splices), and every pattern spells out Python's line and whitespace rules, because
 * JavaScript's `m` flag also breaks lines at `\r`, U+2028 and U+2029 where Python's `re.M` does not.
 */

/** Python's `str.isspace()` characters, for strip() and `\s` with Python's meaning. */
export const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** Python's `\w` in a str pattern: Unicode letters, digits and underscore (use with the `u` flag). */
export const PY_WORD = '\\p{L}\\p{N}_';
/** Start of a line as Python's `re.M` sees it: the start, or right after "\n". */
const BOL = '(?<![^\\n])';
const stripPattern = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');

/** Python's `str.strip()`: unlike `trim()`, it keeps a BOM and strips \x1c-\x1f and \x85. */
export function pyStrip(text: string): string {
  return text.replace(stripPattern, '');
}

// Python also breaks lines at the file, group and record separators (\x1c-\x1e).
const LINE_BREAKS = new RegExp(`\r\n|[\n\r\v\f${String.fromCharCode(0x1c, 0x1d, 0x1e)}\x85\u2028\u2029]`);

/** Python's `str.splitlines()`: no trailing empty line; "\r\n" is one break. */
export function pySplitLines(text: string): string[] {
  const lines = text.split(LINE_BREAKS);
  if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
  return lines;
}

/** Length in code points, as Python's len() counts a str. */
export const codePoints = (text: string): number => Array.from(text).length;

export class DouError extends Error {}

export const V1_FIELDS = ['Question', 'Status', 'Resolution', 'Confirmed by', 'Requirement impact'];
export const V2_FIELDS = ['Created at', 'Updated at', 'Status', 'Related requirements', 'Current understanding', 'Questions',
  'Analysis / Proposal', 'References', 'History', 'Current conclusion', 'Next action'];
// v3: no file-level Context/Scope and no Current conclusion field. Each item clarifies exactly one
// Requirement, so its acceptance criteria belong to it.
export const V3_FIELDS = ['Created at', 'Updated at', 'Status', 'Scope', 'Desired outcome', 'Requirement',
  'Questions', 'Approach', 'Proposed acceptance criteria', 'Visual aids', 'References', 'History', 'Next action'];
// Keyed by schema version.
// eslint-disable-next-line @typescript-eslint/naming-convention
const FIELDS: Record<number, string[]> = { 1: V1_FIELDS, 2: V2_FIELDS, 3: V3_FIELDS };
// eslint-disable-next-line @typescript-eslint/naming-convention
const SECTIONS: Record<number, string[]> = { 1: ['Context', 'Scope', 'Inquiries'], 2: ['Context', 'Scope', 'Discussions'], 3: ['Discussions'] };
const EVENT_TYPES = ['question', 'response', 'proposal', 'conclusion', 'reopened', 'feedback', 'decision'];
const RELATIONS = ['related_to', 'depends_on', 'follows_up', 'supersedes'];
// One acceptance criterion per line: "- AC1: Given ..., when ..., then ...".
const CRITERION = new RegExp(`^[${PY_SPACE}]*[-*][${PY_SPACE}]*(AC[0-9]+):[${PY_SPACE}]*([^${PY_SPACE}][\\s\\S]*?)[${PY_SPACE}]*$`);
const OPEN_QUESTION = new RegExp(`${BOL}[${PY_SPACE}]*[-*][${PY_SPACE}]*\\[ \\]`, 'g');
// An ID written on purpose (a v3 Requirement field, a sphinx-needs :id:) may be any letters,
// digits, "-" and "_" with at least one digit, e.g. R_F4722.
export const EXPLICIT_ID = '[A-Za-z][A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*';
const EXPLICIT_ID_ONLY = new RegExp(`^${EXPLICIT_ID}$`);

export interface DouField { label: string; inquiry?: string; start: number; end: number; value: string }
export interface DouItem { id: string; values: Record<string, string> }
export interface ParsedDou { id: string; version: number; fields: DouField[]; items: DouItem[] }
type Json = Record<string, unknown>;

/** A timestamp as [epoch milliseconds, extra microseconds], for comparing instants. */
type Instant = [number, number];

// The forms Python 3.11+ fromisoformat reads: extended or compact time, hours alone allowed.
const ISO = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?(?:([Zz])|([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/;

/** An ISO 8601 timestamp with a timezone ("Z", which browsers and agents emit, included). */
export function timestamp(value: unknown, where = 'Timestamp'): Instant {
  if (typeof value !== 'string') { throw new DouError(where + ': timestamp must be a string.'); }
  const text = pyStrip(value);
  const match = ISO.exec(text);
  const invalid = () => new DouError(where + ': invalid ISO 8601 timestamp: ' + text);
  if (!match) { throw invalid(); }
  const [, y, mo, d, h, mi = '0', s = '0', fraction = '', zulu, sign, oh, om, os = '0'] = match;
  const parts = [y, mo, d, h, mi, s].map(Number);
  // Date.UTC would read years 0-99 as 1900-1999.
  const back = new Date(0);
  back.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  back.setUTCHours(parts[3], parts[4], parts[5], 0);
  const ms = back.getTime();
  if (parts[0] < 1 || back.getUTCMonth() !== parts[1] - 1 || back.getUTCDate() !== parts[2] || parts[3] > 23 || parts[4] > 59 || parts[5] > 59
    || Number(oh || 0) > 23 || Number(om || 0) > 59 || Number(os) > 59) {
    throw invalid();
  }
  if (!zulu && !sign) { throw new DouError(where + ': timestamp must include a timezone.'); }
  const offset = sign ? (sign === '-' ? -1 : 1) * ((Number(oh) * 60 + Number(om)) * 60 + Number(os)) * 1000 : 0;
  const micro = Number(fraction.padEnd(6, '0'));
  return [ms - offset + Math.floor(micro / 1000), micro % 1000];
}

const later = (a: Instant, b: Instant) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/** Local time with its offset, rounded up to the whole second, e.g. 2026-10-27T14:05:09+07:00. */
export function nowIso(now = new Date()): string {
  // Rounding up (not truncating) keeps Updated at from preceding a Created at written with
  // sub-second precision in the same second.
  const date = now.getMilliseconds() ? new Date(now.getTime() - now.getMilliseconds() + 1000) : now;
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

export function jsonField(value: string): unknown {
  let text = value;
  if (text.startsWith('```json')) { text = text.slice(7); }
  if (text.endsWith('```')) { text = text.slice(0, -3); }
  return JSON.parse(pyStrip(text));
}

/** A fenced JSON array of objects; errors say where, with the line inside the JSON as Python does. */
function jsonObjects(value: string, where: string): Json[] {
  let data: unknown;
  try {
    data = jsonField(value);
  } catch (error) {
    throw new DouError(`${where}: invalid JSON (${jsonProblem(value, error)}).`);
  }
  if (!Array.isArray(data)) { throw new DouError(where + ': must be a JSON array.'); }
  data.forEach((entry, i) => {
    if (!isObject(entry)) { throw new DouError(`${where}[${i}]: must be a JSON object.`); }
  });
  return data as Json[];
}

function jsonProblem(value: string, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // V8 quotes the input ("..." is not valid JSON) and gives a position, sometimes a line too.
  const message = text.replace(/,? ?"[\s\S]*"(\.\.\.)? is not valid JSON$/, '').replace(/ (?:in JSON )?at position \d+(?: \(line \d+ column \d+\))?/, '');
  const position = / at position (\d+)/.exec(text);
  if (!position) { return message; }
  let json = value.startsWith('```json') ? value.slice(7) : value;
  if (json.endsWith('```')) { json = json.slice(0, -3); }
  return `${message}, line ${pyStrip(json).slice(0, Number(position[1])).split('\n').length}`;
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(entry: Json, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== 'string' || !pyStrip(value)) { throw new DouError(`${where}.${key}: required non-empty text.`); }
  return value;
}

/** Criteria as {id: text}; other lines are notes. IDs must be unique. */
export function acceptanceCriteria(value: string, where: string): Map<string, string> {
  const criteria = new Map<string, string>();
  for (const line of pySplitLines(value)) {
    const match = CRITERION.exec(line);
    if (match) {
      if (criteria.has(match[1])) { throw new DouError(`${where}: duplicate acceptance criterion ${match[1]}.`); }
      criteria.set(match[1], match[2]);
    }
  }
  return criteria;
}

/**
 * A PO decision on acceptance criteria. Each entry keeps the text it decided on, so a later edit
 * of that criterion makes the decision stale instead of silently approving the new wording. Role
 * is checked, not identity: there is no login.
 */
function decisionEvent(event: Json, where: string): void {
  if (event.role !== 'PO') { throw new DouError(where + ': decisions on acceptance criteria are recorded by role PO.'); }
  const criteria = event.criteria;
  if (!Array.isArray(criteria) || !criteria.length) { throw new DouError(where + '.criteria: list at least one criterion.'); }
  criteria.forEach((entry, i) => {
    const at = `${where}.criteria[${i}]`;
    if (!isObject(entry) || !/^AC[0-9]+$/.test(String(entry.id ?? ''))) { throw new DouError(at + ': needs an id such as AC1.'); }
    if (entry.decision !== 'accepted' && entry.decision !== 'rejected') { throw new DouError(at + ': decision must be accepted or rejected.'); }
    text(entry, 'text', at);
    // Optional: the Visual aids text the PO saw, so later changes to it are noticed.
    if ('aids' in entry && typeof entry.aids !== 'string') { throw new DouError(at + '.aids: must be text.'); }
  });
}

/** Blank out fenced code blocks, keeping every offset and newline in place. */
export function maskFences(content: string): string {
  let masked = '';
  let fence: string | null = null;
  const marker = new RegExp(`^[${PY_SPACE}]*(\`{3,}|~{3,})`);
  for (const line of content.match(/[^\n]*\n|[^\n]+/g) || []) {
    const found = marker.exec(line);
    if (fence || found) {
      if (fence && found && found[1][0] === fence[0] && found[1].length >= fence.length) {
        fence = null;
      } else if (!fence && found) {
        fence = found[1];
      }
      masked += line.replace(/[^\n]/g, ' ');
    } else {
      masked += line;
    }
  }
  return masked;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const lineValue = (name: string, value: string) => new RegExp(`${BOL}${name}: (${value})[${PY_SPACE.replace('\\n', '')}]*(?=\\n|$)`, 'g');

function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    found.push(match);
    if (match[0] === '') { pattern.lastIndex++; }
  }
  return found;
}

/** Editable spans of a clarification document; unknown text stays untouched during field edits. */
export function parse(content: string): ParsedDou {
  const meta = FRONT_MATTER.exec(content);
  if (!meta) { throw new DouError('Missing YAML front matter.'); }
  // Python's `\s*$` under re.M may also eat the line break; only spaces and tabs matter here.
  const ids = allMatches(new RegExp(`${BOL}id: ([A-Z][A-Z0-9-]*)[${PY_SPACE}]*?(?=\\n|$)`, 'g'), meta[1]).map(m => m[1]);
  const versionMatch = allMatches(lineValue('schema_version', '[123]'), meta[1])[0];
  if (ids.length !== 1 || !versionMatch) { throw new DouError('Require one plain id and schema_version: 1, 2 or 3.'); }
  const id = ids[0];
  const version = Number(versionMatch[1]);
  const expectedFields = FIELDS[version];
  // Headings and field labels are reserved outside fenced code blocks.
  const scanned = maskFences(content);
  const headings = allMatches(new RegExp(`${BOL}## (Context|Scope|Inquiries|Discussions)\\r?\\n`, 'g'), scanned);
  const end = (m: RegExpExecArray) => m.index + m[0].length;
  if (headings.map(h => h[1]).join('\n') !== SECTIONS[version].join('\n')) {
    throw new DouError(`Schema v${version} requires these level-2 headings, in order and nothing else: ${SECTIONS[version].map(s => '## ' + s).join(', ')}.`);
  }
  const fields: DouField[] = [];
  for (let i = 0; i < headings.length - 1; i++) {
    const start = end(headings[i]), stop = headings[i + 1].index;
    fields.push({ label: headings[i][1], start, end: stop, value: pyStrip(content.slice(start, stop)) });
  }
  const inquiries = allMatches(new RegExp(`${BOL}### ([A-Z][A-Z0-9-]*-Q[0-9]+)\\r?\\n`, 'g'), scanned);
  const seen = new Set<string>();
  const items: DouItem[] = [];
  const localRefs: Array<[string, string]> = [];
  const lastHeadingEnd = end(headings[headings.length - 1]);
  inquiries.forEach((inquiry, i) => {
    const qid = inquiry[1];
    if (seen.has(qid) || !qid.startsWith(id + '-Q') || inquiry.index < lastHeadingEnd) {
      throw new DouError('Duplicate, misplaced, or mismatched inquiry ID: ' + qid);
    }
    seen.add(qid);
    const itemEnd = i + 1 < inquiries.length ? inquiries[i + 1].index : content.length;
    const bodyStart = end(inquiry);
    const labels = allMatches(/(?<![^\n])\*\*([^\r\n]+)\*\*\r?\n/g, scanned.slice(bodyStart, itemEnd));
    if (labels.map(x => x[1]).join('\n') !== expectedFields.join('\n')) {
      throw new DouError(qid + ': require fields in order: ' + expectedFields.join(', '));
    }
    const values: Record<string, string> = {};
    labels.forEach((label, j) => {
      const start = bodyStart + end(label);
      const stop = j + 1 < labels.length ? bodyStart + labels[j + 1].index : itemEnd;
      const value = pyStrip(content.slice(start, stop));
      values[label[1]] = value;
      fields.push({ label: label[1], inquiry: qid, start, end: stop, value });
    });
    if (version === 1) {
      if (!values.Question || !['open', 'proposed', 'agreed'].includes(values.Status)) { throw new DouError(qid + ': invalid question or status.'); }
      if (values.Status === 'agreed' && ['Resolution', 'Confirmed by'].some(k => ['', 'pending'].includes(values[k].toLowerCase()))) {
        throw new DouError(qid + ': agreed requires a resolution and confirmation.');
      }
    } else {
      checkDiscussion(qid, version, values, localRefs);
    }
    items.push({ id: qid, values });
  });
  for (const [qid, target] of localRefs) {
    if (target.startsWith(id + '-Q') && !seen.has(target)) { throw new DouError(qid + ': unknown local reference ' + target + '.'); }
  }
  return { id, version, fields, items };
}

/** The rules of a v2 or v3 item: status, dates, history, references, and v3's own fields. */
function checkDiscussion(qid: string, version: number, values: Record<string, string>, localRefs: Array<[string, string]>): void {
  if (!['open', 'investigating', 'resolved'].includes(values.Status)) { throw new DouError(qid + ': invalid status.'); }
  if (later(timestamp(values['Created at'], qid + ' Created at'), timestamp(values['Updated at'], qid + ' Updated at'))) {
    throw new DouError(qid + ': updated time precedes creation.');
  }
  const refs = jsonObjects(values.References, qid + ' References');
  const history = jsonObjects(values.History, qid + ' History');
  const eventIds = new Set<string>();
  history.forEach((event, i) => {
    const where = `${qid} History[${i}]`;
    const eventId = text(event, 'id', where);
    if (eventIds.has(eventId)) { throw new DouError(`${where}: duplicate event id ${eventId}.`); }
    eventIds.add(eventId);
    for (const key of ['author', 'role', 'content']) { text(event, key, where); }
    timestamp(event.at, where + '.at');
    // Optional: where the response came from, e.g. "Sprint 12 review".
    if ('source' in event && typeof event.source !== 'string') { throw new DouError(where + '.source: must be text.'); }
    if (version === 3) {
      // v3 responses carry no status of their own: the item Status is the only state. A response
      // listing criteria is the PO's decision on them.
      if ('type' in event) { throw new DouError(where + ': v3 responses have no type; the item Status says where it stands.'); }
      if ('criteria' in event) { decisionEvent(event, where); }
    } else {
      if (!EVENT_TYPES.includes(event.type as string)) { throw new DouError(where + ': invalid event type.'); }
      if (event.type === 'decision') { decisionEvent(event, where); }
    }
  });
  const hasConclusion = version === 3 || history.some(e => e.type === 'conclusion');
  refs.forEach((ref, i) => {
    const where = `${qid} References[${i}]`;
    const target = text(ref, 'item_id', where);
    text(ref, 'reason', where);
    if (!RELATIONS.includes(ref.relation as string)) { throw new DouError(where + ': invalid relation.'); }
    if (ref.relation === 'supersedes' && (values.Status !== 'resolved' || !hasConclusion)) {
      throw new DouError(where + ': supersedes requires a resolved item' + (version === 3 ? '.' : ' with an attributed conclusion.'));
    }
    if (!/^[A-Z][A-Z0-9-]*-Q[0-9]+$/.test(target) || target === qid) { throw new DouError(where + ': invalid or self reference ' + target + '.'); }
  });
  if (values.Status === 'resolved' && version === 2 && (['', 'pending'].includes(values['Current conclusion'].toLowerCase()) || !hasConclusion)) {
    throw new DouError(qid + ': resolved requires a current conclusion and attributed conclusion event.');
  }
  if (version === 3) {
    acceptanceCriteria(values['Proposed acceptance criteria'], qid);
    const requirement = pyStrip(values.Requirement);
    if (!(EXPLICIT_ID_ONLY.test(requirement) || ['pending', 'none'].includes(requirement.toLowerCase()))) {
      throw new DouError(qid + ': Requirement must be one ID such as REQ-012 or REQ_012, or Pending.');
    }
    const openQuestions = (values.Questions.match(OPEN_QUESTION) || []).length;
    if (values.Status === 'resolved' && openQuestions) {
      throw new DouError(`${qid}: resolved requires every question ticked ("- [x]"); ${openQuestions} still open.`);
    }
  }
  for (const ref of refs) { localRefs.push([qid, ref.item_id as string]); }
}

/** Python's == on decoded JSON: objects compare without regard to key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => k in b && sameJson(a[k], b[k]));
  }
  return a === b;
}

/**
 * The text to write when `proposed` replaces `old`: both must parse, the ID and schema version
 * stay, items are never removed, Created at never changes, History only grows, and each item
 * that changed gets a new Updated at.
 */
export function prepareSave(old: string, proposed: string, now = nowIso()): string {
  const previous = parse(old), next = parse(proposed);
  if (previous.id !== next.id || previous.version !== next.version) {
    throw new DouError('Artifact ID/schema version must remain unchanged during Save.');
  }
  if (next.version === 1) { return proposed; }
  const before = new Map(previous.items.map(i => [i.id, i.values]));
  const after = new Map(next.items.map(i => [i.id, i.values]));
  for (const key of before.keys()) {
    if (!after.has(key)) { throw new DouError('Keep old items for traceability; explain withdrawal in history.'); }
  }
  const patches: Array<[number, number, string]> = [];
  for (const [itemId, values] of after) {
    const prior = before.get(itemId);
    if (prior) {
      if (values['Created at'] !== prior['Created at']) { throw new DouError(itemId + ': Created at is immutable.'); }
      const past = jsonField(prior.History) as unknown[], current = jsonField(values.History) as unknown[];
      if (!sameJson(current.slice(0, past.length), past)) {
        throw new DouError(itemId + ': History is append-only. Add a correction event instead.');
      }
    } else if (later(timestamp(values['Created at']), timestamp(now))) {
      // Created at is kept as written (it may record an earlier meeting), but a future creation
      // date is a mistake, not a record.
      throw new DouError(itemId + ': Created at cannot be in the future.');
    }
    const changed = !prior || Object.keys(values).some(k => values[k] !== prior[k]);
    if (changed) {
      for (const field of next.fields) {
        if (field.inquiry === itemId && field.label === 'Updated at') { patches.push([field.start, field.end, '\n' + now + '\n\n']); }
      }
    }
  }
  let result = proposed;
  for (const [start, stop, replacement] of patches.sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, start) + replacement + result.slice(stop);
  }
  parse(result);
  return result;
}
