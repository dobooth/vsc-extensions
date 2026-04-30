import * as vscode from 'vscode';
import * as path from 'path';
import { buildConfig, getGhToken, GhecConfig } from '../services/ghec-config';
import {
  testConnectivity, getWorkflowRuns, getLastRuns, getRunErrors,
  pollRun, findRunBySha, getOpenPr, createPr, BuildError, BuildSummary,
  computeProposedFix,
} from '../services/ghec-service';
import {
  getStatus, pushCurrentBranch,
  applyPathFix, commitFixes, commitAndPush,
  delinkAtLine, getUncommittedFiles, applyLineFix,
} from '../services/git-service';
import { buildClaudeClient, loadRepairContext, ANTHROPIC_KEY_SECRET, OPENAI_KEY_SECRET } from '../services/claude-service';
import { runLocalLint } from '../services/local-lint-service';
import { output } from '../lib/common';

const VIEW_TYPE = 'adobeExl.ghecPanel';

export class GhecPanelProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _config: GhecConfig | null = null;
  private _cwd: string;
  private _buildRunning = false;
  private _dataLoaded = false;
  private _lastErrors: BuildError[] = [];
  private _lastRunId = 0;
  // Diagnostics collection — publishes CI/lint errors into VS Code's Problems
  // panel so any AI tool (Copilot, Claude Code, Cursor) can read and fix them.
  private readonly _diagnostics = vscode.languages.createDiagnosticCollection('exl-ci');

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    _context.subscriptions.push(this._diagnostics);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    const mediaUri = vscode.Uri.joinPath(this._context.extensionUri, 'media');
    const assetsUri = vscode.Uri.joinPath(this._context.extensionUri, 'assets');
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaUri, assetsUri] };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'refresh':         await this._handleRefresh(); break;
        case 'pushCheck':       await this._handlePushCheck(); break;
        case 'confirmPushCheck': await this._handleConfirmPushCheck(msg.uncommittedCount); break;
        case 'autoFix':         await this._handleAutoFix(); break;
        case 'applyFixes':      await this._handleApplyFixes(); break;
        case 'applyOneFix':     await this._handleApplyOneFix(msg.action, msg.filepath, msg.lineno, msg.candidate, msg.target); break;
        case 'commitAndPush':   await this._handleCommitAndPush(); break;
        case 'openFile':        await this._openFile(msg.filepath, msg.line); break;
        case 'openUrl':         vscode.env.openExternal(vscode.Uri.parse(msg.url)); break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) { this._handleRefresh(); }
    });

    this._handleRefresh();
  }

  // ── Message helpers ────────────────────────────────────────────────────────

  private _post(type: string, payload: unknown): void {
    this._view?.webview.postMessage({ type, ...payload as object });
  }

  private _log(text: string): void { this._post('log', { text }); }
  private _error(text: string): void { this._post('error', { text }); }
  private _setLoading(loading: boolean): void { this._post('loading', { loading }); }

  private _updateBadge(): void {
    if (!this._view || !this._dataLoaded) { return; }
    const count = this._lastErrors.filter((e: any) => e.active).length;
    this._view.title = count > 0 ? `Build Monitor (${count})` : 'Build Monitor';
    if (this._buildRunning && count === 0) {
      this._view.badge = { value: 1, tooltip: 'CI run in progress…' };
    } else if (count > 0) {
      const prefix = this._buildRunning ? 'Running · ' : '';
      this._view.badge = { value: count, tooltip: prefix + count + ' error(s) need attention' };
    } else {
      this._view.badge = undefined;
    }
  }

  // Publish active errors as VS Code diagnostics so any AI tool that reads the
  // Problems panel (Copilot Chat, Claude Code, Cursor, etc.) can see and fix them.
  private _publishDiagnostics(repoRoot: string): void {
    this._diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const err of this._lastErrors) {
      if (!err.active) { continue; }
      const absPath = path.join(repoRoot, err.filepath);
      const uri = vscode.Uri.file(absPath);
      const line = Math.max(0, parseInt(err.lineno) - 1);
      const range = new vscode.Range(line, 0, line, 999);
      const diag = new vscode.Diagnostic(
        range,
        `[${err.rule}] ${err.reason}`,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = err.source === 'local' ? 'exl-local' : 'exl-ci';
      diag.code = err.rule;
      const list = byFile.get(uri.toString()) ?? [];
      list.push(diag);
      byFile.set(uri.toString(), list);
    }
    for (const [uriStr, diags] of byFile) {
      this._diagnostics.set(vscode.Uri.parse(uriStr), diags);
    }
  }

  // ── Config / auth ──────────────────────────────────────────────────────────

  private async _loadConfig(): Promise<GhecConfig | null> {
    const token = getGhToken();
    if (!token) {
      output.appendLine('[GHEC] gh auth token returned nothing — run "gh auth login".');
      this._post('banner', { text: 'Logged out. Run "gh auth login" then click ↻.' });
      return null;
    }

    try {
      this._config = buildConfig(token, this._cwd);
    } catch (e: any) {
      output.appendLine(`[GHEC] buildConfig failed: ${e.message}`);
      this._post('banner', { text: e.message });
      return null;
    }
    output.appendLine(`[GHEC] Config: ${this._config.owner}/${this._config.repo}, branch=${this._config.currentBranch}`);
    return this._config;
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  private async _handleRefresh(): Promise<void> {
    this._setLoading(true);
    try {
      const cfg = await this._loadConfig();
      if (!cfg) { return; }

      const ok = await testConnectivity(cfg);
      if (!ok) {
        this._post('banner', { text: `Cannot reach ${cfg.apiBase} — check your network. Click ↻ to retry.` });
        return;
      }
      this._post('banner', { text: '' });

      const runs = await getWorkflowRuns(cfg, 5);

      const latestRun = runs[0] ?? null;
      const summary = latestRun?.result === 'FAILURE'
        ? await getRunErrors(cfg, Number(latestRun.id), cfg.repoRoot)
        : null;

      this._lastErrors = summary?.errors ?? [];
      this._lastRunId = latestRun ? Number(latestRun.id) : 0;
      this._dataLoaded = true;
      this._updateBadge();
      this._publishDiagnostics(cfg.repoRoot);

      const uncommittedFiles = getUncommittedFiles(cfg.repoRoot);

      // Run local markdownlint + cspell on uncommitted .md files
      const localErrors = uncommittedFiles.length > 0
        ? runLocalLint(cfg.repoRoot, this._context.extensionPath, uncommittedFiles)
        : [];

      // Compute proposed fixes for local errors (CI errors get fixes in parseLogErrors)
      for (const err of localErrors) {
        if (err.active && !err.proposedFix) {
          err.proposedFix = computeProposedFix(
            cfg.repoRoot, err.filepath, err.lineno, err.target,
            err.fixStatus, err.fixCandidates, err.rule, err.reason
          );
        }
      }

      // Merge local errors into summary so they appear in the same error list
      const mergedSummary = summary
        ? { ...summary, errors: [...localErrors, ...summary.errors] }
        : localErrors.length > 0
          ? { runId: 0, errors: localErrors, unparsed: [] }
          : null;

      this._post('statusData', {
        repo: `${cfg.owner}/${cfg.repo}`,
        branch: cfg.currentBranch,
        runs,
        summary: mergedSummary,
        uncommittedCount: uncommittedFiles.length,
      });
      output.appendLine(`[GHEC] statusData posted: runs=${runs.length}, errors=${this._lastErrors.length}, local=${localErrors.length}`);
    } catch (e: any) {
      output.appendLine(`[GHEC] Refresh error: ${e.message}`);
      this._post('banner', { text: `Refresh failed: ${e.message}` });
    } finally {
      this._setLoading(false);
    }
  }

  private async _handleConfirmPushCheck(uncommittedCount: number): Promise<void> {
    const label = uncommittedCount === 1 ? '1 uncommitted file' : `${uncommittedCount} uncommitted files`;
    const choice = await vscode.window.showWarningMessage(
      `You have ${label}. Commit before pushing?`,
      'Commit & Push', 'Push Anyway', 'Cancel'
    );
    if (choice === 'Commit & Push') {
      await this._handleCommitAndPush();
    } else if (choice === 'Push Anyway') {
      await this._handlePushCheck();
    }
  }

  private async _handlePushCheck(): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }

    this._post('switchTab', { tab: 'build' });

    let status;
    try {
      status = getStatus(this._cwd);
    } catch (e: any) {
      this._error(`Git error: ${e.message}`); return;
    }

    const uncommitted = getUncommittedFiles(cfg.repoRoot);
    if (uncommitted.length > 0) {
      const label = uncommitted.length === 1 ? '1 uncommitted file' : `${uncommitted.length} uncommitted files`;
      const choice = await vscode.window.showWarningMessage(
        `You have ${label}. Commit before pushing?`,
        'Commit & Push', 'Push Anyway', 'Cancel'
      );
      if (choice === 'Commit & Push') { await this._handleCommitAndPush(); return; }
      if (choice !== 'Push Anyway') { return; }
    }

    this._log(`Pushing ${status.branch} to origin…`);
    let sha: string;
    try {
      sha = pushCurrentBranch(this._cwd);
    } catch (e: any) {
      this._error(`Push failed: ${e.message}`); return;
    }
    this._log(`Pushed ${sha.slice(0, 7)}.`);

    // CI only runs on PR events — check for an open PR
    let pr = await getOpenPr(cfg, status.branch);
    if (!pr) {
      const choice = await vscode.window.showInformationMessage(
        `No open PR for "${status.branch}". Create one to trigger CI?`,
        'Create PR', 'Cancel'
      );
      if (choice !== 'Create PR') {
        this._log('No PR — CI will not run until a PR is opened.'); return;
      }
      const title = status.branch.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      pr = await createPr(cfg, status.branch, title);
      if (!pr) {
        this._error('Failed to create PR. Check permissions or create it manually on GitHub.'); return;
      }
      this._log(`PR #${pr.number} created.`);
      vscode.env.openExternal(vscode.Uri.parse(pr.url));
    } else {
      this._log(`Found PR #${pr.number}: ${pr.title}`);
    }

    this._log('Waiting for CI run to start…');
    await this._monitorBySha(cfg, sha);
  }


  private async _monitorBySha(cfg: GhecConfig, sha: string): Promise<void> {
    let runId: number | null = null;
    for (let i = 0; i < 18 && !runId; i++) {
      await sleep(10000);
      runId = await findRunBySha(cfg, sha);
    }
    if (!runId) {
      this._error('No CI run detected after 3 minutes. Check GitHub Actions manually.');
      return;
    }
    await this._monitorRunId(cfg, runId);
  }

  private async _monitorRunId(cfg: GhecConfig, runId: number): Promise<void> {
    this._log(`Run #${runId} started. Monitoring…`);
    this._post('buildStarted', { buildNum: runId });
    this._buildRunning = true;
    this._updateBadge();

    // Estimate duration from recent history
    const history = await getWorkflowRuns(cfg, 5);
    const completed = history.filter(r => r.result && r.result !== 'CANCELLED' && r.durationInMillis);
    const avgMs = completed.length
      ? completed.reduce((s, r) => s + r.durationInMillis!, 0) / completed.length
      : 120000;
    const estSecs = Math.round(avgMs / 1000);

    for (let i = 0; i < 120; i++) {
      await sleep(10000);
      const info = await pollRun(cfg, runId);
      const elapsed = Math.floor(Date.now() / 1000) - info.startedAt;
      const eta = Math.max(0, estSecs - elapsed);
      const etaStr = eta > 0 ? `ETA ~${Math.floor(eta / 60)}m ${eta % 60}s` : 'finishing…';

      this._post('buildProgress', { buildNum: runId, elapsed, estSecs, etaStr, building: info.inProgress });

      if (!info.inProgress) {
        const result = (info.conclusion ?? 'unknown').toUpperCase();
        this._log(`Run #${runId} ${result}`);
        this._post('buildDone', { buildNum: runId, result: result === 'SUCCESS' ? 'SUCCESS' : 'FAILURE' });
        this._buildRunning = false;
        this._updateBadge();
        await this._handleRefresh();
        return;
      }
    }
    this._buildRunning = false;
    this._updateBadge();
    this._error('Run timed out after 20 minutes.');
  }

  private async _handleAutoFix(): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }

    this._post('switchTab', { tab: 'build' });

    const MAX_ITER = 5;
    for (let iter = 1; iter <= MAX_ITER; iter++) {
      this._log(`\n── Auto-fix iteration ${iter}/${MAX_ITER} ──`);

      // On the first pass, work from already-loaded errors instead of triggering
      // a new build. Subsequent passes push and wait for fresh CI results.
      let summary: BuildSummary | null = null;
      if (iter === 1 && this._lastErrors.some(e => e.active)) {
        this._log('Using errors from last refresh…');
        summary = { runId: this._lastRunId, errors: this._lastErrors, unparsed: [] };
      } else {
        await this._handlePushCheck();

        const { lastFailed, lastSuccess } = await getLastRuns(cfg);
        if (!lastFailed || lastFailed <= lastSuccess) {
          this._log('CI passed — no errors to fix.');
          return;
        }

        summary = await getRunErrors(cfg, lastFailed, cfg.repoRoot);
        if (!summary) { this._error('Could not retrieve run errors.'); return; }
      }

      const fixable = summary.errors.filter(e =>
        e.active && (e.fixStatus === 'path-fix' || e.fixStatus === 'delink' || !!e.proposedFix)
      );
      if (fixable.length === 0) {
        if (summary.errors.filter(e => e.active).length > 0) {
          this._error('No auto-fixable errors remain. Manual action required.');
        } else {
          this._log('All errors resolved.');
        }
        return;
      }

      this._log(`Applying ${fixable.length} fix(es)…`);
      const fixed: string[] = [];
      const unfixable: string[] = [];

      for (const err of fixable) {
        const absFilePath = path.resolve(cfg.repoRoot, err.filepath);
        let applied = false;

        if (err.fixStatus === 'path-fix') {
          const candidate = err.fixCandidates?.[0];
          if (!candidate) { unfixable.push(`${err.filepath}:${err.lineno} (no candidate)`); continue; }
          applied = applyPathFix(absFilePath, parseInt(err.lineno), err.target, path.resolve(cfg.repoRoot, candidate));
          if (applied) { fixed.push(`${err.filepath}:${err.lineno} → ${candidate}`); }
        } else if (err.fixStatus === 'delink') {
          applied = delinkAtLine(absFilePath, parseInt(err.lineno), err.target);
          if (applied) { fixed.push(`${err.filepath}:${err.lineno} (de-linked)`); }
        } else if (err.proposedFix) {
          const fixLine = err.proposedFix.fixLine ?? parseInt(err.lineno);
          applied = applyLineFix(absFilePath, fixLine, err.proposedFix.before, err.proposedFix.after);
          if (applied) { fixed.push(`${err.filepath}:${err.lineno} (${err.rule})`); }
        }

        if (!applied) { unfixable.push(`${err.filepath}:${err.lineno} (pattern not matched)`); }
      }

      if (fixed.length === 0) {
        this._error('No fixes could be applied. Manual intervention needed.');
        return;
      }

      fixed.forEach(f => this._log(`  Fixed: ${f}`));
      if (unfixable.length) { unfixable.forEach(u => this._log(`  Skipped: ${u}`)); }

      const msg = `fix: correct broken references (attempt ${iter}) — ${fixed.length} fixed`;
      try {
        commitFixes(this._cwd, msg);
        this._log(`Committed: ${msg}`);
      } catch (e: any) {
        this._error(`Commit failed: ${e.message}`); return;
      }
    }

    this._error(`Could not fix CI after ${MAX_ITER} attempts. Manual intervention needed.`);
  }

  private async _handleApplyOneFix(
    action: string, filepath: string, lineno: number, candidate: string, target: string
  ): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }
    const absFile = path.join(cfg.repoRoot, filepath);
    try {
      let ok = false;
      let failReason = 'unknown';
      const err = this._lastErrors.find((e: BuildError) => e.filepath === filepath && e.lineno === String(lineno));

      if (action === 'path-fix' && candidate) {
        ok = applyPathFix(absFile, lineno, err?.target || target, path.join(cfg.repoRoot, candidate));
        if (!ok) { failReason = `path-fix regex did not match in ${filepath}:${lineno} for target "${err?.target || target}"`; }
      } else if (action === 'delink') {
        ok = delinkAtLine(absFile, lineno, target);
        if (!ok) { failReason = `delink regex did not match in ${filepath}:${lineno} for target "${target}"`; }
      } else if (action === 'markdown-fix') {
        if (!err) {
          failReason = `error not found in _lastErrors for ${filepath}:${lineno}`;
        } else if (!err.proposedFix) {
          failReason = `no proposedFix on error (rule=${err.rule})`;
        } else {
          const fixLine = err.proposedFix.fixLine ?? lineno;
          ok = applyLineFix(absFile, fixLine, err.proposedFix.before, err.proposedFix.after);
          if (!ok) { failReason = `line content mismatch at ${filepath}:${fixLine} — expected "${err.proposedFix.before}"`; }
        }
      } else {
        failReason = `unknown action "${action}"`;
      }

      if (ok) {
        if (err) { err.active = false; }
        this._updateBadge();
        this._post('fixApplied', { filepath, lineno });
      } else {
        output.appendLine(`[GHEC] applyOneFix failed: ${failReason}`);
        this._post('banner', { text: `Could not apply fix: ${failReason}` });
      }
    } catch (e: any) {
      this._post('banner', { text: `Fix error: ${e.message}` });
    }
  }

  private async _handleCommitAndPush(): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }
    try {
      const activeErrors = this._lastErrors.filter((e: any) => !e.active);
      const files = [...new Set(activeErrors.map((e: any) => e.filepath))];
      const msg = files.length === 1
        ? `fix: repair broken link in ${files[0]}`
        : `fix: repair ${activeErrors.length} broken link(s)`;
      commitAndPush(cfg.repoRoot, msg);
      this._post('commitDone', {});
      await this._handlePushCheck();
    } catch (e: any) {
      this._post('banner', { text: `Commit/push failed: ${e.message}` });
    }
  }

  private async _handleApplyFixes(): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }

    if (!this._lastErrors.length) {
      this._error('No errors loaded — refresh first.');
      return;
    }

    this._post('switchTab', { tab: 'build' });

    const claudeKey = await this._context.secrets.get(ANTHROPIC_KEY_SECRET);
    const openAiKey = await this._context.secrets.get(OPENAI_KEY_SECRET);
    const claude = buildClaudeClient(claudeKey, openAiKey);
    const aiLabel = claudeKey ? 'Claude (Anthropic)' : openAiKey ? 'OpenAI' : 'claude CLI';
    this._log(`Using ${aiLabel}`);

    const repairContext = loadRepairContext(this._context.extensionPath);

    const active = this._lastErrors.filter((e: any) => e.active);
    if (active.length === 0) {
      this._log('All errors already fixed locally.'); return;
    }

    // Group by file
    const byFile = new Map<string, { errors: any[]; lines: string[] }>();
    for (const e of active) {
      if (!e.filepath) { continue; }
      if (!byFile.has(e.filepath)) {
        const absFile = path.join(cfg.repoRoot, e.filepath.replace(/^\//, ''));
        let lines: string[];
        try { lines = require('fs').readFileSync(absFile, 'utf8').split('\n'); } catch {
          this._log(`  ⚠ Cannot read ${e.filepath} — skipped`);
          continue;
        }
        byFile.set(e.filepath, { errors: [], lines });
      }
      byFile.get(e.filepath)!.errors.push(e);
    }

    if (byFile.size === 0) {
      this._log('No readable files to fix.'); return;
    }

    const CONTEXT = 4;
    let filesSection = '';
    for (const [relFile, entry] of byFile) {
      const { lines } = entry;
      const windows: Array<{ lo: number; hi: number }> = [];
      for (const e of entry.errors) {
        const n = parseInt(e.lineno) - 1;
        if (!isNaN(n)) { windows.push({ lo: Math.max(0, n - CONTEXT), hi: Math.min(lines.length - 1, n + CONTEXT) }); }
      }

      let snippet: string;
      if (windows.length === 0) {
        snippet = lines.slice(0, 30).map((l: string, i: number) => `${i + 1}: ${l}`).join('\n');
      } else {
        windows.sort((a, b) => a.lo - b.lo);
        const merged: Array<{ lo: number; hi: number }> = [];
        for (const w of windows) {
          if (merged.length && w.lo <= merged[merged.length - 1].hi + 1) {
            merged[merged.length - 1].hi = Math.max(merged[merged.length - 1].hi, w.hi);
          } else { merged.push({ ...w }); }
        }
        snippet = merged.map(w =>
          lines.slice(w.lo, w.hi + 1).map((l: string, i: number) => `${w.lo + i + 1}: ${l}`).join('\n')
        ).join('\n…\n');
      }

      const errorSummary = entry.errors.map((e: any) =>
        `  line ${e.lineno}: ${e.rule} — ${e.reason}`
      ).join('\n');

      filesSection += `\n---\nFile: ${relFile}\nIssues:\n${errorSummary}\n\nRelevant lines:\n\`\`\`markdown\n${snippet}\n\`\`\`\n`;
    }

    const userPrompt =
      `Repository: ${cfg.owner}/${cfg.repo}\n` +
      `Markdownlint CI found issues in ${byFile.size} file(s). ` +
      `For each issue, output one NDJSON action per line including the "file" field:\n` +
      `{"action":"fix","file":"<repo-relative path>","find":"<exact text>","replace":"<replacement>"}\n` +
      `{"action":"skip","file":"<repo-relative path>","reason":"<why no fix>"}\n` +
      `{"action":"note","file":"<repo-relative path>","text":"<observation>"}\n\n` +
      `Rules:\n` +
      `- "find" must be the exact string as it appears in the file (no line-number prefix)\n` +
      `- AM046 (missing linked file): if the target filename is just misspelled or in a different folder, fix the path; otherwise remove the link keeping its text\n` +
      `- MD051 (broken anchor): fix the anchor to match an existing heading, or remove it\n` +
      `- Other rules: apply the minimal fix that resolves the markdownlint violation\n` +
      `- Do not change unrelated content — output only NDJSON lines, no prose\n` +
      filesSection;

    const systemPrompt = repairContext ||
      `You are an Adobe Experience League documentation repair tool. ` +
      `You fix markdownlint errors in EXL Markdown files. Output only NDJSON — one JSON object per line.`;

    const fileContents = new Map(Array.from(byFile.entries()).map(([k, v]) => [k, v.lines.join('\n')]));
    const fileChanged = new Set<string>();
    let lineBuffer = '';
    let rawResponse = '';
    let aiError: string | null = null;
    let firstChunk = true;
    let actionCount = 0;

    this._log(`Sending ${byFile.size} file(s) to AI…`);
    this._post('fixFilesStarting', { files: Array.from(byFile.keys()).map(f => f.replace(/^\//, '')) });

    const slowTimer = setTimeout(() => {
      if (firstChunk) { this._log('Still waiting for response…'); }
    }, 15000);

    try {
      await claude.query(systemPrompt, userPrompt, (chunk) => {
        if (firstChunk) { firstChunk = false; clearTimeout(slowTimer); this._log('Response streaming…'); }
        lineBuffer += chunk;
        rawResponse += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }
          try {
            const action = JSON.parse(trimmed);
            const file: string = action.file ?? '';
            if (!fileContents.has(file)) { continue; }
            let content = fileContents.get(file)!;
            actionCount++;

            if (action.action === 'fix' && action.find && action.replace !== undefined) {
              if (content.includes(action.find)) {
                content = content.split(action.find).join(action.replace);
                fileContents.set(file, content);
                fileChanged.add(file);
                this._post('actionResult', { file: file.replace(/^\//, ''), type: 'fix', find: action.find?.slice(0, 80) });
              } else {
                this._post('actionResult', { file: file.replace(/^\//, ''), type: 'notfound', find: action.find?.slice(0, 80) });
              }
            } else if (action.action === 'skip') {
              this._post('actionResult', { file: file.replace(/^\//, ''), type: 'skip', reason: action.reason });
            } else if (action.action === 'note') {
              this._post('actionResult', { file: file.replace(/^\//, ''), type: 'note', reason: action.text });
            }
          } catch { /* incomplete JSON */ }
        }
      });
    } catch (e: any) {
      aiError = e.message;
      this._error(`AI error: ${e.message}`);
    } finally {
      clearTimeout(slowTimer);
    }

    if (!aiError && actionCount === 0) {
      output.appendLine('[ApplyFixes] Raw AI response:\n' + rawResponse.slice(0, 2000));
      this._log('No actions returned — response may not be valid NDJSON.');
    }

    let totalChanged = 0, totalFailed = 0;
    for (const relFile of fileChanged) {
      const absFile = path.join(cfg.repoRoot, relFile.replace(/^\//, ''));
      const relCheck = path.relative(cfg.repoRoot, absFile);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        this._error(`Skipped unsafe path: ${relFile}`);
        totalFailed++;
        continue;
      }
      try {
        require('fs').writeFileSync(absFile, fileContents.get(relFile)!, 'utf8');
        totalChanged++;
      } catch (e: any) {
        this._error(`Write failed for ${relFile}: ${e.message}`);
        totalFailed++;
      }
    }

    this._post('fixDone', { changed: Array.from(fileChanged).map(f => f.replace(/^\//, '')) });
    const parts: string[] = [];
    if (totalChanged > 0) { parts.push(`${totalChanged} file(s) changed`); }
    if (totalFailed > 0) { parts.push(`${totalFailed} write error(s)`); }
    if (aiError) { parts.push('AI error — partial results only'); }
    this._log(parts.length ? parts.join(' · ') : 'No changes needed.');
    if (totalChanged > 0) { this._log('Review with git diff before committing.'); }
  }

  private async _openFile(filepath: string, line?: number): Promise<void> {
    const base = this._config?.repoRoot ?? this._cwd;
    const absPath = path.join(base, filepath.replace(/^\//, ''));
    try {
      const uri = vscode.Uri.file(absPath);
      const opts: vscode.TextDocumentShowOptions = line
        ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) }
        : {};
      await vscode.window.showTextDocument(uri, opts);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Could not open file: ${absPath}\n${e.message}`);
    }
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'panel.js')
    );
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${csp} 'unsafe-inline';">
<style>
  /* ── Design tokens ───────────────────────────────────────────────────────── */
  :root {
    --sp-size-50:       4px;
    --sp-size-100:      8px;
    --sp-size-150:      12px;
    --sp-size-200:      16px;
    --sp-font-size-75:  11px;
    --sp-radius-small:  3px;
    --sp-radius-medium: 5px;
    --sp-radius-pill:   100px;
    --sp-positive:      #2d9d78;
    --sp-positive-bg:   rgba(45,157,120,.28);
    --sp-negative:      #e34850;
    --sp-negative-bg:   rgba(227,72,80,.28);
    --sp-notice:        #e68619;
    --sp-notice-bg:     rgba(230,134,25,.28);
    --sp-info:          #2c85d5;
    --sp-info-bg:       rgba(44,133,213,.28);
    --sp-neutral-bg:    rgba(128,128,128,.18);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 8px;
    line-height: 1.5;
  }

  /* ── Header ──────────────────────────────────────────────────────────────── */
  .sp-header {
    display: flex;
    align-items: center;
    gap: var(--sp-size-100);
    padding-bottom: var(--sp-size-100);
    border-bottom: 1px solid var(--vscode-panel-border);
    border-top: 2px solid var(--sp-info);
    padding-top: var(--sp-size-100);
    margin-bottom: var(--sp-size-100);
  }
  .sp-header-info {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--sp-font-size-75);
    color: var(--vscode-foreground);
    font-weight: 600;
  }

  /* ── Spectrum ActionButton ───────────────────────────────────────────────── */
  .sp-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-size-50);
    height: 28px;
    padding: 0 var(--sp-size-150);
    font-size: var(--sp-font-size-75);
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
    border-radius: var(--sp-radius-medium);
    border: 1px solid transparent;
    white-space: nowrap;
    transition: background 100ms, border-color 100ms;
  }
  .sp-btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .sp-btn-primary:hover { background: var(--vscode-button-hoverBackground); border-color: var(--vscode-button-hoverBackground); }
  .sp-btn-secondary {
    background: transparent;
    color: var(--vscode-foreground);
    border-color: var(--vscode-button-secondaryBackground);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .sp-btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .sp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .sp-btn-icon {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: var(--sp-radius-small);
    color: var(--vscode-descriptionForeground);
    font-size: 15px;
  }
  .sp-btn-icon:hover { background: var(--sp-neutral-bg); color: var(--vscode-foreground); }

  /* ── Spectrum Tabs ───────────────────────────────────────────────────────── */
  .sp-tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: var(--sp-size-150);
    gap: 2px;
  }
  .sp-tab {
    all: unset;
    padding: var(--sp-size-100) var(--sp-size-150);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.02em;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 100ms, border-color 100ms;
  }
  .sp-tab:hover { color: var(--vscode-foreground); }
  .sp-tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* ── Spectrum Section heading ────────────────────────────────────────────── */
  .sp-section { margin-bottom: var(--sp-size-200); }
  .sp-section-heading {
    font-size: var(--sp-font-size-75);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-foreground);
    margin-bottom: var(--sp-size-50);
    padding: 0 0 var(--sp-size-50) var(--sp-size-100);
    border-bottom: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--sp-info);
  }

  /* ── Spectrum StatusLight + TableRow (run list) ──────────────────────────── */
  .sp-table-row {
    display: flex;
    align-items: center;
    gap: var(--sp-size-100);
    padding: 5px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
    font-size: var(--sp-font-size-75);
  }
  .sp-table-row:last-child { border-bottom: none; }
  .sp-status-light {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .sp-sl-positive { background: var(--sp-positive); box-shadow: 0 0 0 2px var(--sp-positive-bg); }
  .sp-sl-negative { background: var(--sp-negative); box-shadow: 0 0 0 2px var(--sp-negative-bg); }
  .sp-sl-notice   { background: var(--sp-notice);   box-shadow: 0 0 0 2px var(--sp-notice-bg); }
  .sp-sl-info     { background: var(--sp-info);     box-shadow: 0 0 0 2px var(--sp-info-bg); }
  .sp-sl-neutral  { background: var(--vscode-descriptionForeground); box-shadow: 0 0 0 2px var(--sp-neutral-bg); }
  @keyframes sp-sl-pulse {
    0%, 100% { opacity: 1; } 50% { opacity: 0.4; }
  }
  .sp-sl-running { background: var(--sp-info); animation: sp-sl-pulse 1.4s ease-in-out infinite; }
  .sp-row-label { font-weight: 600; color: var(--vscode-textLink-foreground); cursor: pointer; white-space: nowrap; font-size: var(--sp-font-size-75); }
  .sp-row-label:hover { text-decoration: underline; }
  .sp-row-meta { flex: 1; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-row-branch { font-size: 10px; color: var(--vscode-descriptionForeground); background: var(--sp-neutral-bg); padding: 1px 5px; border-radius: var(--sp-radius-pill); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Spectrum Tag / Badge ────────────────────────────────────────────────── */
  .sp-tag {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 6px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    border-radius: var(--sp-radius-pill);
    white-space: nowrap;
  }
  .sp-tag-positive { background: var(--sp-positive-bg); color: var(--sp-positive); }
  .sp-tag-negative { background: var(--sp-negative-bg); color: var(--sp-negative); }
  .sp-tag-notice   { background: var(--sp-notice-bg);   color: var(--sp-notice); }
  .sp-tag-info     { background: var(--sp-info-bg);     color: var(--sp-info); }
  .sp-tag-neutral  { background: var(--sp-neutral-bg);  color: var(--vscode-descriptionForeground); }

  /* ── Spectrum Banner (error) ─────────────────────────────────────────────── */
  .sp-banner {
    display: none;
    padding: 6px var(--sp-size-100);
    margin-bottom: var(--sp-size-100);
    border-radius: var(--sp-radius-small);
    font-size: var(--sp-font-size-75);
    border-left: 3px solid var(--sp-negative);
    background: var(--sp-negative-bg);
    color: var(--vscode-errorForeground);
  }

  /* ── Error card (Spectrum Card-inspired) ─────────────────────────────────── */
  .sp-error-card {
    padding: 6px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
    font-size: var(--sp-font-size-75);
  }
  .sp-error-card:last-child { border-bottom: none; }
  .sp-error-card.resolved { opacity: 0.45; }
  .sp-error-top { display: flex; align-items: baseline; gap: var(--sp-size-50); flex-wrap: wrap; }
  .sp-error-file {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-weight: 600;
  }
  .sp-error-file:hover { text-decoration: underline; }
  .sp-error-rule {
    font-family: var(--vscode-editor-font-family);
    font-size: 10px;
    background: var(--sp-neutral-bg);
    padding: 1px 5px;
    border-radius: var(--sp-radius-pill);
    color: var(--vscode-descriptionForeground);
  }
  .sp-error-msg {
    margin-top: 2px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
  }
  .sp-check { color: var(--sp-positive); font-size: 10px; }

  /* ── Spectrum Action group (build tab) ───────────────────────────────────── */
  .sp-action-group {
    display: flex;
    gap: var(--sp-size-50);
    flex-wrap: wrap;
    padding: var(--sp-size-100);
    background: var(--sp-neutral-bg);
    border-radius: var(--sp-radius-medium);
    margin-bottom: var(--sp-size-100);
  }
  .sp-action-desc {
    font-size: var(--sp-font-size-75);
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
    margin-bottom: var(--sp-size-50);
  }
  .sp-action-desc b { color: var(--vscode-foreground); }

  /* ── Pipeline step ───────────────────────────────────────────────────────── */
  .sp-pipeline-row { display: flex; align-items: flex-start; gap: var(--sp-size-100); padding: 4px 0; }
  .sp-pipeline-connector { display: flex; flex-direction: column; align-items: center; min-width: 18px; }
  .sp-pipeline-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
  .sp-pipeline-line { flex: 1; width: 1px; background: var(--vscode-panel-border); min-height: 12px; margin: 2px 0; }
  .sp-pipeline-label { font-weight: 700; font-size: var(--sp-font-size-75); margin-bottom: 1px; }
  .sp-pipeline-detail { font-size: var(--sp-font-size-75); color: var(--vscode-descriptionForeground); }

  /* ── Progress bar ────────────────────────────────────────────────────────── */
  .sp-progress-wrap { margin-bottom: var(--sp-size-50); }
  .sp-progress-label { font-size: var(--sp-font-size-75); color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .sp-progress-track { height: 3px; background: var(--vscode-panel-border); border-radius: 2px; overflow: hidden; }
  .sp-progress-fill { height: 100%; background: var(--sp-info); border-radius: 2px; transition: width 1s linear; }

  /* ── Log (Spectrum Code / Console style) ─────────────────────────────────── */
  .sp-log {
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    background: color-mix(in srgb, var(--vscode-editor-background) 80%, black 20%);
    color: var(--vscode-terminal-foreground, var(--vscode-editor-foreground));
    padding: var(--sp-size-100);
    height: 180px;
    overflow-y: auto;
    border-radius: var(--sp-radius-medium);
    border: 1px solid var(--vscode-panel-border);
    white-space: pre-wrap;
    word-break: break-all;
    margin-bottom: var(--sp-size-100);
  }
  .sp-log-error { color: var(--sp-negative); }
  .sp-log-section { color: var(--vscode-descriptionForeground); opacity: 0.7; }

  /* ── Fix result cards ────────────────────────────────────────────────────── */
  .sp-fix-card {
    display: flex;
    flex-direction: column;
    padding: 4px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
    font-size: var(--sp-font-size-75);
  }
  .sp-fix-card:last-child { border-bottom: none; }
  .sp-fix-row { display: flex; align-items: center; gap: var(--sp-size-50); }
  .sp-fix-icon { min-width: 14px; text-align: center; font-size: 11px; }
  .sp-fix-file { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-fix-detail { margin-top: 2px; padding-left: 18px; font-family: var(--vscode-editor-font-family); font-size: 10px; color: var(--sp-negative); word-break: break-all; }
  @keyframes sp-spin { to { transform: rotate(360deg); } }
  .sp-spinner { display: inline-block; width: 10px; height: 10px; border: 1.5px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: sp-spin 0.8s linear infinite; vertical-align: middle; }

  /* ── Setup form ──────────────────────────────────────────────────────────── */
  .sp-setup { padding: var(--sp-size-100) 0; }
  .sp-setup-intro {
    font-size: var(--sp-font-size-75);
    color: var(--vscode-descriptionForeground);
    margin-bottom: var(--sp-size-150);
    line-height: 1.6;
    padding: var(--sp-size-100);
    background: var(--sp-info-bg);
    border-radius: var(--sp-radius-small);
    border-left: 3px solid var(--sp-info);
  }
  .sp-field { margin-bottom: var(--sp-size-150); }
  .sp-label {
    display: block;
    font-size: var(--sp-font-size-75);
    font-weight: 700;
    margin-bottom: var(--sp-size-50);
    color: var(--vscode-foreground);
  }
  .sp-label-hint { font-weight: 400; color: var(--vscode-descriptionForeground); }
  .sp-hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: var(--sp-size-50); line-height: 1.4; }
  .sp-hint a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .sp-input {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    padding: 5px var(--sp-size-100);
    font-size: var(--sp-font-size-100);
    font-family: var(--vscode-editor-font-family);
    border-radius: var(--sp-radius-small);
    box-sizing: border-box;
    transition: border-color 100ms;
  }
  .sp-input:focus { outline: none; border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  .sp-setup-error { color: var(--sp-negative); font-size: var(--sp-font-size-75); margin-top: var(--sp-size-50); display: none; }

  /* ── Misc ────────────────────────────────────────────────────────────────── */
  .sp-empty { font-size: var(--sp-font-size-75); color: var(--vscode-descriptionForeground); padding: var(--sp-size-100) 0; font-style: italic; }
  .icon-success { color: var(--sp-positive); }
  .icon-failure { color: var(--sp-negative); }
  .icon-running { color: var(--sp-info); }
  .icon-neutral { color: var(--vscode-descriptionForeground); }
  /* Keep old class names used by panel.js helpers */
  .build-row { display: flex; align-items: center; gap: var(--sp-size-100); padding: 5px 0; font-size: var(--sp-font-size-75); border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent); }
  .build-num { font-weight: 600; min-width: 40px; font-size: var(--sp-font-size-75); color: var(--vscode-foreground); }
  .badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; font-size: 10px; font-weight: 700; border-radius: var(--sp-radius-pill); white-space: nowrap; }
  .badge-success { background: var(--sp-positive-bg); color: var(--sp-positive); }
  .badge-failure { background: var(--sp-negative-bg); color: var(--sp-negative); }
  .badge-running { background: var(--sp-info-bg); color: var(--sp-info); }
  .badge-aborted { background: var(--sp-neutral-bg); color: var(--vscode-descriptionForeground); }
  .badge-queued  { background: var(--sp-notice-bg); color: var(--sp-notice); }
  .build-meta { flex: 1; font-size: var(--sp-font-size-75); color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .build-link { color: var(--vscode-textLink-foreground); cursor: pointer; font-size: var(--sp-font-size-75); font-weight: 600; white-space: nowrap; }
  .build-link:hover { text-decoration: underline; }
  .open-file, .open-url { cursor: pointer; }
  .error-row {
    padding: 10px 12px;
    margin-bottom: 8px;
    border-radius: var(--sp-radius-medium);
    border-left: 3px solid var(--vscode-panel-border, var(--sp-negative));
    font-size: 12px;
    line-height: 1.5;
  }

  .error-file { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); cursor: pointer; font-weight: 700; font-size: 12px; }
  .error-file:hover { text-decoration: underline; }
  .error-rule { font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: 600; background: color-mix(in srgb, var(--sp-negative) 18%, transparent); color: var(--sp-negative); padding: 2px 7px; border-radius: var(--sp-radius-pill); }
  .error-reason { margin-top: 5px; font-size: 11px; color: var(--vscode-foreground); opacity: 0.9; line-height: 1.4; }
  .fix-badge { font-size: 11px; padding: 2px 8px; border-radius: var(--sp-radius-pill); margin-left: 6px; font-weight: 600; }
  .fix-path     { background: var(--sp-positive-bg); color: var(--sp-positive); }
  .fix-delink   { background: var(--sp-notice-bg);   color: var(--sp-notice); }
  .fix-ambiguous { background: var(--sp-info-bg); color: var(--sp-info); }
  .sp-banner-info { background: var(--sp-info-bg); color: var(--sp-info); }
  .commit-bar { display: flex; align-items: center; justify-content: space-between; margin-top: var(--sp-size-100); padding: 8px 12px; background: color-mix(in srgb, var(--sp-positive-bg) 70%, var(--vscode-editor-background) 30%); border-radius: var(--sp-radius-medium); font-size: 12px; color: var(--sp-positive); font-weight: 600; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-sm { height: 24px; padding: 0 10px; font-size: 11px; }
  .fix-action-btn { height: 22px; padding: 0 10px; font-size: 11px; font-weight: 600; border-radius: var(--sp-radius-pill); border: 1.5px solid currentColor; background: transparent; cursor: pointer; margin-left: 6px; white-space: nowrap; }
  .fix-action-btn:hover { opacity: 0.75; }
  .fix-action-btn:disabled { opacity: 0.35; cursor: default; }
  .fix-action-apply  { color: var(--sp-positive); }
  .fix-action-delink { color: var(--sp-notice); }
  .diff-pre { margin: 8px 0 0; padding: 8px 12px; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.7; background: color-mix(in srgb, var(--vscode-editor-background) 75%, black 25%); border-radius: var(--sp-radius-medium); border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent); overflow-x: auto; white-space: pre; }
  .diff-add { display: block; color: var(--sp-positive); background: color-mix(in srgb, var(--sp-positive) 15%, transparent); padding: 0 4px; margin: 0 -12px; }
  .diff-del { display: block; color: var(--sp-negative); background: color-mix(in srgb, var(--sp-negative) 15%, transparent); padding: 0 4px; margin: 0 -12px; }
  .diff-hdr { display: block; color: var(--sp-info); font-style: italic; opacity: 0.8; }
  .log-panel { font-family: var(--vscode-editor-font-family); font-size: 11px; background: color-mix(in srgb, var(--vscode-editor-background) 80%, black 20%); color: var(--vscode-terminal-foreground, var(--vscode-editor-foreground)); padding: var(--sp-size-100); height: 180px; overflow-y: auto; border-radius: var(--sp-radius-medium); border: 1px solid var(--vscode-panel-border); white-space: pre-wrap; word-break: break-all; margin-bottom: var(--sp-size-100); }
  .log-error { color: var(--sp-negative); }
  .fix-card { display: flex; flex-direction: column; padding: 4px 0; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent); font-size: var(--sp-font-size-75); }
  .fix-card:last-child { border-bottom: none; }
  .fix-card-row { display: flex; align-items: center; gap: var(--sp-size-50); }
  .fix-card-icon { min-width: 14px; text-align: center; }
  .fix-card-file { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fix-card-badge { font-size: 10px; padding: 1px 5px; border-radius: var(--sp-radius-pill); font-weight: 700; white-space: nowrap; }
  .fix-card-badge-fixed   { background: var(--sp-positive-bg); color: var(--sp-positive); }
  .fix-card-badge-fail    { background: var(--sp-negative-bg); color: var(--sp-negative); }
  .fix-card-badge-neutral { background: var(--sp-neutral-bg);  color: var(--vscode-descriptionForeground); }
  .fix-card-detail { margin-top: 3px; padding-left: 18px; font-family: var(--vscode-editor-font-family); font-size: 10px; color: var(--sp-negative); word-break: break-all; }
  @keyframes spin2 { to { transform: rotate(360deg); } }
  .fix-spinner { display: inline-block; width: 10px; height: 10px; border: 1.5px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin2 0.8s linear infinite; vertical-align: middle; }
  .pipeline-icon { font-size: 18px; min-width: 22px; text-align: center; line-height: 1.4; }
  .pipeline-body { flex: 1; }
  .pipeline-label { font-size: var(--sp-font-size-75); font-weight: 700; margin-bottom: 2px; }
  .pipeline-desc { font-size: var(--sp-font-size-75); color: var(--vscode-descriptionForeground); line-height: 1.4; margin-bottom: 2px; }
  .pipeline-desc b { color: var(--vscode-foreground); }
  .pipeline-step { display: flex; gap: var(--sp-size-100); align-items: flex-start; padding: 4px 0; }
  .pipeline-step-actions { background: var(--sp-neutral-bg); border-radius: var(--sp-radius-medium); padding: var(--sp-size-100); margin: var(--sp-size-50) 0; }
  .pipeline-arrow { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; padding: 1px 0 1px 9px; }
  .action-row { display: flex; gap: var(--sp-size-50); flex-wrap: wrap; margin: var(--sp-size-50) 0 var(--sp-size-100); }
  .btn { display: inline-flex; align-items: center; height: 26px; padding: 0 var(--sp-size-150); font-size: var(--sp-font-size-75); font-family: inherit; font-weight: 600; cursor: pointer; border-radius: var(--sp-radius-medium); border: 1px solid transparent; white-space: nowrap; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .eta-row { font-size: var(--sp-font-size-75); color: var(--vscode-descriptionForeground); margin: 4px 0; }
  .progress-bar { height: 3px; background: var(--vscode-panel-border); border-radius: 2px; margin: 4px 0; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--sp-info); transition: width 1s; }
  .empty { font-size: var(--sp-font-size-75); color: var(--vscode-descriptionForeground); padding: 4px 0; font-style: italic; }
  .section-title { font-size: var(--sp-font-size-75); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vscode-foreground); margin-bottom: var(--sp-size-50); padding-left: var(--sp-size-100); border-left: 3px solid var(--sp-info); }
</style>
</head>
<body>

<!-- ── Main UI ────────────────────────────────────────────────────────────── -->
<div id="mainPanel" style="display:block">

<div class="sp-header">
  <span class="sp-header-info" id="repoInfo">Loading…</span>
</div>

<div id="bannerError" class="sp-banner"></div>
<div id="bannerUncommitted" class="sp-banner sp-banner-info" style="display:none"></div>

<div class="sp-tabs">
  <button class="sp-tab active" data-tab="status" onclick="switchTab('status')">Status</button>
  <button class="sp-tab" data-tab="build" onclick="switchTab('build')">Build</button>
</div>

<!-- ── Status Tab ─────────────────────────────────────────────────────────── -->
<div class="tab-panel active" id="tab-status">
  <div class="sp-section">
    <div class="sp-section-heading">Recent runs</div>
    <div id="buildHistory"><span class="sp-empty">Loading…</span></div>
  </div>
</div>

<!-- ── Build Tab ──────────────────────────────────────────────────────────── -->
<div class="tab-panel" id="tab-build">

  <div class="pipeline-step" style="margin-bottom:4px">
    <div class="pipeline-icon">⎇</div>
    <div class="pipeline-body">
      <div class="pipeline-label">Branch</div>
      <div class="pipeline-desc" id="pipelineBranch">—</div>
    </div>
  </div>

  <div class="pipeline-step-actions">
    <div class="action-row">
      <button class="btn" onclick="pushCheck()">⬆ Push &amp; Check</button>
      <button class="btn btn-secondary" onclick="autoFix()">⚙ Auto Fix</button>
    </div>
    <div class="pipeline-desc"><b>Push &amp; Check</b> — push branch, monitor CI run, show errors.</div>
    <div class="pipeline-desc"><b>Auto Fix</b> — iterate: push → AI fix → commit until green.</div>
  </div>

  <div class="pipeline-step" style="margin-bottom:4px">
    <div class="pipeline-icon" id="reviewBuildIcon">○</div>
    <div class="pipeline-body">
      <div class="pipeline-label">validate-articles</div>
      <div class="pipeline-desc" id="pipelineReviewStatus">—</div>
    </div>
  </div>

  <div id="progressWrap" style="display:none;margin-bottom:6px">
    <div class="eta-row" id="etaRow"></div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
  </div>

  <div class="log-panel" id="buildLog"></div>

  <div id="fixCards" style="display:none;margin-top:8px"></div>
</div>

<!-- ── Errors (always visible) ───────────────────────────────────────────── -->
<div class="sp-section" id="errorsSection">
  <div class="sp-section-heading" id="errorsHeading">Errors</div>
  <div id="errorList"><span class="sp-empty">No errors.</span></div>
  <div id="commitBar" class="commit-bar" style="display:none">
    <span id="commitBarLabel">0 fix(es) ready</span>
    <button class="btn btn-primary btn-sm" onclick="commitAndPush()">Commit &amp; push ↑</button>
  </div>
</div>

</div><!-- /mainPanel -->
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
