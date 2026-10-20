// Webview script for the Repository Review tab: progress, results, triage, auto-fix, past reviews
// and review skills. The dashboard starts reviews and shows evidence in its diff; the extension
// (ReviewBridge) carries messages between the two and to the ReviewController.

(function () {
  const vscode = acquireVsCodeApi();
  const previousState = vscode.getState() || {};

  // What the dashboard shows: its repository, workspace folder, repositories and selected model.
  let context = { repositoryPath: null, folder: '', repositoryName: '', repositories: [], modelId: '' };
  let reviewRequestId = Number(previousState.reviewRequestId) || 0;
  let reviewState = null; // { requestId, repositoryPath, folder, scope, kind, status, progress, result, readiness, context, message }
  let openFindings = new Set(); // findings of the open review shown expanded (all start collapsed)
  let reviewSkills = [];
  // Past reviews of the dashboard's repository, as listed by the extension.
  let reviewHistory = { repositoryPath: null, entries: [] };
  let reviewHistoryListId = 0;
  // The folder the newest Past reviews request was made in.
  let reviewHistoryFolder;
  let historyDateFormat = null;

  function postMessage(type, payload) {
    vscode.postMessage({ type, payload });
  }

  function saveState() {
    vscode.setState({ reviewRequestId });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function shortRevision(revision) {
    if (!revision) return '';
    return revision.length >= 12 && /^[0-9a-f]+$/i.test(revision) ? revision.slice(0, 8) : revision;
  }

  function formatHistoryDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '';
    const ageMs = Date.now() - date.getTime();
    if (ageMs >= 0 && ageMs < 60 * 60 * 1000) return `${Math.max(1, Math.floor(ageMs / 60000))} min ago`;
    if (ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 3600000)} h ago`;
    if (ageMs >= 0 && ageMs < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 86400000)} d ago`;
    if (!historyDateFormat) historyDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit', year: 'numeric' });
    return historyDateFormat.format(date);
  }

  function renderPatchLines(patch) {
    const lines = String(patch || '').replace(/\n$/, '').split('\n');
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    const row = (className, oldNumber, newNumber, text) => `<span class="diff-line ${className}"><i class="diff-ln">${oldNumber}</i><i class="diff-ln">${newNumber}</i><span class="diff-text">${escapeHtml(text) || ' '}</span></span>`;
    return lines.map(line => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        return row('diff-hunk', '', '', line);
      }
      if (!inHunk || line.startsWith('diff --git ')) {
        inHunk = false;
        if (/^(diff --git |index |--- |\+\+\+ )/.test(line)) return '';
        return row('diff-meta', '', '', line);
      }
      if (line.startsWith('+')) return row('diff-addition', '', newLine++, line);
      if (line.startsWith('-')) return row('diff-deletion', oldLine++, '', line);
      if (line.startsWith('\\')) return row('diff-meta', '', '', line);
      return row('diff-context', oldLine++, newLine++, line);
    }).join('');
  }


  function getRepository(path) {
    return (context.repositories || []).find(repository => repository.path === path);
  }

  // Whether the dashboard shows the repository the review is about (in the folder it ran in).
  function reviewIsForActiveRepository() {
    return Boolean(reviewState && reviewState.folder === context.folder && reviewState.repositoryPath === context.repositoryPath);
  }

  // Starts a review the dashboard asked for (beginReview), or a retry of the open one.
  function startReview(options) {
    const repositoryPath = options.repositoryPath || context.repositoryPath;
    if (!repositoryPath) return;
    if (reviewLocked()) {
      document.getElementById('reviewStatus').textContent = REVIEW_LOCK_HINT;
      return;
    }
    const scope = options.scope;
    const kind = options.kind || 'review';
    reviewRequestId += 1;
    saveState();
    const repository = getRepository(repositoryPath);
    reviewState = { requestId: reviewRequestId, repositoryPath, folder: options.folder !== undefined ? options.folder : context.folder,
      repositoryName: repository ? repository.name : repositoryPath, scope, kind,
      baseLabel: scope === 'changes' ? (options.baseLabel || options.base || '') : '', targetLabel: options.targetLabel || options.target || '', status: 'running' };
    openFindings = new Set();
    renderReviewPanel();
    postMessage('startReview', { requestId: reviewRequestId, repositoryPath, scope, kind,
      baseRevision: scope === 'changes' ? options.base : undefined, targetRevision: options.target,
      baseLabel: scope === 'changes' && options.base ? options.baseLabel || shortRevision(options.base) : undefined,
      targetLabel: options.target ? options.targetLabel || shortRevision(options.target) : undefined, modelId: options.modelId || undefined,
      includeQuality: typeof options.includeQuality === 'boolean' ? options.includeQuality : undefined,
      paths: Array.isArray(options.paths) && options.paths.length ? options.paths : undefined, folder: reviewState.folder || undefined });
  }

  function renderReviewSkills(message) {
    const list = document.getElementById('reviewSkillsList');
    const count = document.getElementById('reviewSkillsCount');
    const status = document.getElementById('reviewSkillsStatus');
    if (!list) return;
    if (count) count.textContent = `${reviewSkills.filter(skill => skill.enabled).length}/${reviewSkills.length}`;
    if (status) status.textContent = message || '';
    list.innerHTML = reviewSkills.map(skill => {
      const id = escapeHtml(skill.id);
      const globs = skill.appliesTo.length > 4 ? `${skill.appliesTo.slice(0, 4).join(', ')} +${skill.appliesTo.length - 4}` : skill.appliesTo.join(', ');
      return `<li class="review-skill${skill.enabled ? '' : ' off'}">
        <button type="button" class="review-skill-switch" data-action="toggleReviewSkill" data-skill-id="${id}" data-enabled="${!skill.enabled}" aria-pressed="${skill.enabled}" title="${skill.enabled ? 'Turn off' : 'Turn on'}${skill.category === 'quality' ? ': while a clean code skill is on, every review also checks maintainability (notes that never block)' : ''}">${skill.enabled ? 'On' : 'Off'}</button>
        <span class="review-skill-copy"><strong>${escapeHtml(skill.name)}</strong> <span class="review-skill-kind">${skill.category === 'quality' ? 'clean code' : 'security'}${skill.source === 'imported' ? ' · imported' : ''}</span>
          <small title="${escapeHtml(skill.appliesTo.join(', '))}">${escapeHtml(globs)}</small>${skill.references ? `<small>${escapeHtml(skill.references)}</small>` : ''}</span>
        ${skill.source === 'imported' ? `<button type="button" class="review-history-delete" data-action="removeReviewSkill" data-skill-id="${id}" aria-label="Remove ${escapeHtml(skill.name)}" title="Remove this imported skill">×</button>` : ''}
      </li>`;
    }).join('');
  }


  function reviewProgressPercent() {
    const detail = reviewState && reviewState.detail;
    if (!detail) return 0;
    if (detail.phase === 'finishing') return 100;
    if (detail.filesTotal) return Math.round((100 * detail.filesDone) / detail.filesTotal);
    return detail.units ? Math.round((100 * Math.max(0, detail.unit - 1)) / detail.units) : 0;
  }

  function reviewLocked() {
    return Boolean(reviewState && reviewState.status === 'running');
  }

  const REVIEW_LOCK_HINT = 'A review is running. Wait for it, or cancel it to start another.';

  const REVIEW_PHASES = { planning: 'Planning', analyzing: 'Analyzing', verifying: 'Checking candidate findings', finishing: 'Collecting results' };
  let reviewClock = null;

  function formatElapsed(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  function stopReviewClock() {
    if (reviewClock) clearInterval(reviewClock);
    reviewClock = null;
  }

  // Progress while a review runs: overall bar, where it is, and every component with its state.
  function renderReviewProgress(body) {
    const detail = reviewState.detail;
    const components = reviewState.components || [];
    const list = body.querySelector('.review-steps');
    const scrollTop = list ? list.scrollTop : 0;
    const finishing = detail && detail.phase === 'finishing';
    const percent = reviewProgressPercent();
    const phase = detail ? REVIEW_PHASES[detail.phase] || 'Reviewing' : 'Waiting';
    const where = detail && detail.unit && !finishing
      ? `Component ${detail.unit} of ${detail.units}: <code>${escapeHtml(detail.component || '')}</code> · ${escapeHtml(phase)}`
      : escapeHtml(detail ? phase : reviewState.progress || 'Starting…');
    const counts = detail
      ? `${detail.filesDone} of ${detail.filesTotal} files · ${detail.candidates} candidate finding${detail.candidates === 1 ? '' : 's'} · <span id="reviewElapsed"></span>`
      : '';
    // Each component lists its files, so what is reviewed matches the changed files; files left out
    // (binary, lockfile, budget) are listed with the reason, under their component.
    const fileItem = (filePath, reason) => `<li class="review-step-file${reason ? ' review-step-file-skipped' : ''}" title="${escapeHtml(filePath)}"><span>${escapeHtml(filePath.split('/').pop())}</span>${reason ? `<small>skipped: ${escapeHtml(reason)}</small>` : ''}</li>`;
    const steps = components.map((component, index) => {
      const state = !component.files ? 'skipped'
        : finishing || (detail && index + 1 < detail.unit) ? 'done' : detail && index + 1 === detail.unit ? 'current' : 'pending';
      const mark = { done: '✓', current: '●', pending: '○', skipped: '–' }[state];
      const files = (component.paths || []).map(filePath => fileItem(filePath)).join('') +
        (component.skipped || []).map(item => fileItem(item.path, item.reason)).join('');
      const count = component.files ? `${component.files} file${component.files === 1 ? '' : 's'}` : 'not reviewed';
      return `<li class="review-step review-step-${state}"${state === 'current' ? ' aria-current="step"' : ''}><span class="review-step-mark" aria-hidden="true">${mark}</span><code>${escapeHtml(component.component)}</code><span>${count}</span>${files ? `<ul class="review-step-files">${files}</ul>` : ''}</li>`;
    }).join('');
    body.innerHTML = `<div class="review-progress-block">
        <div class="review-progress-where">${where}</div>
        <div class="review-progress" role="progressbar" aria-label="Review progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span class="review-progress-fill"></span></div>
        <div class="review-progress-counts">${counts}</div>
        <div class="review-progress-message" aria-live="polite">${escapeHtml(reviewState.progress || '')}</div>
      </div>
      ${steps ? `<ol class="review-steps">${steps}</ol>` : ''}
      <p class="review-lock-note">The review keeps running if you close this tab or work in the dashboard; the dashboard's Review button shows its progress.</p>`;
    body.querySelector('.review-progress-fill').style.width = `${percent}%`;
    const newList = body.querySelector('.review-steps');
    if (newList) {
      newList.scrollTop = scrollTop;
      const current = newList.querySelector('[aria-current="step"]');
      if (current && (current.offsetTop < newList.scrollTop || current.offsetTop > newList.scrollTop + newList.clientHeight - 24)) {
        newList.scrollTop = current.offsetTop - newList.clientHeight / 2;
      }
    }
    const tick = () => {
      const elapsed = document.getElementById('reviewElapsed');
      if (elapsed && reviewState && reviewState.startedAt) elapsed.textContent = `${formatElapsed(Date.now() - reviewState.startedAt)} elapsed`;
    };
    tick();
    if (!reviewClock) reviewClock = setInterval(tick, 1000);
  }

  function reviewEvidenceButton(evidence, findingIndex, evidenceIndex) {
    const lines = evidence.startLine === evidence.endLine ? `${evidence.startLine}` : `${evidence.startLine}-${evidence.endLine}`;
    return `<button type="button" class="review-evidence" data-action="reviewEvidence" data-finding="${findingIndex}" data-evidence="${evidenceIndex}" title="${escapeHtml(`${evidence.side} ${shortRevision(evidence.revision)}`)}">${escapeHtml(`${evidence.path}:${lines}`)}</button>`;
  }

  // Auto-fix: one button in the triage summary, and the proposal (or its outcome) below it.
  function renderFixAction(readiness) {
    const count = readiness.toFix || 0;
    // A review of local changes read files you are still editing: auto-fix writes only over files with no local changes.
    if (reviewState.kind === 'local') {
      return '<button type="button" class="btn review-fix-action" data-action="proposeReviewFix" disabled title="Auto-fix needs committed files: fix your uncommitted changes in the editor, or commit them and review the commit to use auto-fix">Fix with Copilot…</button>';
    }
    const busy = reviewState.fix && reviewState.fix.status === 'running';
    const title = count ? 'Copilot proposes edits for the findings marked Needs fix; you see the diff before anything is written'
      : 'Mark findings "Needs fix" first';
    return `<button type="button" class="btn review-fix-action" data-action="proposeReviewFix" title="${title}"${count && !busy ? '' : ' disabled'}>Fix ${count || ''} with Copilot…</button>`;
  }

  const FIX_STEPS = [
    ['checking', 'Check the cited files'],
    ['sending', 'Send findings and files to Copilot'],
    ['receiving', 'Receive the proposed edits'],
    ['validating', 'Check the edits against the files']
  ];

  function formatSize(characters) {
    return characters >= 1024 ? `${(characters / 1024).toFixed(1)} KB` : `${characters} B`;
  }

  // Auto-fix progress: each step with its state, what was sent, how much has arrived, elapsed time.
  function renderFixProgress(fix) {
    const detail = fix.detail || { step: 'checking' };
    const current = FIX_STEPS.findIndex(([step]) => step === detail.step);
    const extra = {
      sending: detail.files ? `${detail.findings} finding${detail.findings === 1 ? '' : 's'}, ${detail.files} file${detail.files === 1 ? '' : 's'} · ${formatSize(detail.sentCharacters || 0)}` : '',
      receiving: detail.receivedCharacters ? `${formatSize(detail.receivedCharacters)} so far` : current === 1 ? 'waiting for Copilot' : ''
    };
    const steps = FIX_STEPS.map(([step, label], index) => {
      const state = index < current ? 'done' : index === current ? 'current' : 'pending';
      const mark = { done: '✓', current: '●', pending: '○' }[state];
      const note = extra[step] && (state !== 'pending' || step === 'receiving' && current === 1) ? `<span>${escapeHtml(extra[step])}</span>` : '';
      return `<li class="review-step review-step-${state}"${state === 'current' ? ' aria-current="step"' : ''}><span class="review-step-mark" aria-hidden="true">${mark}</span><span>${escapeHtml(label)}</span>${note}</li>`;
    }).join('');
    return `<section class="review-fix review-fix-running"><h4>Auto-fix · <span id="reviewFixElapsed"></span></h4>
      <p aria-live="polite">${escapeHtml(fix.message || 'Asking Copilot for a fix…')}</p>
      <ol class="review-steps review-fix-steps">${steps}</ol>
      <button type="button" class="btn" data-action="cancelReviewFix">Cancel</button></section>`;
  }

  let fixClock = null;
  // Ticks the auto-fix elapsed time while a proposal is running; stops itself otherwise.
  function tickFixClock() {
    const fix = reviewState && reviewState.fix;
    const elapsed = document.getElementById('reviewFixElapsed');
    if (!fix || fix.status !== 'running' || !elapsed) { if (fixClock) clearInterval(fixClock); fixClock = null; return; }
    elapsed.textContent = `${formatElapsed(Date.now() - (fix.startedAt || Date.now()))} elapsed`;
    if (!fixClock) fixClock = setInterval(tickFixClock, 1000);
  }

  function renderFixPanel() {
    const fix = reviewState.fix;
    if (!fix) return '';
    if (fix.status === 'running') return renderFixProgress(fix);
    if (fix.status === 'applied') {
      return `<section class="review-fix review-fix-applied" role="status"><h4>Auto-fix applied</h4><p>Changed ${fix.paths.map(item => `<code>${escapeHtml(item)}</code>`).join(', ')} in your working tree. Nothing was staged or committed: check the changes, run your tests, then commit.</p></section>`;
    }
    const close = '<button type="button" class="review-fix-close" data-action="closeFixNote" aria-label="Close" title="Close">×</button>';
    if (fix.status === 'note') return `<section class="review-fix review-fix-note-panel" role="status"><h4>Auto-fix</h4>${close}<p>${escapeHtml(fix.message)}</p></section>`;
    const error = fix.message ? `<div class="dashboard-error" role="alert">${escapeHtml(fix.message)}</div>` : '';
    if (!fix.files) return `<section class="review-fix"><h4>Auto-fix</h4>${close}${error}</section>`;
    const list = (items, className) => items && items.length ? `<ul class="${className}">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '';
    const selected = fix.selected || new Set();
    const count = fix.files.filter(file => selected.has(file.path)).length;
    const applied = (fix.applied || []).length
      ? `<p class="review-fix-applied-note" role="status">Applied to ${fix.applied.map(item => `<code>${escapeHtml(item)}</code>`).join(', ')}. The files below are still only proposed.</p>` : '';
    const findingText = file => {
      const titles = (file.findingIds || []).map(id => (reviewState.result.findings || []).find(finding => finding.id === id))
        .filter(Boolean).map(finding => `${finding.severity} ${finding.category}`);
      return titles.length ? `<span class="review-fix-fixes">fixes ${escapeHtml(titles.join(', '))}</span>` : '';
    };
    return `<section class="review-fix"><h4>Proposed fix · ${fix.files.length} file${fix.files.length === 1 ? '' : 's'}</h4>
      ${error}${applied}${fix.note ? `<p class="review-fix-applied-note" role="status">${escapeHtml(fix.note)}</p>` : ''}
      <p class="review-fix-note">Nothing is written until you apply it. Applying edits your working tree only; it does not stage or commit. Untick a file to leave it out.</p>
      ${list(fix.notes, 'review-gaps')}${list(fix.rejected, 'review-gaps review-fix-rejected')}
      ${fix.files.map(file => `<details class="review-fix-file" open><summary><input type="checkbox" class="review-fix-select" data-path="${escapeHtml(file.path)}" aria-label="Apply ${escapeHtml(file.path)}"${selected.has(file.path) ? ' checked' : ''}> <code>${escapeHtml(file.path)}</code>${findingText(file)}</summary><pre class="diff-viewer">${renderPatchLines(file.patch)}</pre></details>`).join('')}
      <div class="review-fix-buttons"><button type="button" class="btn btn-primary" data-action="applyReviewFix" data-selection="all">Apply all</button><button type="button" class="btn" data-action="applyReviewFix" data-selection="selected"${count && count < fix.files.length ? '' : ' disabled'}>Apply selected (${count})</button><button type="button" class="btn" data-action="discardReviewFix">Discard</button></div>
    </section>`;
  }

  const DISMISS_REASONS = { false_positive: 'False positive', accepted_risk: 'Accepted risk', not_applicable: 'Not applicable' };

  // Needs fix / Dismiss for one finding; pressing the active choice again clears it.
  function renderTriageControls(finding) {
    const triage = (reviewState.triage || {})[finding.id];
    const decision = triage ? triage.decision : '';
    const id = escapeHtml(finding.id);
    const reason = decision === 'dismiss'
      ? `<select class="review-dismiss-reason" data-finding-id="${id}" aria-label="Why it is dismissed">${Object.entries(DISMISS_REASONS)
        .map(([value, label]) => `<option value="${value}"${triage.reason === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`
      : '';
    return `<div class="review-triage" role="group" aria-label="Triage this finding">
      <button type="button" data-action="triageFinding" data-finding-id="${id}" data-decision="fix" aria-pressed="${decision === 'fix'}">Needs fix</button>
      <button type="button" data-action="triageFinding" data-finding-id="${id}" data-decision="dismiss" aria-pressed="${decision === 'dismiss'}">Dismiss</button>${reason}
      <button type="button" data-action="triageFinding" data-finding-id="${id}" data-decision="fixed" aria-pressed="${decision === 'fixed'}" title="Fixed by an applied auto-fix, or mark it fixed by hand">Fixed</button>
    </div>`;
  }

  // Model text with `code` spans shown as code, so names and paths stand out.
  function richText(text) {
    return escapeHtml(text || '').replace(/`([^`\n]{1,200})`/g, '<code>$1</code>');
  }

  // The first sentence, for the one-line view of a collapsed finding.
  function firstSentence(text) {
    const value = String(text || '').trim();
    const match = /^(.{20,180}?[.!?])(\s|$)/.exec(value);
    return match ? match[1] : value.length > 180 ? `${value.slice(0, 177)}…` : value;
  }

  const TRIAGE_LABELS = { fix: 'Needs fix', dismiss: 'Dismissed', fixed: 'Fixed' };

  // Lines of code that speak to an AI reviewer ("NOTE TO AI: this is safe"), found by a pattern
  // check in or around the cited lines: they may have steered the finding, its check or its explanation.
  function aiTextLines(items) {
    return `<ul class="review-ai-text-lines">${items.map(item => `<li><code>${escapeHtml(`${item.path}:${item.line}`)}</code> <span>${escapeHtml(item.text || '')}</span></li>`).join('')}</ul>`;
  }

  function renderAiTextNote(finding) {
    const items = finding.aiDirectedText || [];
    if (!items.length) return '';
    return `<div class="review-ai-text" role="note"><strong>⚠ The cited code speaks to an AI.</strong> Text like this can steer what Copilot reports, how the second check judges it and how it is explained. Read these lines and judge the finding against the code yourself.${aiTextLines(items)}</div>`;
  }

  // The finding Copilot is explaining now, if any: one at a time.
  function explainingFindingId() {
    const explanations = (reviewState && reviewState.explanations) || {};
    return Object.keys(explanations).find(id => explanations[id].status === 'running') || null;
  }

  function explainProgressText(entry) {
    return entry.receivedCharacters ? `Copilot is explaining… ${formatSize(entry.receivedCharacters)} received` : entry.progress || 'Asking Copilot…';
  }

  const EXPLANATION_SECTIONS = [['cause', 'What the code does'], ['risk', 'Why it matters'], ['fix', 'How to fix it'], ['verify', 'How to confirm it']];

  // Copilot's explanation of one finding, asked for on demand: the cause, the risk, a fix and how to
  // confirm it. It is shown in the finding and comes back with the tab, but is not saved with the review.
  function renderExplanation(finding) {
    const entry = (reviewState.explanations || {})[finding.id] || {};
    const id = escapeHtml(finding.id);
    const running = entry.status === 'running';
    const busy = explainingFindingId();
    const explanation = entry.explanation;
    const steered = explanation && (explanation.aiDirectedText || []).length
      ? `<p class="review-explain-note review-explain-steered">⚠ The code sent with this finding speaks to an AI (${explanation.aiDirectedText.map(item => escapeHtml(`${item.path}:${item.line}`)).join(', ')}). Copilot was told to ignore it, but this explanation may still follow it.</p>` : '';
    const label = explanation ? 'Explain again' : entry.status === 'failed' ? 'Try again' : 'Explain with Copilot';
    const button = running ? '' : `<button type="button" class="review-explain-action" data-action="explainFinding" data-finding-id="${id}"${busy
      ? ' disabled title="Copilot is explaining another finding"'
      : ' title="Copilot explains this finding for this code: the cause, the risk, a fix and how to confirm it. Nothing is changed."'}>${label}</button>`;
    const status = running
      ? `<p class="review-explain-status" aria-live="polite"><span class="review-explain-progress" data-finding-id="${id}">${escapeHtml(explainProgressText(entry))}</span><button type="button" class="review-explain-action" data-action="cancelExplanation">Cancel</button></p>`
      : entry.status === 'failed' ? `<div class="dashboard-error" role="alert">${escapeHtml(entry.message || 'Could not explain this finding.')}</div>` : '';
    const sections = explanation ? EXPLANATION_SECTIONS.filter(([key]) => explanation[key]).map(([key, title]) =>
      `<dt>${title}</dt><dd>${richText(explanation[key])}${key === 'fix' && explanation.example
        ? `<pre class="review-explain-example"><code>${escapeHtml(explanation.example)}</code></pre>` : ''}</dd>`).join('') : '';
    const unread = explanation && (explanation.unread || []).length
      ? `<p class="review-explain-note">Copilot did not see all of the cited code: ${explanation.unread.map(item => escapeHtml(item)).join('; ')}.</p>` : '';
    const body = explanation
      ? `<section class="review-explain${running ? ' review-explain-stale' : ''}" aria-label="Explanation by Copilot"><h5${explanation.modelId ? ` title="${escapeHtml(explanation.modelId)}"` : ''}>Explained by Copilot</h5>
        ${steered}<dl>${sections}</dl>${unread}<p class="review-explain-note">An AI explanation: check it against the code before you act on it.</p></section>` : '';
    return `<div class="review-explain-block">${button}${status}${body}</div>`;
  }

  // What to do about a failed check, from its reason (see SecurityReviewService).
  function failureHint(reason) {
    if (/cannot fit|context/i.test(reason)) return 'The files did not fit in the model\'s context. Choose a model with a larger context in Model, or review fewer files with Review commit.';
    if (/ungrounded evidence/i.test(reason)) return 'The model cited lines that are not in the reviewed files (or not changed). Retrying usually clears it.';
    if (/verification|verdict/i.test(reason)) return 'The second check did not answer for every finding, so they stay unconfirmed. Retry to check them again.';
    if (/limit exceeded/i.test(reason)) return 'The model returned more results than one component allows. Review a smaller range with Review commit.';
    if (/policy result/i.test(reason)) return 'The model did not answer for a policy rule. Retry, or check the rule by hand.';
    if (/cancel/i.test(reason)) return 'Stopped before it finished. Retry to review it.';
    return 'Retry; if it fails again with the same reason, try another model.';
  }

  function renderReviewFinding(finding, index) {
    const rule = finding.ruleId ? ` <code>${escapeHtml(finding.ruleId)}</code>` : '';
    const triage = (reviewState.triage || {})[finding.id];
    const triageClass = triage ? ` triage-${triage.decision}` : '';
    const open = openFindings.has(finding.id);
    const id = escapeHtml(finding.id);
    const where = finding.evidence && finding.evidence[0]
      ? `<code class="review-finding-where">${escapeHtml(finding.evidence[0].path)}:${finding.evidence[0].startLine}</code>` : '';
    // A dismissed or fixed finding stays where it was, collapsed, with a way back.
    const reason = triage && triage.decision === 'dismiss' && triage.reason ? ` · ${DISMISS_REASONS[triage.reason] || triage.reason}` : '';
    // A decision taken over from an earlier review of the same issue says so.
    const carried = triage && triage.carried;
    const carriedDate = carried ? new Date(carried.at).toLocaleDateString() : '';
    const chipText = carried && carried.decision === 'fixed' ? 'Reported again after Fixed'
      : `${TRIAGE_LABELS[triage && triage.decision] || (triage && triage.decision) || ''}${reason}${carried ? ' · earlier review' : ''}`;
    const chipTitle = carried ? (carried.decision === 'fixed'
      ? `Marked Fixed in the review of ${carriedDate}, but the same code is reported again: the fix is not in this commit, or did not remove the issue`
      : `Taken over from the review of ${carriedDate}: the same issue on the same code`) : '';
    const chip = triage ? `<span class="review-triage-chip triage-chip-${escapeHtml(triage.decision)}${carried && carried.decision === 'fixed' ? ' triage-chip-again' : ''}"${chipTitle ? ` title="${escapeHtml(chipTitle)}"` : ''}>${escapeHtml(chipText)}</span>` : '';
    const aiChip = (finding.aiDirectedText || []).length
      ? `<span class="review-ai-text-chip" title="${escapeHtml(`The cited code speaks to an AI: ${finding.aiDirectedText.map(item => `${item.path}:${item.line}`).join(', ')}. It may have steered this finding.`)}">⚠ AI text</span>` : '';
    const undo = triage && triage.decision !== 'fix'
      ? `<button type="button" class="review-undo" data-action="triageFinding" data-finding-id="${id}" data-decision="${escapeHtml(triage.decision)}" title="Undo: back to not triaged">Undo</button>` : '';
    return `<li class="review-finding severity-${escapeHtml(finding.severity)}${triageClass}${open ? ' open' : ''}" data-finding-id="${id}">
      <div class="review-finding-head">
        <button type="button" class="review-finding-toggle" data-action="toggleFinding" data-finding-id="${id}" aria-expanded="${open}">
          <span class="review-finding-chevron" aria-hidden="true"></span>
          <span class="review-severity">${escapeHtml(finding.severity)}</span>
          <span class="review-finding-title">${richText(firstSentence(finding.explanation))}</span>
          ${where}
        </button>
        ${aiChip}<span class="review-badge review-badge-${escapeHtml(finding.status)}" title="${finding.status === 'verified' ? 'Evidence passed mechanical checks and a second AI assessment supported it' : 'Not confirmed by the second AI assessment'}">${escapeHtml(finding.status)}</span>${chip}${undo}
      </div>
      <div class="review-finding-body">
        <p class="review-finding-meta">${escapeHtml(finding.category === 'quality' ? 'clean code' : finding.category)}${rule} · confidence ${escapeHtml(finding.confidence)}${finding.skill ? ` · skill <span class="review-skill-tag">${escapeHtml(finding.skill)}</span>` : ''}</p>
        ${renderAiTextNote(finding)}
        <p class="review-finding-explanation">${richText(finding.explanation)}</p>
        <dl><dt>Impact</dt><dd>${richText(finding.impact)}</dd><dt>Suggested action</dt><dd>${richText(finding.suggestedAction)}</dd></dl>
        <div class="review-evidence-list">${finding.evidence.map((evidence, evidenceIndex) => reviewEvidenceButton(evidence, index, evidenceIndex)).join('')}</div>
        ${renderExplanation(finding)}
        ${renderTriageControls(finding)}
      </div>
    </li>`;
  }

  const isQualityItem = item => {
    const finding = item.findingId && reviewState.result && (reviewState.result.findings || []).find(entry => entry.id === item.findingId);
    return Boolean(finding && finding.category === 'quality');
  };

  // Findings stay in the section they were found in (layout: the readiness without triage);
  // policy items follow the current readiness, since a fixed finding can resolve its rule.
  function sectionItems(key) {
    const readiness = reviewState.readiness || {};
    const layout = reviewState.layout;
    if (!layout) {
      const triaged = key === 'attention' || key === 'quality'
        ? (readiness.fixed || []).concat(readiness.dismissed || []).filter(item => isQualityItem(item) === (key === 'quality')) : [];
      return (readiness[key] || []).concat(triaged);
    }
    return (layout[key] || []).filter(item => item.findingId).concat((readiness[key] || []).filter(item => !item.findingId));
  }

  function renderReviewItems(items, findings) {
    if (!items.length) return '<p class="review-none">None.</p>';
    return `<ul class="review-list">${items.map(item => {
      const index = item.findingId ? findings.findIndex(finding => finding.id === item.findingId) : -1;
      return index >= 0
        ? renderReviewFinding(findings[index], index)
        : `<li class="review-item"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></li>`;
    }).join('')}</ul>`;
  }

  function requestReviewHistory() {
    if (!context.repositoryPath) return;
    reviewHistoryFolder = context.folder;
    postMessage('listReviewHistory', { repositoryPath: context.repositoryPath, listId: ++reviewHistoryListId });
  }

  // Every folder's root is '.', so the list belongs to a folder as well as a repository path.
  function activeReviewHistory() {
    return reviewHistory.repositoryPath === context.repositoryPath && reviewHistory.folder === context.folder ? reviewHistory.entries : [];
  }

  // The exact commits a review read: a label like a branch name moves on, these do not.
  function reviewedCommits(scope, baseSha, targetSha) {
    if (!targetSha) return '';
    return scope === 'changes' && baseSha ? `${shortRevision(baseSha)} → ${shortRevision(targetSha)}` : shortRevision(targetSha);
  }

  const READINESS_LABELS = { blocked: 'Blocked', needs_attention: 'Needs attention', no_blocking_findings: 'No blocking findings' };

  // Past reviews of the active repository, newest first; the open one is marked.
  function renderReviewHistory(hasOpenReview) {
    const container = document.getElementById('reviewHistory');
    const list = document.getElementById('reviewHistoryList');
    if (!container || !list) return;
    const entries = activeReviewHistory();
    container.hidden = entries.length === 0;
    if (!entries.length) { list.innerHTML = ''; return; }
    // With nothing open the list is all there is to see, so it starts expanded.
    if (!hasOpenReview && !container.dataset.touched) container.open = true;
    document.getElementById('reviewHistoryCount').textContent = String(entries.length);
    const locked = reviewLocked();
    list.innerHTML = entries.map(entry => {
      const range = entry.scope === 'changes'
        ? `Diff: ${entry.baseLabel || 'parent'} → ${entry.targetLabel}` : `Branch: ${entry.targetLabel}`;
      const counts = [`${entry.findings} finding${entry.findings === 1 ? '' : 's'}`,
        entry.toFix ? `${entry.toFix} to fix` : '', entry.fixed ? `${entry.fixed} fixed` : '', entry.dismissed ? `${entry.dismissed} dismissed` : '',
        entry.stopped ? `stopped at ${entry.stopped.unitsDone}/${entry.stopped.unitsTotal} components` : ''].filter(Boolean).join(' · ');
      const current = reviewState && reviewState.historyId === entry.id;
      const id = escapeHtml(entry.id);
      return `<li class="review-history-item"${current ? ' aria-current="true"' : ''}>
        <button type="button" class="review-history-open" data-action="openStoredReview" data-history-id="${id}"${locked ? ` aria-disabled="true" title="${REVIEW_LOCK_HINT}"` : ` title="Open this review (${escapeHtml(shortRevision(entry.targetSha))})"`}>
          <span class="review-history-date">${escapeHtml(formatHistoryDate(entry.generatedAt))}</span>
          <span class="review-history-range">${entry.kind === 'release' ? '◈ ' : ''}${escapeHtml(range)}</span>
          <code class="review-history-commit" title="Reviewed commit${entry.scope === 'changes' && entry.baseSha ? 's' : ''}">${escapeHtml(reviewedCommits(entry.scope, entry.baseSha, entry.targetSha))}</code>
          <span class="review-history-status readiness-${escapeHtml(entry.status)}">${escapeHtml(READINESS_LABELS[entry.status] || entry.status)}</span>
          <span class="review-history-counts">${escapeHtml(counts)}</span>
        </button>
        <button type="button" class="review-history-delete" data-action="deleteStoredReview" data-history-id="${id}" aria-label="Delete this saved review" title="Delete this saved review">×</button>
      </li>`;
    }).join('');
  }

  function renderReviewPanel() {
    const title = document.getElementById('reviewTitle');
    const meta = document.getElementById('reviewMeta');
    const status = document.getElementById('reviewStatus');
    const body = document.getElementById('reviewBody');
    if (!body) return;
    const hasHistory = activeReviewHistory().length > 0;
    renderReviewHistory(Boolean(reviewState));
    if (!reviewState) {
      ['cancelReviewButton', 'copyReviewButton', 'saveReviewButton'].forEach(id => { document.getElementById(id).hidden = true; });
      title.textContent = context.repositoryName ? `Review · ${context.repositoryName}` : 'Review';
      meta.textContent = '';
      status.textContent = '';
      body.innerHTML = hasHistory
        ? '<div class="dashboard-empty">No review is open. Open a past review, or start one with Review changes, Review commit or Review branch in the dashboard.</div>'
        : '<div class="dashboard-empty">No review yet. Start one with Review changes, Review commit or Review branch in the dashboard; Review skills above sets what Copilot checks.</div>';
      return;
    }
    const running = reviewState.status === 'running';
    const done = reviewState.status === 'completed';
    document.getElementById('cancelReviewButton').hidden = !running;
    document.getElementById('copyReviewButton').hidden = !done;
    document.getElementById('saveReviewButton').hidden = !done;
    // A release review's ends are unknown until the extension has resolved them.
    const release = reviewState.kind === 'release';
    const local = reviewState.kind === 'local';
    const target = reviewState.targetLabel || (release ? 'current branch' : local ? 'local changes' : '');
    const label = reviewState.scope === 'changes'
      ? `Diff: ${reviewState.baseLabel || (release ? 'latest release' : local ? 'HEAD' : 'parent')} → ${target}`
      : `Branch: ${target}`;
    title.textContent = release ? 'Current branch review' : local ? 'Local changes review' : 'Review';
    // Name the repository when the dashboard has moved on to another one (or another folder).
    const request = reviewState.result && reviewState.result.request;
    // The exact commits, unless the label already is them (a Base/Target selection of plain commits).
    const shas = request ? reviewedCommits(request.scope, request.baseSha, request.targetSha) : '';
    const commits = shas && !label.includes(shas) ? ` · ${request.baseSha ? '' : 'commit '}${shas}` : '';
    // Which model is reviewing (while it runs) or reviewed (a saved review keeps it).
    const reviewed = reviewState.result;
    const modelName = (reviewed && (reviewed.modelName || reviewed.modelId)) || (reviewState.detail && reviewState.detail.model) || '';
    const model = modelName ? ` · ${modelName}` : '';
    meta.textContent = `${label}${commits}${model}${reviewIsForActiveRepository() ? '' : ` · ${reviewState.repositoryName || reviewState.repositoryPath}`}`;
    meta.title = reviewed && reviewed.modelId ? `Reviewed with ${reviewed.modelName || reviewed.modelId} (${reviewed.modelId})` : modelName ? `Reviewing with ${modelName}` : '';
    if (running) {
      // Before the engine reports (e.g. waiting for consent) the header says what it waits for.
      status.textContent = reviewState.detail ? '' : reviewState.progress || 'Starting…';
      renderReviewProgress(body);
      return;
    }
    stopReviewClock();
    if (!done) {
      status.textContent = '';
      body.innerHTML = `<div class="${reviewState.cancelled ? 'dashboard-empty' : 'dashboard-error'}">${escapeHtml(reviewState.message || 'Review failed.')}</div>`;
      return;
    }
    const { result, readiness } = reviewState;
    const findings = result.findings || [];
    // The model is named in the header line (reviewMeta), with its exact id in the tooltip.
    status.textContent = '';
    // Findings and review gaps are counted apart ("5 items" hid that 2 of them were not findings),
    // in a blocked result too.
    const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    const findingAndGapCounts = [readiness.attention.length
      ? plural(readiness.attention.length, readiness.status === 'blocked' ? 'other finding' : 'finding') : '',
      (readiness.gaps || []).length ? plural(readiness.gaps.length, 'review gap') : '',
      (readiness.quality || []).length ? plural(readiness.quality.length, 'code quality note') : ''].filter(Boolean);
    const banner = {
      blocked: `Blocked: ${[`${readiness.blocking.length} blocking item${readiness.blocking.length === 1 ? '' : 's'}`, ...findingAndGapCounts].join(' · ')}`,
      needs_attention: `Needs attention: ${findingAndGapCounts.join(' · ')}`,
      no_blocking_findings: `No blocking findings in what was reviewed${(readiness.quality || []).length ? ` · ${plural(readiness.quality.length, 'code quality note')}` : ''}`
    }[readiness.status];
    const coverage = result.coverage;
    const isPartlyReviewed = item => item.partial || /^Partly reviewed/.test(item.reason || '');
    const gaps = coverage.skipped.map(item => [isPartlyReviewed(item) ? 'partly reviewed' : 'skipped', item])
      .concat(coverage.failed.map(item => ['failed', item]));
    const summary = readiness.coverage;
    const coverageText = summary
      ? `${summary.files} file${summary.files === 1 ? '' : 's'}: ${summary.fully} fully reviewed · ${summary.partly} partly${summary.partlyData ? ` (${summary.partlyData} data or generated)` : ''} · ${summary.notReviewed} not reviewed · ${summary.failedChecks} failed check${summary.failedChecks === 1 ? '' : 's'}`
      : `Analyzed ${coverage.analyzed} of ${coverage.surveyed} files · ${coverage.skipped.length} skipped · ${coverage.failed.length} failed checks`;
    // A stopped review shows what it finished; running it again reuses those components.
    const stopped = result.partial
      ? `<div class="review-stopped" role="status"><span>Stopped after <strong>${result.partial.unitsDone} of ${result.partial.unitsTotal}</strong> components. The rest was not reviewed.</span><button type="button" class="btn" data-action="continueReview">Continue review</button></div>`
      : '';
    // Failed checks, once per reason: what failed, where, what to do, and a way to run them again.
    const failedGroups = [];
    for (const item of coverage.failed || []) {
      let group = failedGroups.find(entry => entry.reason === item.reason);
      if (!group) failedGroups.push(group = { reason: item.reason, paths: [] });
      // Older saved reviews list a component once per bad finding.
      if (!group.paths.includes(item.path)) group.paths.push(item.path);
    }
    const failedCount = failedGroups.reduce((sum, group) => sum + group.paths.length, 0);
    const failedSection = failedGroups.length
      ? `<section class="review-failed"><h4>Failed checks <span class="review-count">${failedCount}</span></h4>
        <p class="review-gaps-note">These parts were not reviewed, or their findings were not checked. They are not a pass. <strong>Retry failed</strong> asks Copilot again for what failed only: the second check for findings without a verdict, findings whose citations did not check out, missing policy results. Everything that passed is reused as it is.</p>
        <ul class="review-gaps">${failedGroups.map(group => `<li><strong>${escapeHtml(group.reason)}</strong> — ${group.paths.length === 1 ? `<code>${escapeHtml(group.paths[0])}</code>` : `${group.paths.length} entries: ${group.paths.slice(0, 6).map(path => `<code>${escapeHtml(path)}</code>`).join(', ')}${group.paths.length > 6 ? ', …' : ''}`}<br><span class="review-failed-hint">${escapeHtml(failureHint(group.reason))}</span></li>`).join('')}</ul>
        ${result.partial ? '' : `<button type="button" class="btn" data-action="continueReview" title="Ask again only for what failed; everything that passed is reused">Retry failed</button>`}</section>` : '';
    const logSection = (result.log || []).length
      ? `<details class="review-log"><summary>Review log <span class="review-count">${result.log.length}</span></summary><ol>${result.log.map(entry =>
        `<li class="${/\bfail|\berror/i.test(entry.message) ? 'review-log-failed' : ''}"><time>${escapeHtml(formatElapsed(entry.at))}</time> ${escapeHtml(entry.message)}</li>`).join('')}</ol></details>` : '';
    const toVerify = (result.toVerify || []).length
      ? `<details class="review-to-verify"><summary>To verify <span class="review-count">${result.toVerify.length}</span></summary><p class="review-gaps-note">What the model could not see from the reviewed files: callers, CI settings, external services. Check these by hand.</p><ul>${result.toVerify.map(item => `<li>${richText(item)}</li>`).join('')}</ul></details>`
      : '';
    const policy = (result.policyResults || []).length
      ? `<section><h4>Policy</h4><table class="review-policy"><thead><tr><th>Rule</th><th>Result</th><th>Reason</th></tr></thead><tbody>${result.policyResults.map(item =>
        `<tr class="policy-${escapeHtml(item.status)}"><td><code>${escapeHtml(item.ruleId)}</code></td><td>${escapeHtml(item.status.replace(/_/g, ' '))}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('')}</tbody></table></section>`
      : '';
    const allOpen = findings.length > 0 && findings.every(finding => openFindings.has(finding.id));
    const triageBar = findings.length
      ? `<div class="review-triage-summary" role="status"><span><strong>${readiness.toFix || 0}</strong> to fix</span><span><strong>${(readiness.fixed || []).length}</strong> fixed</span><span><strong>${(readiness.dismissed || []).length}</strong> dismissed</span><span><strong>${readiness.untriaged || 0}</strong> not triaged</span><button type="button" class="review-expand-all" data-action="expandAllFindings" data-expand="${!allOpen}">${allOpen ? 'Collapse all' : 'Expand all'}</button>${renderFixAction(readiness)}</div>`
      : '';
    const blockingItems = sectionItems('blocking');
    const attentionItems = sectionItems('attention');
    const reviewedQuality = (result.request.categories || []).includes('quality');
    const qualitySection = reviewedQuality
      ? `<section class="review-quality"><h4>Code quality <span class="review-count">${(readiness.quality || []).length}</span></h4><p class="review-gaps-note">Maintainability notes from the clean code review. They never block.</p>${renderReviewItems(sectionItems('quality'), findings)}</section>` : '';
    const skillsUsed = (result.skillsApplied || []).length
      ? `<details class="review-skills-applied"><summary>Review skills used <span class="review-count">${[...new Set(result.skillsApplied.flatMap(item => item.skills))].length}</span></summary><ul>${result.skillsApplied.map(item =>
        `<li><code>${escapeHtml(item.component)}</code> ${item.skills.map(id => `<span class="review-skill-tag">${escapeHtml(id)}</span>`).join(' ')}${(item.omitted || []).length ? ` <small>left out (too long): ${escapeHtml(item.omitted.join(', '))}</small>` : ''}</li>`).join('')}</ul></details>` : '';
    // Lines anywhere in the reviewed diff that speak to an AI: they may have kept a problem from being
    // reported, where no finding is left to carry a warning.
    const aiText = result.aiDirectedText || [];
    const aiTextSection = aiText.length
      ? `<section class="review-ai-text review-ai-text-review" role="note"><strong>⚠ The reviewed code speaks to an AI in ${aiText.length}${result.aiDirectedTextTruncated ? '+' : ''} place${aiText.length === 1 && !result.aiDirectedTextTruncated ? '' : 's'}.</strong> Text like this can keep Copilot from reporting a problem, so what this review did not find counts for less. Read these lines and check that code yourself.${aiTextLines(aiText)}${result.aiDirectedTextTruncated ? '<p class="review-explain-note">Only the first lines are listed.</p>' : ''}</section>`
      : '';
    // Reviews read commits only; say so when there is work they did not see.
    const reviewedRepository = getRepository(reviewState.repositoryPath);
    const uncommitted = reviewState.kind === 'local'
      ? '<p class="review-uncommitted-note" role="note">This review read your local changes as they were when it started. Changes made since are not in it: use Review changes again to include them.</p>'
      : reviewIsForActiveRepository() && reviewedRepository && reviewedRepository.hasChanges
        ? '<p class="review-uncommitted-note" role="note">This repository has uncommitted changes. Reviews read committed files only, so they were not reviewed: use Review changes in the dashboard to review them before committing.</p>' : '';
    body.innerHTML = `${uncommitted}<div class="review-readiness readiness-${escapeHtml(readiness.status)}" role="status"><strong>${escapeHtml(banner)}</strong></div>
      ${aiTextSection}
      ${stopped}
      ${triageBar}
      ${renderFixPanel()}
      <section class="review-blocking"><h4>Blocking <span class="review-count">${readiness.blocking.length}</span></h4>${renderReviewItems(blockingItems, findings)}</section>
      <section class="review-attention"><h4>Needs attention <span class="review-count">${readiness.attention.length}</span></h4>${renderReviewItems(attentionItems, findings)}</section>
      ${qualitySection}
      ${(readiness.gaps || []).length ? `<section class="review-gaps-section"><h4>Review gaps</h4><p class="review-gaps-note">What this review could not establish. Not findings, but not passes either.</p>${renderReviewItems(readiness.gaps, findings)}</section>` : ''}
      ${policy}
      ${toVerify}
      ${skillsUsed}
      ${failedSection}
      <section><h4>Coverage</h4><p>${escapeHtml(coverageText)} · ${coverage.complete ? 'complete' : 'incomplete'}</p>${gaps.length
        ? `<details><summary>Partly reviewed, skipped and failed</summary><ul class="review-gaps">${gaps.slice(0, 200).map(([kind, item]) => `<li>${kind}: <code>${escapeHtml(item.path)}</code> — ${escapeHtml(item.reason)}</li>`).join('')}</ul></details>` : ''}</section>
      ${logSection}
      ${(result.limitations || []).length ? `<section><h4>Limitations</h4><ul class="review-gaps">${result.limitations.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>` : ''}
      <p class="review-advisory">Advisory: verified findings passed mechanical evidence checks and a second AI assessment. No findings does not mean no vulnerabilities.</p>`;
    tickFixClock();
  }


  // Show the cited line in the dashboard's diff when the review compared two commits of the
  // repository the dashboard shows; otherwise open the file at the reviewed revision in an editor.
  function jumpToReviewEvidence(findingIndex, evidenceIndex) {
    if (!reviewState || !reviewState.result) return;
    const finding = reviewState.result.findings[findingIndex];
    const evidence = finding && finding.evidence[evidenceIndex];
    if (!evidence) return;
    const request = reviewState.result.request;
    if (request.scope === 'changes' && request.baseSha && reviewIsForActiveRepository()) {
      postMessage('showReviewEvidence', { repositoryPath: reviewState.repositoryPath, folder: reviewState.folder,
        baseSha: request.baseSha, targetSha: request.targetSha, path: evidence.path, side: evidence.side, line: evidence.startLine });
      return;
    }
    postMessage('openReviewEvidence', { requestId: reviewState.requestId, repositoryPath: reviewState.repositoryPath, revision: evidence.revision, path: evidence.path, line: evidence.startLine });
  }

  const actionHandlers = {
    cancelReview: () => postMessage('cancelReview', {}),
    openStoredReview: (el) => {
      if (!context.repositoryPath || reviewLocked() || !el.dataset.historyId) return;
      const entry = reviewHistory.entries.find(item => item.id === el.dataset.historyId);
      if (!entry) return;
      reviewRequestId += 1;
      saveState();
      const repository = getRepository(context.repositoryPath);
      reviewState = { requestId: reviewRequestId, repositoryPath: context.repositoryPath, folder: context.folder,
        repositoryName: repository ? repository.name : context.repositoryPath, scope: entry.scope, kind: entry.kind,
        baseLabel: entry.baseLabel || '', targetLabel: entry.targetLabel, status: 'opening', cancelled: true, message: 'Opening the saved review…' };
      renderReviewPanel();
      // The labels go along so that a tab opened again restores the review as it was (reviewRestore).
      postMessage('openStoredReview', { requestId: reviewRequestId, id: entry.id, repositoryPath: context.repositoryPath, folder: context.folder,
        scope: entry.scope, kind: entry.kind, baseLabel: entry.baseLabel || '', targetLabel: entry.targetLabel });
    },
    deleteStoredReview: (el) => {
      if (!context.repositoryPath || !el.dataset.historyId) return;
      if (reviewState && reviewState.historyId === el.dataset.historyId) reviewState.historyId = null;
      postMessage('deleteStoredReview', { id: el.dataset.historyId, repositoryPath: context.repositoryPath, listId: ++reviewHistoryListId });
    },
    exportReview: (el) => {
      if (reviewState && reviewState.status === 'completed') {
        postMessage('exportReviewReport', { requestId: reviewState.requestId, format: el.dataset.format === 'save' ? 'save' : 'copy' });
      }
    },
    reviewEvidence: (el) => jumpToReviewEvidence(Number(el.dataset.finding), Number(el.dataset.evidence)),
    proposeReviewFix: () => {
      if (!reviewState || reviewState.status !== 'completed') return;
      reviewState.fix = { status: 'running', message: 'Checking the cited files in your working tree…', startedAt: Date.now() };
      renderReviewPanel();
      postMessage('proposeReviewFix', { requestId: reviewState.requestId, modelId: context.modelId || undefined });
    },
    // Apply all, or only the files ticked in the proposal (Apply selected).
    applyReviewFix: (el) => {
      if (!reviewState || !reviewState.fix || !reviewState.fix.files) return;
      const paths = el.dataset.selection === 'selected' ? reviewState.fix.files.map(file => file.path).filter(item => reviewState.fix.selected.has(item)) : undefined;
      if (paths && !paths.length) return;
      postMessage('applyReviewFix', { requestId: reviewState.requestId, paths });
    },
    discardReviewFix: () => { if (reviewState) postMessage('discardReviewFix', { requestId: reviewState.requestId }); },
    // Runs the review again at the same commits: finished and clean components are reused, so only
    // the rest (after a stop) or the components whose checks failed are asked again.
    continueReview: () => {
      const result = reviewState && reviewState.result;
      if (!result || !(result.partial || (result.coverage.failed || []).length)) return;
      const { request } = result;
      const reviewContext = reviewState.context || {};
      // The repository path is relative to the workspace folder the review ran in.
      if (reviewState.folder !== context.folder) {
        document.getElementById('reviewStatus').textContent = 'Switch the dashboard back to the workspace folder this review ran in to run it again.';
        return;
      }
      // The same repository, model ("id:version" → id) and categories, so its saved components match.
      const modelId = result.modelId ? result.modelId.slice(0, result.modelId.lastIndexOf(':') > 0 ? result.modelId.lastIndexOf(':') : undefined) : '';
      // A local review runs again on the same snapshot, as a local review.
      startReview({ kind: reviewState.kind === 'local' ? 'local' : undefined,
        scope: request.scope, target: request.targetSha, base: request.scope === 'changes' ? request.baseSha : undefined,
        targetLabel: reviewContext.targetLabel, baseLabel: reviewContext.baseLabel, includeQuality: (request.categories || []).includes('quality'),
        paths: request.paths, repositoryPath: reviewState.repositoryPath, folder: reviewState.folder, modelId });
    },
    importReviewSkill: () => postMessage('importReviewSkill', {}),
    toggleReviewSkill: (el) => {
      if (el.dataset.skillId) postMessage('setReviewSkillEnabled', { id: el.dataset.skillId, enabled: el.dataset.enabled === 'true' });
    },
    removeReviewSkill: (el) => {
      if (el.dataset.skillId) postMessage('removeReviewSkill', { id: el.dataset.skillId });
    },
    // A note or a failure about the fix stays until it is closed; it holds nothing to apply.
    closeFixNote: () => {
      if (!reviewState || !reviewState.fix || reviewState.fix.files) return;
      reviewState.fix = null;
      renderReviewPanel();
    },
    // Findings are collapsed to one line; the open ones stay open across refreshes.
    toggleFinding: (el) => {
      const id = el.dataset.findingId;
      if (!id) return;
      if (openFindings.has(id)) openFindings.delete(id); else openFindings.add(id);
      const item = el.closest('.review-finding');
      if (item) item.classList.toggle('open', openFindings.has(id));
      el.setAttribute('aria-expanded', String(openFindings.has(id)));
    },
    expandAllFindings: (el) => {
      if (!reviewState || !reviewState.result) return;
      const open = el.dataset.expand === 'true';
      openFindings = open ? new Set((reviewState.result.findings || []).map(finding => finding.id)) : new Set();
      renderReviewPanel();
    },
    cancelReviewFix: () => postMessage('cancelReviewFix', {}),
    // Explain one finding; an earlier explanation stays on screen until the new one arrives.
    explainFinding: (el) => {
      const id = el.dataset.findingId;
      if (!id || !reviewState || reviewState.status !== 'completed' || explainingFindingId()) return;
      const explanations = reviewState.explanations || (reviewState.explanations = {});
      explanations[id] = { status: 'running', explanation: (explanations[id] || {}).explanation };
      renderReviewPanel();
      postMessage('explainReviewFinding', { requestId: reviewState.requestId, findingId: id, modelId: context.modelId || undefined });
    },
    cancelExplanation: () => postMessage('cancelReviewExplanation', {}),
    triageFinding: (el) => {
      if (!reviewState || reviewState.status !== 'completed') return;
      const current = (reviewState.triage || {})[el.dataset.findingId];
      const decision = current && current.decision === el.dataset.decision ? null : el.dataset.decision;
      postMessage('setFindingTriage', { requestId: reviewState.requestId, findingId: el.dataset.findingId, decision,
        reason: decision === 'dismiss' ? 'false_positive' : undefined });
    }
  };

  document.body.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target || target.getAttribute('aria-disabled') === 'true') return;
    const handler = actionHandlers[target.dataset.action];
    if (handler) {
      event.preventDefault();
      handler(target, event);
    }
  });

  // Once the user opens or closes Past reviews, the tab stops choosing for them.
  const reviewHistoryDetails = document.getElementById('reviewHistory');
  if (reviewHistoryDetails) reviewHistoryDetails.addEventListener('click', event => {
    if (event.target.closest('summary')) reviewHistoryDetails.dataset.touched = 'true';
  });

  // The reason for a dismissal is a select inside the finding, so it reports through 'change'.
  document.addEventListener('change', event => {
    const select = event.target;
    // A file ticked or unticked in a proposed fix: only the selection and Apply selected change.
    if (select && select.classList && select.classList.contains('review-fix-select')) {
      const fix = reviewState && reviewState.fix;
      if (!fix || !fix.selected) return;
      if (select.checked) fix.selected.add(select.dataset.path); else fix.selected.delete(select.dataset.path);
      renderReviewPanel();
      return;
    }
    if (!select || !select.classList || !select.classList.contains('review-dismiss-reason')) return;
    if (!reviewState || reviewState.status !== 'completed') return;
    postMessage('setFindingTriage', { requestId: reviewState.requestId, findingId: select.dataset.findingId,
      decision: 'dismiss', reason: select.value });
  });

  // A review's messages, from the start (or the dashboard's request) to its result.
  function applyReviewMessage(type, payload) {
    if (type === 'reviewProgress') {
      reviewState.progress = payload.message;
      if (payload.detail) {
        reviewState.detail = payload.detail;
        if (payload.detail.components) reviewState.components = payload.detail.components;
        if (!reviewState.startedAt) reviewState.startedAt = Date.now();
      }
      // The extension resolves the release range, so it reports the labels it settled on.
      if (payload.targetLabel) Object.assign(reviewState, { baseLabel: payload.baseLabel || '', targetLabel: payload.targetLabel });
    } else if (type === 'reviewCompleted') {
      Object.assign(reviewState, { status: 'completed', result: payload.result, readiness: payload.readiness, context: payload.context,
        layout: payload.layout || null, triage: payload.triage || {}, historyId: payload.historyId || null, explanations: {} });
      if (payload.context) Object.assign(reviewState, { baseLabel: payload.context.baseLabel || '', targetLabel: payload.context.targetLabel });
    } else if (type === 'reviewFailed') {
      Object.assign(reviewState, { status: payload.cancelled ? 'cancelled' : 'failed', cancelled: Boolean(payload.cancelled), message: payload.message });
    } else if (type === 'reviewTriageUpdated' && reviewState.status === 'completed') {
      // A finding just dismissed or fixed folds away where it is; Undo brings it back.
      const before = reviewState.triage || {};
      Object.entries(payload.triage || {}).forEach(([id, item]) => {
        if (['dismiss', 'fixed'].includes(item.decision) && (!before[id] || before[id].decision !== item.decision)) openFindings.delete(id);
      });
      Object.assign(reviewState, { triage: payload.triage || {}, readiness: payload.readiness, layout: payload.layout || reviewState.layout });
    } else if (['reviewExplainProgress', 'reviewExplanation', 'reviewExplainFailed'].includes(type) && payload.findingId) {
      const explanations = reviewState.explanations || (reviewState.explanations = {});
      const entry = explanations[payload.findingId] || {};
      if (type === 'reviewExplainProgress') {
        explanations[payload.findingId] = Object.assign({}, entry, { status: 'running', progress: payload.message,
          receivedCharacters: payload.receivedCharacters || entry.receivedCharacters });
      } else if (type === 'reviewExplanation') {
        explanations[payload.findingId] = { status: 'done', explanation: payload.explanation };
      } else if (payload.cancelled) {
        // Cancelled: back to the earlier explanation, or to none.
        if (entry.explanation) explanations[payload.findingId] = { status: 'done', explanation: entry.explanation };
        else delete explanations[payload.findingId];
      } else {
        explanations[payload.findingId] = { status: 'failed', message: payload.message, explanation: entry.explanation };
      }
    }
  }

  window.addEventListener('message', event => {
    const message = event.data || {};
    const payload = message.payload || {};
    switch (message.type) {
      case 'dashboardContext': {
        const previous = context;
        context = Object.assign({ repositories: [] }, payload);
        // The tab follows the dashboard: another repository shows its past reviews. A review that is
        // running, or one of this repository, stays open.
        const moved = previous.repositoryPath !== context.repositoryPath || previous.folder !== context.folder;
        if (moved && reviewState && reviewState.status !== 'running' && !reviewIsForActiveRepository()) {
          reviewState = null;
          openFindings = new Set();
        }
        if (moved || reviewHistory.repositoryPath !== context.repositoryPath || reviewHistory.folder !== context.folder) requestReviewHistory();
        renderReviewPanel();
        break;
      }
      case 'beginReview':
        startReview(payload);
        break;
      // The tab was closed and opened again: the review it showed, as far as it got.
      case 'reviewRestore': {
        if (!payload.start) break;
        const start = payload.start;
        reviewRequestId = Math.max(reviewRequestId, start.requestId);
        saveState();
        reviewState = { requestId: start.requestId, repositoryPath: start.repositoryPath, folder: start.folder || '',
          repositoryName: (getRepository(start.repositoryPath) || {}).name || start.repositoryPath, scope: start.scope, kind: start.kind || 'review',
          baseLabel: start.baseLabel || '', targetLabel: start.targetLabel || '', status: start.opening ? 'opening' : 'running', cancelled: Boolean(start.opening) };
        (payload.messages || []).forEach(item => applyReviewMessage(item.type, item.payload || {}));
        // As when the tab stays open: the tab follows the dashboard, except while a review runs.
        if (reviewState.status !== 'running' && !reviewIsForActiveRepository()) reviewState = null;
        renderReviewPanel();
        break;
      }
      case 'reviewHistoryLoaded':
        if (payload.listId !== reviewHistoryListId) break;
        reviewHistory = { repositoryPath: payload.repositoryPath, folder: reviewHistoryFolder, entries: Array.isArray(payload.entries) ? payload.entries : [] };
        renderReviewPanel();
        break;
      case 'reviewProgress':
      case 'reviewCompleted':
      case 'reviewFailed':
      case 'reviewTriageUpdated':
        if (!reviewState || payload.requestId !== reviewState.requestId) break;
        if (message.type === 'reviewCompleted') openFindings = new Set();
        applyReviewMessage(message.type, payload);
        if (message.type === 'reviewCompleted' || (message.type === 'reviewTriageUpdated' && reviewState.historyId)) requestReviewHistory();
        renderReviewPanel();
        break;
      case 'reviewExplainProgress':
      case 'reviewExplanation':
      case 'reviewExplainFailed': {
        if (!reviewState || payload.requestId !== reviewState.requestId || reviewState.status !== 'completed') break;
        const wasRunning = ((reviewState.explanations || {})[payload.findingId] || {}).status === 'running';
        applyReviewMessage(message.type, payload);
        // Progress while the reply arrives updates its own line, rather than redrawing every finding.
        const line = message.type === 'reviewExplainProgress' && wasRunning
          ? [...document.querySelectorAll('.review-explain-progress')].find(item => item.dataset.findingId === payload.findingId) : null;
        if (line) line.textContent = explainProgressText(reviewState.explanations[payload.findingId]);
        else renderReviewPanel();
        break;
      }
      case 'reviewFixProgress':
      case 'reviewFixProposed':
      case 'reviewFixFailed':
      case 'reviewFixApplied':
      case 'reviewFixUpdated':
      case 'reviewFixDiscarded': {
        if (!reviewState || payload.requestId !== reviewState.requestId) break;
        const previous = reviewState.fix || {};
        reviewState.fix = {
          reviewFixProgress: () => ({ status: 'running', message: payload.message, detail: payload.detail || previous.detail,
            startedAt: previous.startedAt || Date.now() }),
          reviewFixProposed: () => ({ status: 'proposed', files: payload.files || [], notes: payload.notes || [], rejected: payload.rejected || [],
            selected: new Set((payload.files || []).map(file => file.path)) }),
          // A failed Apply keeps the proposal on screen with the reason.
          reviewFixFailed: () => (payload.keepProposal ? Object.assign({}, previous, { message: payload.message })
            : payload.cancelled ? null : { status: 'failed', message: payload.message }),
          // Apply selected leaves the other files proposed, still ticked as they were.
          reviewFixApplied: () => ((payload.remaining || []).length
            ? Object.assign({}, previous, { files: payload.remaining, message: '', applied: (previous.applied || []).concat(payload.paths || []),
              selected: new Set(payload.remaining.map(file => file.path).filter(item => previous.selected && previous.selected.has(item))) })
            : { status: 'applied', paths: (previous.applied || []).concat(payload.paths || []) }),
          // Findings no longer marked "Needs fix" took their files out of the proposal; the rest stays.
          reviewFixUpdated: () => Object.assign({}, previous, { files: payload.files || [], note: payload.message || '',
            selected: new Set((payload.files || []).map(file => file.path).filter(item => !previous.selected || previous.selected.has(item))) }),
          // Closed by a triage change: say why, until the note is closed.
          reviewFixDiscarded: () => (payload.message ? { status: 'note', message: payload.message } : null)
        }[message.type]();
        renderReviewPanel();
        break;
      }
      case 'reviewSkillsLoaded':
        reviewSkills = Array.isArray(payload.skills) ? payload.skills : [];
        renderReviewSkills(payload.message);
        break;
    }
  });

  renderReviewPanel();
  // Ready first: the bridge drops what the controller posts before then (the skills list too).
  postMessage('reviewReady', {});
  postMessage('listReviewSkills', {});
})();
