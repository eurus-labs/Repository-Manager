/**
 * The Runs view's page (docs/agent-studio.md, phase 3): the summary, filters, the list of runs and
 * one run's timeline, rendered whole by the host. No `vscode` here, so tests render it directly.
 */
import { RunState } from './engine';
import { formatDuration, matchesFilter, RunRecord, RunsFilter, RunTimeline, summarizeRuns, TimelineNode } from './runsReport';

/** At most this many runs are listed; the summary counts every run it was given. */
export const RUNS_LISTED = 100;

export interface RunsPageModel {
  records: RunRecord[];
  filter: RunsFilter;
  selected?: { record: RunRecord; timeline: RunTimeline };
  nonce: string;
  cspSource: string;
}

const escape = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const percent = (value: number | undefined) => value === undefined ? 'no finished run' : `${Math.round(value * 100)}%`;
const statusLabel = (state: RunState) => state.interrupted ? 'interrupted' : state.status;
const VERDICTS: Record<string, string> = {
  passed: 'checks passed', failed: 'accepted with failing checks', unverified: 'accepted as unverified', docsOnly: 'documentation only', noChanges: 'no changes'
};

function summaryHtml(model: RunsPageModel): string {
  const summary = summarizeRuns(model.records);
  const verification = Object.entries(summary.verification);
  return `<section class="summary" aria-label="Summary">
    <div class="tile"><strong>${summary.total}</strong><span>runs</span></div>
    <div class="tile" title="Done ÷ finished runs (done, failed, stopped). Done means the engine finished, not that the code is right."><strong>${percent(summary.completionRate)}</strong><span>completed (${summary.done} of ${summary.finished} finished)</span></div>
    <div class="tile"><strong>${summary.running + summary.waiting}</strong><span>not finished (${summary.running} running, ${summary.waiting} waiting)</span></div>
    <div class="tile"><strong>${summary.interrupted}</strong><span>interrupted</span></div>
    <div class="tile"><strong>${summary.retries}</strong><span>retries</span></div>
    <div class="verification"><span>Accepted code steps:</span> ${verification.length
    ? verification.map(([verdict, count]) => `<span class="badge verdict-${escape(verdict)}">${count} ${escape(VERDICTS[verdict] ?? verdict)}</span>`).join(' ')
    : '<span class="muted">none yet</span>'}</div>
  </section>`;
}

function filtersHtml(model: RunsPageModel): string {
  const titles = [...new Set(model.records.map(record => record.state.workflow.title))].sort();
  const option = (value: string, label: string, chosen: string | undefined) => `<option value="${escape(value)}"${chosen === value ? ' selected' : ''}>${escape(label)}</option>`;
  return `<div class="filters">
    <label>Workflow <select data-filter="workflow">${option('', 'All', model.filter.workflow ?? '')}${titles.map(title => option(title, title, model.filter.workflow)).join('')}</select></label>
    <label>Status <select data-filter="status">${option('', 'All', model.filter.status ?? '')}${['running', 'waiting', 'done', 'failed', 'stopped', 'interrupted'].map(status => option(status, status, model.filter.status)).join('')}</select></label>
    <button type="button" data-action="refresh">Refresh</button>
  </div>`;
}

function listHtml(model: RunsPageModel): string {
  const shown = model.records.filter(record => matchesFilter(record.state, model.filter));
  if (!shown.length) { return `<p class="muted">${model.records.length ? 'No run matches the filters.' : 'No runs yet. Run a workflow from Run Workflow… or the Chat.'}</p>`; }
  const rows = shown.slice(0, RUNS_LISTED).map(({ state }) => `<tr class="${model.selected?.record.state.id === state.id ? 'selected' : ''}">
      <td><button type="button" class="link" data-action="select" data-run="${escape(state.id)}">${escape(state.workflow.title)}</button></td>
      <td><span class="status status-${escape(statusLabel(state))}">${escape(statusLabel(state))}</span>${state.waiting ? ` <span class="muted">${escape(state.waiting.title)}</span>` : ''}</td>
      <td>${escape(state.startedAt.replace('T', ' ').slice(0, 19))}</td>
    </tr>`).join('');
  return `<table class="runs"><thead><tr><th>Workflow</th><th>Status</th><th>Started (UTC)</th></tr></thead><tbody>${rows}</tbody></table>
    ${shown.length > RUNS_LISTED ? `<p class="muted">The ${RUNS_LISTED} newest of ${shown.length} are listed.</p>` : ''}`;
}

