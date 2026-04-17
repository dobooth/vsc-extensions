  const vscode = acquireVsCodeApi();
  let _tokenUrl = '';
  let _reportTimestamp = null;
  let _issueCount = 0;
  const REPORT_INTERVAL_MS = 4 * 60 * 60 * 1000;

  function fmtMins(mins) {
    if (mins < 60) { return mins + 'm'; }
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? h + 'h ' + m + 'm' : h + 'h';
  }

  function updateReportStatusCard() {
    const card = document.getElementById('reportStatusCard');
    const icon = document.getElementById('reportStatusIcon');
    const text = document.getElementById('reportStatusText');
    const next = document.getElementById('reportNextLine');
    if (!_reportTimestamp) {
      icon.textContent = '○'; icon.style.color = '';
      text.textContent = _issueCount ? _issueCount + ' issues' : 'Loading…';
      text.style.color = '';
      next.textContent = '';
      return;
    }
    card.style.display = 'block';

    const ageMs = Date.now() - _reportTimestamp;
    const ageMins = Math.floor(ageMs / 60000);
    const ageStr = fmtMins(ageMins) + ' ago';
    const stale = ageMs > REPORT_INTERVAL_MS;

    const nextMs = REPORT_INTERVAL_MS - (ageMs % REPORT_INTERVAL_MS);
    const nextMins = Math.ceil(nextMs / 60000);
    const nextStr = fmtMins(nextMins);

    if (_issueCount === 0) {
      icon.textContent = '✓';
      icon.style.color = 'var(--vscode-testing-iconPassed, #4caf50)';
      text.textContent = 'All clear';
      text.style.color = 'var(--vscode-testing-iconPassed, #4caf50)';
    } else {
      icon.textContent = '⚠';
      icon.style.color = stale ? 'var(--vscode-errorForeground)' : 'var(--vscode-notificationsWarningIcon-foreground, #d7ba7d)';
      text.textContent = _issueCount + ' issue' + (_issueCount === 1 ? '' : 's') + ' need attention';
      text.style.color = stale ? 'var(--vscode-errorForeground)' : '';
    }

    next.textContent = 'Report from ' + ageStr + (stale ? ' — overdue' : '  ·  next in ~' + nextStr);
    next.style.color = stale ? 'var(--vscode-errorForeground)' : 'var(--vscode-descriptionForeground)';
  }

  setInterval(updateReportStatusCard, 60000);

  function refresh() { vscode.postMessage({ command: 'refresh' }); }
  function mergePush() { vscode.postMessage({ command: 'mergePush' }); }
  function autoFix() { vscode.postMessage({ command: 'autoFix' }); }
  function repofixes() { vscode.postMessage({ command: 'repofixes' }); }
  function applyFixes() { vscode.postMessage({ command: 'applyFixes' }); }

  function openTokenUrl() {
    if (_tokenUrl) vscode.postMessage({ command: 'openUrl', url: _tokenUrl });
  }

  function openUrl(url) {
    vscode.postMessage({ command: 'openUrl', url });
  }

  function submitCredentials() {
    const token = document.getElementById('tokenInput').value.trim();
    const claudeKey = document.getElementById('claudeKeyInput').value.trim();
    const openAiKey = document.getElementById('openAiKeyInput').value.trim();
    const err = document.getElementById('setupError');
    if (!token) { err.textContent = 'Jenkins API token is required.'; err.style.display = 'block'; return; }
    if (!claudeKey && !openAiKey) { err.textContent = 'At least one AI key (Claude or ChatGPT) is required.'; err.style.display = 'block'; return; }
    err.style.display = 'none';
    vscode.postMessage({ command: 'saveCredentials', token, claudeKey, openAiKey });
  }

  // Allow Enter key in any setup input to submit
  ['tokenInput', 'claudeKeyInput', 'openAiKeyInput'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', function(e) {
      if (e.key === 'Enter') submitCredentials();
    });
  });

  function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  }

  function formatDuration(ms) {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return s > 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
  }

  function formatAgo(startTime) {
    if (!startTime) return '';
    const diff = Math.floor((Date.now() - new Date(startTime).getTime()) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    return Math.floor(diff / 3600) + 'h ago';
  }

  function badgeClass(result, state) {
    if (state === 'QUEUED') return 'badge-queued';
    if (state === 'RUNNING') return 'badge-running';
    if (result === 'SUCCESS') return 'badge-success';
    if (result === 'FAILURE' || result === 'UNSTABLE') return 'badge-failure';
    return 'badge-aborted';
  }

  function renderHistory(history, queue) {
    if (!history || history.length === 0) {
      return '<span class="empty">No build history.</span>';
    }
    let html = '';
    if (queue) {
      html += '<div class="build-row"><span class="build-num">—</span><span class="badge badge-queued">QUEUED</span><span class="build-meta">' + escHtml(queue.why) + '</span></div>';
    }
    for (const run of history) {
      const result = run.result || (run.state === 'RUNNING' ? 'RUNNING' : 'ABORTED');
      const bc = badgeClass(run.result, run.state);
      html += '<div class="build-row">';
      html += '<span class="build-num">#' + run.id + '</span>';
      html += '<span class="badge ' + bc + '">' + result + '</span>';
      html += '<span class="build-meta">' + formatAgo(run.startTime) + (run.durationInMillis ? ' · ' + formatDuration(run.durationInMillis) : '') + '</span>';
      html += '</div>';
    }
    return html;
  }

  function renderErrors(summary) {
    if (!summary || (!summary.errors.length && !summary.unparsed.length)) {
      return '<span class="empty">No errors from recent builds.</span>';
    }
    let html = '<div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px">Build #' + summary.buildNum + '</div>';

    // Parsed link errors
    for (const err of summary.errors) {
      const rowClass = err.active ? 'error-row' : 'error-row resolved';
      const checkmark = err.active ? '' : ' ✓';
      html += '<div class="' + rowClass + '">';
      html += '<span class="error-file open-file" data-file="' + escAttr(err.filepath) + '" data-line="' + err.lineno + '">' + escHtml(err.filepath) + ':' + err.lineno + checkmark + '</span> ';
      html += '<span class="error-target">' + escHtml(err.target) + '</span>';
      if (err.active) {
        let fc = '';
        if (err.fixStatus === 'path-fix') fc = '<span class="fix-badge fix-path">path fix</span>';
        else if (err.fixStatus === 'delink') fc = '<span class="fix-badge fix-delink">de-link</span>';
        else if (err.fixStatus === 'ambiguous') fc = '<span class="fix-badge fix-ambiguous">ambiguous</span>';
        html += fc;
      }
      html += '</div>';
    }

    // Raw stage failure lines (linting, test failures, etc.)
    if (summary.unparsed.length) {
      if (summary.errors.length) {
        html += '<div style="margin-top:8px;border-top:1px solid var(--vscode-widget-border);padding-top:6px"></div>';
      }
      let lastStage = '';
      for (const u of summary.unparsed) {
        if (u.stage !== lastStage) {
          lastStage = u.stage;
          const stageLabel = u.loglink
            ? '<span class="open-url" data-url="' + escAttr(u.loglink) + '" style="cursor:pointer;text-decoration:underline">' + escHtml(u.stage) + '</span>'
            : escHtml(u.stage);
          html += '<div style="font-size:11px;color:var(--vscode-descriptionForeground);margin:4px 0 2px">' + stageLabel + '</div>';
        }
        html += '<div class="error-row" style="font-family:var(--vscode-editor-font-family);white-space:pre-wrap;word-break:break-all">' + escHtml(u.line) + '</div>';
      }
    }

    return html;
  }

  function renderRepofixes(futureErrors, linkErrors) {
    let html = '';
    const fixedRows = [];
    const flaggedRows = [];

    function fileLink(file, line) {
      return '<span class="error-file open-file" data-file="' + escAttr(file) + '" data-line="' + escAttr(line || '') + '">'
        + escHtml(file) + (line ? '<span style="color:var(--vscode-descriptionForeground)">:' + escHtml(line) + '</span>' : '')
        + '</span>';
    }

    if (futureErrors && futureErrors.length) {
      const active = futureErrors.filter(e => !e.alreadyFixed && !e.falsePositive);
      if (active.length) {
        html += '<div class="section-title" style="margin-bottom:4px">Internal Link Issues (' + active.length + ')</div>';
        for (const e of active) {
          const canFix = e.bucket === 'suggest-delink';
          const badge = canFix
            ? '<span class="repofix-bucket bucket-fix">Auto Fix</span>'
            : '<span class="repofix-bucket bucket-manual">manual</span>';
          html += '<div class="repofix-row">' + fileLink(e.file, '') + badge;
          html += '<div class="repofix-desc">' + escHtml(e.description) + '</div></div>';
        }
      }
      for (const e of futureErrors.filter(e => e.alreadyFixed)) {
        fixedRows.push('<div class="repofix-row">' + fileLink(e.file, '')
          + '<span class="repofix-bucket bucket-fixed">Fixed Locally</span></div>');
      }
      for (const e of futureErrors.filter(e => e.falsePositive)) {
        flaggedRows.push('<div class="repofix-row">' + fileLink(e.file, '')
          + '<span class="repofix-bucket bucket-flagged">False Positive</span>'
          + '<div class="repofix-url">' + escHtml(e.url || '') + '</div></div>');
      }
    }

    if (linkErrors && linkErrors.length) {
      const active = linkErrors.filter(e => !e.alreadyFixed && !e.falsePositive);
      if (active.length) {
        html += '<div class="section-title" style="margin:10px 0 4px">External Link Issues (' + active.length + ')</div>';
        for (const e of active) {
          html += '<div class="repofix-row">' + fileLink(e.file, e.line)
            + '<span class="repofix-bucket bucket-fix">Auto Fix</span>';
          html += '<div class="repofix-url">' + escHtml(e.url) + '</div>';
          if (e.reason) { html += '<div class="repofix-desc">' + escHtml(e.reason) + '</div>'; }
          html += '</div>';
        }
      }
      for (const e of linkErrors.filter(e => e.alreadyFixed)) {
        fixedRows.push('<div class="repofix-row">' + fileLink(e.file, e.line)
          + '<span class="repofix-bucket bucket-fixed">Fixed Locally</span></div>');
      }
      for (const e of linkErrors.filter(e => e.falsePositive)) {
        flaggedRows.push('<div class="repofix-row">' + fileLink(e.file, e.line)
          + '<span class="repofix-bucket bucket-flagged">False Positive</span>'
          + '<div class="repofix-url">' + escHtml(e.url) + '</div></div>');
      }
    }

    if (fixedRows.length) {
      if (html) {
        // Active errors exist — show expandable fixed list alongside them
        html += '<div class="section-title collapsible-hdr" style="margin:10px 0 4px;cursor:pointer;user-select:none" onclick="toggleSection(\'fixedLocallyList\')">'
          + '▶ Fixed Locally (' + fixedRows.length + ')</div>';
        html += '<div id="fixedLocallyList" style="display:none">' + fixedRows.join('') + '</div>';
      // No active errors — fixed rows are stale report noise, suppress them
      }
    }

    if (flaggedRows.length) {
      html += '<div class="section-title collapsible-hdr" style="margin:10px 0 4px;cursor:pointer;user-select:none" onclick="toggleSection(\'flaggedList\')">'
        + '▶ Incorrectly Flagged (' + flaggedRows.length + ')</div>';
      html += '<div id="flaggedList" style="display:none">' + flaggedRows.join('') + '</div>';
    }

    if (!html) { html = '<span class="empty">No outstanding issues.</span>'; }
    return html;
  }

  function toggleSection(id) {
    const el = document.getElementById(id);
    if (!el) { return; }
    const hdr = el.previousElementSibling;
    const open = el.style.display === 'none';
    el.style.display = open ? 'block' : 'none';
    if (hdr) { hdr.textContent = hdr.textContent.replace(open ? '▶' : '▼', open ? '▼' : '▶'); }
  }

  function updatePipelineStep(iconId, statusId, history) {
    const iconEl = document.getElementById(iconId);
    const statusEl = document.getElementById(statusId);
    if (!history || history.length === 0) {
      iconEl.textContent = '○'; iconEl.className = 'pipeline-icon icon-neutral';
      statusEl.textContent = 'no builds yet'; return;
    }
    const latest = history[0];
    const result = latest.result || (latest.state === 'RUNNING' ? 'RUNNING' : 'UNKNOWN');
    const ago = formatAgo(latest.startTime);
    if (result === 'SUCCESS') {
      iconEl.textContent = '✓'; iconEl.className = 'pipeline-icon icon-success';
      statusEl.textContent = 'passed ' + ago;
    } else if (result === 'FAILURE' || result === 'UNSTABLE') {
      iconEl.textContent = '✗'; iconEl.className = 'pipeline-icon icon-failure';
      statusEl.textContent = 'failed ' + ago;
    } else if (result === 'RUNNING') {
      iconEl.textContent = '●'; iconEl.className = 'pipeline-icon icon-running';
      statusEl.textContent = 'running…';
    } else {
      iconEl.textContent = '○'; iconEl.className = 'pipeline-icon icon-neutral';
      statusEl.textContent = result.toLowerCase() + ' ' + ago;
    }
  }

  function escAttr(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  }

  // Delegated click handler for all .open-file elements (avoids inline onclick quote issues)
  document.addEventListener('click', function(e) {
    const el = e.target.closest('.open-file');
    if (!el) return;
    const filepath = el.dataset.file;
    const line = parseInt(el.dataset.line) || 0;
    if (filepath) vscode.postMessage({ command: 'openFile', filepath, line });
  });

  function appendLog(text, isError) {
    const el = document.getElementById('buildLog');
    const div = document.createElement('div');
    if (isError) div.className = 'log-error';
    div.textContent = text;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    try {
    switch (msg.type) {
      case 'showSetup':
        _tokenUrl = msg.tokenUrl || '';
        document.getElementById('tokenLink').textContent = msg.email
          ? msg.email + ' Jenkins profile'
          : 'Jenkins profile page';
        document.getElementById('setupIntro').textContent = (!msg.hasJenkins && !msg.hasAiKey)
          ? 'Enter your credentials below. At least one AI key (Claude or Anthropic) is required to use Apply Fixes.'
          : !msg.hasJenkins
            ? 'Jenkins API token is missing. Add it below to continue.'
            : 'An AI key is required to use Apply Fixes. Add a Claude or Anthropic key below.';
        document.getElementById('setupPanel').style.display = 'block';
        document.getElementById('mainPanel').style.display = 'none';
        document.getElementById(msg.hasJenkins ? 'claudeKeyInput' : 'tokenInput').focus();
        break;

      case 'hideSetup':
        document.getElementById('setupPanel').style.display = 'none';
        document.getElementById('mainPanel').style.display = 'block';
        document.getElementById('tokenInput').value = '';
        document.getElementById('claudeKeyInput').value = '';
        document.getElementById('openAiKeyInput').value = '';
        break;

      case 'loading':
        document.getElementById('refreshBtn').disabled = msg.loading;
        break;

      case 'banner': {
        const b = document.getElementById('bannerError');
        b.textContent = msg.text || '';
        b.style.display = msg.text ? 'block' : 'none';
        break;
      }

      case 'statusData':
        document.getElementById('repoInfo').textContent = (msg.repo || '?') + '  ·  ' + (msg.branch || '?');
        document.getElementById('buildHistory').innerHTML = renderHistory(msg.history, msg.queue);
        document.getElementById('prodHistory').innerHTML = renderHistory(msg.prodHistory, msg.prodQueue);
        document.getElementById('errorList').innerHTML = renderErrors(msg.summary);
        document.getElementById('prodErrorList').innerHTML = renderErrors(msg.prodSummary);
        // Update pipeline view
        document.getElementById('pipelineBranch').textContent = msg.branch || '—';
        updatePipelineStep('reviewBuildIcon', 'pipelineReviewStatus', msg.history);
        updatePipelineStep('prodBuildIcon', 'pipelineProdStatus', msg.prodHistory);
        break;

      case 'log':
        appendLog(msg.text, false);
        break;

      case 'error':
        appendLog(msg.text, true);
        break;

      case 'buildStarted':
        document.getElementById('progressWrap').style.display = 'block';
        document.getElementById('progressFill').style.width = '0%';
        // Update Status tab pipeline icon immediately
        document.getElementById('reviewBuildIcon').textContent = '●';
        document.getElementById('reviewBuildIcon').className = 'pipeline-icon icon-running';
        document.getElementById('pipelineReviewStatus').textContent = 'build #' + msg.buildNum + ' running…';
        document.getElementById('buildHistory').innerHTML =
          '<div class="build-row"><span class="build-num">#' + msg.buildNum + '</span>'
          + '<span class="badge badge-running">RUNNING</span></div>'
          + (document.getElementById('buildHistory').innerHTML || '');
        break;

      case 'buildProgress': {
        const pct = Math.min(99, Math.round((msg.elapsed / msg.estSecs) * 100));
        document.getElementById('progressFill').style.width = pct + '%';
        document.getElementById('etaRow').textContent = '#' + msg.buildNum + ' RUNNING  ' + msg.elapsed + 's elapsed  ' + msg.etaStr;
        document.getElementById('pipelineReviewStatus').textContent = 'build #' + msg.buildNum + ' running… ' + msg.etaStr;
        break;
      }

      case 'buildDone': {
        document.getElementById('progressFill').style.width = '100%';
        document.getElementById('etaRow').textContent = '#' + msg.buildNum + '  ' + msg.result;
        const success = msg.result === 'SUCCESS';
        document.getElementById('reviewBuildIcon').textContent = success ? '✓' : '✗';
        document.getElementById('reviewBuildIcon').className = 'pipeline-icon ' + (success ? 'icon-success' : 'icon-failure');
        document.getElementById('pipelineReviewStatus').textContent = 'build #' + msg.buildNum + ' ' + msg.result.toLowerCase();
        break;
      }

      case 'switchTab':
        switchTab(msg.tab);
        break;

      case 'repofixesData': {
        const activeCount = (msg.futureErrors?.filter(e => !e.alreadyFixed && !e.falsePositive).length || 0)
          + (msg.linkErrors?.filter(e => !e.alreadyFixed && !e.falsePositive).length || 0);
        _issueCount = activeCount;
        document.getElementById('tabOtherErrors').textContent = activeCount ? 'Other Errors (' + activeCount + ')' : 'Other Errors';
        document.getElementById('applyFixesBtn').style.display = activeCount ? '' : 'none';
        document.getElementById('repofixList').innerHTML = renderRepofixes(msg.futureErrors, msg.linkErrors);
        if (msg.reportTimestamp) { _reportTimestamp = msg.reportTimestamp; }
        document.getElementById('reportStatusCard').style.display = 'block';
        updateReportStatusCard();
        if (msg.isNew) {
          const banner = document.getElementById('reportNewBanner');
          banner.style.display = 'block';
          setTimeout(() => { banner.style.display = 'none'; }, 6000);
        }
        break;
      }

      case 'showOtherLog': {
        const st = document.getElementById('otherStatus');
        st.innerHTML = '';
        st.style.display = 'block';
        const fc = document.getElementById('fixCards');
        fc.innerHTML = '';
        fc.style.display = 'none';
        break;
      }

      case 'otherLog': {
        const el = document.getElementById('otherStatus');
        if (!el) break;
        el.style.display = 'block';
        const div = document.createElement('div');
        if (msg.isError) div.className = 'status-error';
        div.textContent = msg.text || '';
        el.appendChild(div);
        break;
      }

      case 'fixFilesStarting': {
        const fc = document.getElementById('fixCards');
        fc.innerHTML = '';
        fc.style.display = 'block';
        for (const file of (msg.files || [])) {
          const card = document.createElement('div');
          card.className = 'fix-card';
          card.id = 'fc-' + btoa(file).replace(/[^a-z0-9]/gi, '_');
          card.dataset.file = file;
          card.dataset.fixes = '0';
          card.dataset.notfound = '0';
          card.innerHTML =
            '<div class="fix-card-row">'
            + '<span class="fix-card-icon"><span class="fix-spinner"></span></span>'
            + '<span class="fix-card-file">' + escHtml(file) + '</span>'
            + '</div>';
          fc.appendChild(card);
        }
        break;
      }

      case 'actionResult': {
        const cardId = 'fc-' + btoa(msg.file || '').replace(/[^a-z0-9]/gi, '_');
        const card = document.getElementById(cardId);
        if (!card) break;
        if (msg.type === 'fix') {
          card.dataset.fixes = String(parseInt(card.dataset.fixes || '0') + 1);
        } else if (msg.type === 'notfound') {
          card.dataset.notfound = String(parseInt(card.dataset.notfound || '0') + 1);
          const detail = document.createElement('div');
          detail.className = 'fix-card-detail';
          detail.textContent = '✗ ' + (msg.find || '');
          card.appendChild(detail);
        }
        break;
      }

      case 'fixDone': {
        const changed = new Set(msg.changed || []);
        document.querySelectorAll('.fix-card').forEach(card => {
          const file = card.dataset.file || '';
          const fixes = parseInt(card.dataset.fixes || '0');
          const notfound = parseInt(card.dataset.notfound || '0');
          const row = card.querySelector('.fix-card-row');
          const iconEl = card.querySelector('.fix-card-icon');
          if (fixes > 0 && notfound === 0) {
            iconEl.textContent = '✓';
            iconEl.style.color = '#66bb6a';
            row.innerHTML = '<span class="fix-card-icon" style="color:#66bb6a">✓</span>'
              + '<span class="fix-card-file">' + escHtml(file) + '</span>'
              + '<span class="fix-card-badge fix-card-badge-fixed">' + fixes + ' fixed</span>';
          } else if (notfound > 0) {
            row.innerHTML = '<span class="fix-card-icon" style="color:#ef5350">✗</span>'
              + '<span class="fix-card-file">' + escHtml(file) + '</span>'
              + (fixes > 0 ? '<span class="fix-card-badge fix-card-badge-fixed">' + fixes + ' fixed</span>' : '')
              + '<span class="fix-card-badge fix-card-badge-fail">' + notfound + ' not found</span>';
          } else {
            row.innerHTML = '<span class="fix-card-icon" style="color:var(--vscode-descriptionForeground)">·</span>'
              + '<span class="fix-card-file" style="color:var(--vscode-descriptionForeground)">' + escHtml(file) + '</span>'
              + '<span class="fix-card-badge fix-card-badge-neutral">no changes</span>';
          }
        });
        break;
      }
    }
    } catch(e) {
      const b = document.getElementById('bannerError');
      if (b) { b.textContent = 'UI error (' + msg.type + '): ' + e.message; b.style.display = 'block'; }
    }
  });
