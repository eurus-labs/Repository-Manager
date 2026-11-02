/**
 * The HTML of one task's page: its frozen goal and criteria, the plan with each step's state, the
 * current step's card and buttons, what the step did, and the run log. Built on the host from the
 * stored task (no VS Code here), and sent to the webview whole on every change.
 */

import { MAX_ATTEMPTS } from './agentRunner';
import { AgentTask, PlanStep, RunLogEntry } from './types';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STATUS_LABEL: Record<AgentTask['status'], string> = {
  new: 'No plan yet', planning: 'Drafting the plan…', planReview: 'Plan waiting for your approval',
  stepReady: 'Step waiting for Run', stepRunning: 'Step running…', stepReview: 'Step waiting for your review',
  done: 'Done', stopped: 'Stopped'
};

function button(action: string, label: string, options: { index?: number; path?: string; primary?: boolean; disabled?: string } = {}): string {
  const data = [`data-action="${action}"`];
  if (options.index !== undefined) { data.push(`data-index="${options.index}"`); }
  if (options.path !== undefined) { data.push(`data-path="${escapeHtml(options.path)}"`); }
  const disabled = options.disabled ? ` disabled title="${escapeHtml(options.disabled)}"` : '';
  return `<button type="button" class="${options.primary ? 'primary' : 'secondary'}" ${data.join(' ')}${disabled}>${escapeHtml(label)}</button>`;
}

function list(items: string[], empty: string): string {
  return items.length ? items.map(item => `<code>${escapeHtml(item)}</code>`).join(' ') : `<span class="muted">${escapeHtml(empty)}</span>`;
}

function stepDetails(step: PlanStep): string {
  return `<dl class="step-facts">
    <dt>May change</dt><dd>${list(step.paths, 'nothing (read only)')}</dd>
    <dt>Tools</dt><dd>${list(['read', ...step.tools], '')}</dd>
    <dt>Checks</dt><dd>${list(step.checks, 'none: nothing verifies this step')}</dd>
  </dl>`;
}

function stepResult(task: AgentTask, step: PlanStep): string {
  const result = step.result;
  if (!result) { return ''; }
  const changes = result.changes.length
    ? `<ul class="changes">${result.changes.map(change => `<li><code>${escapeHtml(change.path)}</code> ${change.before === null ? '<span class="badge">new</span>' : ''} ${button('showDiff', 'Diff', { index: task.current, path: change.path })}</li>`).join('')}</ul>`
    : '<p class="muted">No file changed.</p>';
  const checks = result.checks.length
    ? `<ul class="checks">${result.checks.map(check => `<li class="${check.passed ? 'pass' : 'fail'}"><strong>${check.passed ? '✓' : '✗'} ${escapeHtml(check.script)}</strong> <span class="muted">exit ${escapeHtml(check.exitCode)} · ${(check.durationMs / 1000).toFixed(1)} s</span>${check.passed ? '' : `<pre>${escapeHtml(check.output.slice(-4000))}</pre>`}</li>`).join('')}</ul>`
    : '<p class="warning">No check ran: nothing verified this step.</p>';
  const aiText = result.aiText.length
    ? `<div class="warning"><strong>Text in the repository speaks to an AI.</strong> The step read it; check that the change follows the plan, not that text.<ul>${result.aiText.map(item => `<li><code>${escapeHtml(item.path)}:${item.line}</code> ${escapeHtml(item.text)}</li>`).join('')}</ul></div>`
    : '';
  const tools = result.toolCalls.length
    ? `<details><summary>${result.toolCalls.length} tool call${result.toolCalls.length === 1 ? '' : 's'}</summary><ol class="tool-calls">${result.toolCalls.map(call => `<li class="${call.ok ? '' : 'fail'}"><code>${escapeHtml(call.name)}</code> ${escapeHtml(call.note)}</li>`).join('')}</ol></details>`
    : '';
  return `<section class="result">
    <h3>What the step did</h3>
    ${result.summary ? `<p>${escapeHtml(result.summary)}</p>` : ''}
    ${changes}${aiText}<h3>Checks</h3>${checks}${tools}
  </section>`;
}