function nodeHtml(node: TimelineNode): string {
  // Not run yet (pending, or waiting at its gate) is not the same as a time the log lacks.
  const ran = node.runs > 0 || node.executionMs !== undefined;
  const facts = [
    ran ? `ran ${node.runs} time${node.runs === 1 ? '' : 's'}${node.runs > 1 ? ` (${node.runs - 1} retr${node.runs === 2 ? 'y' : 'ies'})` : ''}` : node.outcome === 'skipped' ? 'skipped' : node.outcome === 'pending' || node.outcome === 'waiting' ? 'not run yet' : 'runs: no data',
    ...(ran ? [`executing: ${formatDuration(node.executionMs)}`] : []),
    // Shown only for a node that waited (or waits now): one that never asked a person has no wait.
    ...(node.waitingNow ? ['waiting for you now'] : node.waitingMs !== undefined || node.waitingUnknown ? [`waiting for you: ${formatDuration(node.waitingMs)}`] : []),
    ...(node.verdict ? [`verification: ${VERDICTS[node.verdict] ?? node.verdict}`] : [])
  ];
  const recovered = node.recovered
    ? `<p class="warning">VS Code closed while it ran. ${node.recovered.restored.length ? `Put back: ${node.recovered.restored.map(escape).join(', ')}.` : 'Nothing needed undoing.'}${node.recovered.kept.length ? ` Changed since, left as they are: ${node.recovered.kept.map(escape).join(', ')}.` : ''}</p>` : '';
  return `<li class="node outcome-${escape(node.outcome)}">
      <div><strong>${escape(node.title ?? node.node)}</strong>${node.type ? ` <span class="muted">${escape(node.type)}</span>` : ''} <span class="status status-${escape(node.outcome)}">${escape(node.outcome)}</span></div>
      <div class="muted">${facts.map(escape).join(' · ')}</div>
      ${node.error ? `<p class="error">${escape(node.error)}</p>` : ''}${recovered}
      ${node.result ? `<details class="result"><summary>Result${node.truncated ? ' (first part; Open raw log has all of it)' : ''}</summary><pre>${escape(node.result)}</pre></details>` : ''}
    </li>`;
}

function detailHtml(model: RunsPageModel): string {
  if (!model.selected) { return ''; }
  const { record: { state }, timeline } = model.selected;
  return `<section class="detail" aria-label="Run">
    <h2>${escape(state.workflow.title)} <span class="muted">${escape(state.workflow.version)}</span></h2>
    <p><span class="status status-${escape(statusLabel(state))}">${escape(statusLabel(state))}</span> · started ${escape(state.startedAt.replace('T', ' ').slice(0, 19))} UTC · executing ${formatDuration(timeline.executionMs)} · waiting for you ${timeline.nodes.some(node => node.waitingNow) ? 'now (no total yet)' : formatDuration(timeline.waitingMs)}</p>
    ${state.error ? `<p class="error">${escape(state.error)}</p>` : ''}
    ${timeline.hasLog ? '' : '<p class="muted">This run has no log: times and retries are not known.</p>'}
    <div class="actions">
      ${state.status === 'waiting' ? `<button type="button" data-action="resume" data-run="${escape(state.id)}">Resume: ${escape(state.waiting?.title ?? 'answer')}</button>` : ''}
      <button type="button" data-action="rawLog" data-run="${escape(state.id)}">Open raw log</button>
    </div>
    <ol class="timeline">${timeline.nodes.map(nodeHtml).join('')}</ol>
  </section>`;
}

export function renderRunsPage(model: RunsPageModel): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${model.nonce}'; script-src 'nonce-${model.nonce}';">
  <style nonce="${model.nonce}">
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px; }
    .summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
    .tile { display: flex; flex-direction: column; min-width: 90px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 4px; }
    .tile strong { font-size: 1.3em; }
    .verification { flex-basis: 100%; }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
    select, button { font: inherit; color: var(--vscode-button-secondaryForeground, inherit); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border, #8884); border-radius: 3px; padding: 2px 6px; }
    button.link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; text-align: left; }
    table.runs { width: 100%; border-collapse: collapse; }
    table.runs th, table.runs td { text-align: left; padding: 3px 4px; border-bottom: 1px solid var(--vscode-panel-border, #8882); }
    tr.selected { background: var(--vscode-list-activeSelectionBackground, #8883); }
    .muted { opacity: .7; }
    .status, .badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: .9em; border: 1px solid currentColor; }
    .status-done, .status-accepted, .status-approved { color: var(--vscode-testing-iconPassed, #3a3); }
    .status-failed, .status-rejected, .status-interrupted { color: var(--vscode-errorForeground, #c33); }
    .status-waiting, .status-running { color: var(--vscode-editorWarning-foreground, #b80); }
    .error { color: var(--vscode-errorForeground, #c33); white-space: pre-wrap; }
    .warning { color: var(--vscode-editorWarning-foreground, #b80); }
    ol.timeline { padding-left: 18px; }
    ol.timeline li { margin: 6px 0; }
    .actions { display: flex; gap: 8px; margin: 6px 0; }
    .result pre { white-space: pre-wrap; max-height: 240px; overflow: auto; background: var(--vscode-textCodeBlock-background, #8881); padding: 6px; }
  </style>
  <title>Workflow Runs</title>
</head>
<body>
  ${summaryHtml(model)}
  ${filtersHtml(model)}
  ${listHtml(model)}
  ${detailHtml(model)}
  <script nonce="${model.nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-action]');
      if (target) { vscode.postMessage({ type: target.dataset.action, run: target.dataset.run }); }
    });
    document.addEventListener('change', event => {
      const target = event.target.closest('[data-filter]');
      if (target) { vscode.postMessage({ type: 'filter', key: target.dataset.filter, value: target.value }); }
    });
  </script>
</body>
</html>`;
}