function stepCard(task: AgentTask, step: PlanStep, index: number): string {
  const current = index === task.current && ['stepReady', 'stepRunning', 'stepReview'].includes(task.status);
  const state = current ? (task.status === 'stepRunning' ? 'running' : 'current') : step.state;
  let actions = '';
  if (task.status === 'planReview' && step.state === 'pending') {
    actions = button('editStep', 'Edit', { index });
  } else if (current && task.status === 'stepReady') {
    const spent = step.attempts >= MAX_ATTEMPTS ? `Ran ${MAX_ATTEMPTS} times` : '';
    actions = button('run', step.attempts ? `Run again (${step.attempts + 1}/${MAX_ATTEMPTS})` : 'Run', { primary: true, disabled: spent }) +
      button('editStep', 'Edit', { index }) + button('skip', 'Skip') + button('stop', 'Stop task');
  } else if (current && task.status === 'stepRunning') {
    actions = button('cancel', 'Cancel');
  } else if (current && task.status === 'stepReview') {
    const failed = step.result?.checks.some(check => !check.passed) ? 'A check failed' : '';
    const spent = step.attempts >= MAX_ATTEMPTS ? `Ran ${MAX_ATTEMPTS} times` : '';
    actions = button('accept', 'Accept', { primary: true, disabled: failed }) + button('retry', 'Retry', { disabled: spent }) + button('stop', 'Stop task');
  }
  return `<li class="step ${state}">
    <div class="step-head"><span class="step-state">${escapeHtml(state)}</span> <strong>${index + 1}. ${escapeHtml(step.title)}</strong></div>
    <p>${escapeHtml(step.intent)}</p>
    ${task.status === 'planReview' || current ? stepDetails(step) : ''}
    ${current && task.status === 'stepReview' ? stepResult(task, step) : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
  </li>`;
}

function logLine(entry: RunLogEntry): string {
  const time = entry.at.slice(11, 19);
  switch (entry.type) {
    case 'model': return `${time} model ${entry.modelId} (${entry.purpose}${entry.step !== undefined ? ` ${entry.step + 1}` : ''}): ${entry.inputTokens} in, ${entry.outputTokens} out`;
    case 'tool': return `${time} ${entry.ok ? '' : '✗ '}${entry.name} ${entry.note}`;
    case 'approval': return `${time} you: ${entry.action}${entry.step !== undefined ? ` step ${entry.step + 1}` : ''}${entry.detail ? ` (${entry.detail})` : ''}`;
    case 'check': return `${time} check ${entry.script}: ${entry.passed ? 'passed' : 'failed'} (exit ${entry.exitCode})`;
    case 'status': return `${time} → ${entry.status}${entry.error ? `: ${entry.error}` : ''}`;
  }
}

export function renderTaskBody(task: AgentTask, log: RunLogEntry[], modelName: string): string {
  const tokens = log.reduce((sum, entry) => entry.type === 'model' ? { input: sum.input + entry.inputTokens, output: sum.output + entry.outputTokens } : sum, { input: 0, output: 0 });
  const calls = log.filter(entry => entry.type === 'model').length;
  let top = '';
  if (task.status === 'new') {
    top = `<div class="actions">${button('plan', 'Draft plan', { primary: true })}${button('stop', 'Stop task')}</div>`;
  } else if (task.status === 'planning') {
    top = `<div class="actions">${button('cancel', 'Cancel')}</div>`;
  } else if (task.status === 'planReview') {
    top = `<p class="muted">Approving freezes the goal and criteria and creates the task's branch from the current one. Then each step runs only when you press Run.</p>
      <div class="actions">${button('approvePlan', 'Approve plan', { primary: true })}${button('replan', 'Draft again')}${button('stop', 'Stop task')}</div>`;
  }
  return `<header>
      <h1>${escapeHtml(task.title)}</h1>
      <p class="status status-${task.status}">${escapeHtml(STATUS_LABEL[task.status])}</p>
      <p class="muted">${escapeHtml(task.repositoryRoot)}${task.branch ? ` · branch <code>${escapeHtml(task.branch)}</code>` : ''} · model ${escapeHtml(modelName)}</p>
    </header>
    ${task.error ? `<div class="error">${escapeHtml(task.error)}</div>` : ''}
    <section class="contract">
      <h2>Goal${task.frozenAt ? ' <span class="badge">frozen</span>' : ''}</h2>
      <p>${escapeHtml(task.goal)}</p>
      <h2>Acceptance criteria</h2>
      <ol>${task.criteria.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
    </section>
    ${top}
    ${task.plan ? `<section class="plan"><h2>Plan</h2><ol class="steps">${task.plan.map((step, index) => stepCard(task, step, index)).join('')}</ol></section>` : ''}
    <section class="log">
      <details><summary>Run log · ${calls} model call${calls === 1 ? '' : 's'}, ${tokens.input} tokens in, ${tokens.output} out</summary>
        <pre>${escapeHtml(log.slice(-200).map(logLine).join('\n'))}</pre>
      </details>
    </section>`;
}

export function renderTaskPage(nonce: string, cspSource: string, styleUri: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Agent task</title>
</head>
<body>
<main id="task">${body}</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
  if (!target || target.disabled) { return; }
  const index = target.dataset.index === undefined ? undefined : Number(target.dataset.index);
  vscode.postMessage({ type: 'action', action: target.dataset.action, index, path: target.dataset.path });
});
window.addEventListener('message', event => {
  if (event.data && event.data.type === 'render') { document.getElementById('task').innerHTML = event.data.html; }
});
</script>
</body>
</html>`;
}
