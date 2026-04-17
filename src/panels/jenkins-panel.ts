import * as vscode from 'vscode';
import * as path from 'path';
import { buildConfig, SECRETS_KEY, JenkinsConfig } from '../services/jenkins-config';
import {
  testConnectivity, getBuildHistory, getQueueItem, getLastBuildNums,
  getBuildSummary, getRepofixesData, pollBuildByNumber, findBuildBySha,
} from '../services/jenkins-service';
import {
  getStatus, fetchReview, mergeIntoPushBranch, pushToReview,
  applyPathFix, commitFixes,
} from '../services/git-service';
import { buildClaudeClient, loadRepairContext, ANTHROPIC_KEY_SECRET, OPENAI_KEY_SECRET } from '../services/claude-service';
import { output } from '../lib/common';

const VIEW_TYPE = 'adobeExl.jenkinsPanel';

export class JenkinsPanelProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _config: JenkinsConfig | null = null;
  private _cwd: string;
  private _lastRepofixes: { futureErrors: any[]; linkErrors: any[]; reportTimestamp: number | null } | null = null;
  private _repoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _buildRunning = false;
  private _otherIssueCount = 0;
  private _dataLoaded = false;

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    const mediaUri = vscode.Uri.joinPath(this._context.extensionUri, 'media');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaUri],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'refresh': output.appendLine('[Jenkins] Refresh command received'); await this._handleRefresh(); break;
        case 'mergePush': await this._handleMergePush(); break;
        case 'autoFix': await this._handleAutoFix(); break;
        case 'repofixes': await this._handleRepofixes(); break;
        case 'openFile': await this._openFile(msg.filepath, msg.line); break;
        case 'openUrl': vscode.env.openExternal(vscode.Uri.parse(msg.url)); break;
        case 'applyFixes': await this._handleApplyFixes(); break;
        case 'saveCredentials': await this.saveCredentials(msg.token, msg.claudeKey, msg.openAiKey); break;
      }
    });

    // Refresh whenever the panel becomes visible (e.g. switching back to the Activity Bar icon)
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._handleRefresh();
      }
    });

    // Auto-refresh on open
    this._handleRefresh();
  }

  // ── Message helpers ────────────────────────────────────────────────────────

  private _post(type: string, payload: unknown): void {
    this._view?.webview.postMessage({ type, ...payload as object });
  }

  private _log(text: string): void {
    this._post('log', { text });
  }

  private _error(text: string): void {
    this._post('error', { text });
  }

  private _setLoading(loading: boolean): void {
    this._post('loading', { loading });
  }

  private _otherLog(text: string): void {
    this._post('otherLog', { text, isError: false });
  }

  private _otherError(text: string): void {
    this._post('otherLog', { text, isError: true });
  }

  private _actionResult(file: string, type: 'fix' | 'notfound' | 'skip' | 'note', find?: string, reason?: string): void {
    this._post('actionResult', { file: file.replace(/^\//, ''), type, find: find?.slice(0, 80), reason });
  }

  private _updateBadge(): void {
    if (!this._view || !this._dataLoaded) { return; }
    const count = this._otherIssueCount;
    this._view.title = count > 0 ? `Build Monitor (${count})` : 'Build Monitor';
    if (this._buildRunning && count === 0) {
      this._view.badge = { value: 1, tooltip: 'Build running…' };
    } else if (count > 0) {
      const prefix = this._buildRunning ? 'Build running · ' : '';
      this._view.badge = { value: count, tooltip: prefix + count + ' link issues need attention' };
    } else {
      this._view.badge = undefined;
    }
  }

  // ── Config / workspace ────────────────────────────────────────────────────

  private async _loadConfig(): Promise<JenkinsConfig | null> {
    const rawAuth = await this._context.secrets.get(SECRETS_KEY);
    const claudeKey = await this._context.secrets.get(ANTHROPIC_KEY_SECRET);
    const openAiKey = await this._context.secrets.get(OPENAI_KEY_SECRET);
    if (!rawAuth) {
      const email = this._getGitEmail();
      const tokenUrl = email
        ? `https://docs.ci.corp.adobe.com/user/${email}/configure`
        : 'https://docs.ci.corp.adobe.com';
      output.appendLine('[Jenkins] Jenkins token missing — showing setup prompt.');
      this._post('showSetup', { email, tokenUrl, hasJenkins: false, hasAiKey: !!(claudeKey || openAiKey) });
      return null;
    }
    this._config = buildConfig(rawAuth, this._cwd);
    if (!this._config) {
      output.appendLine(`[Jenkins] buildConfig returned null for cwd: ${this._cwd}`);
      this._post('banner', { text: 'Not an EXL git repo — open an EXL documentation workspace.' });
      return null;
    }
    output.appendLine(`[Jenkins] Config: repo=${this._config.repoSlug}, job=${this._config.jobName}, root=${this._config.repoRoot}`);
    return this._config;
  }

  public async saveCredentials(token: string, claudeKey?: string, openAiKey?: string): Promise<void> {
    const email = this._getGitEmail();
    const rawAuth = email ? `${email}:${token}` : token;
    await this._context.secrets.store(SECRETS_KEY, rawAuth);
    if (claudeKey) { await this._context.secrets.store(ANTHROPIC_KEY_SECRET, claudeKey); }
    if (openAiKey) { await this._context.secrets.store(OPENAI_KEY_SECRET, openAiKey); }
    this._post('hideSetup', {});
    await this._handleRefresh();
  }

  private _getGitEmail(): string | null {
    try {
      const { execSync } = require('child_process');
      return execSync('git config user.email', { encoding: 'utf8' }).trim() || null;
    } catch {
      return null;
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  private async _handleRefresh(): Promise<void> {
    this._setLoading(true);
    try {
      const cfg = await this._loadConfig();
      if (!cfg) { return; }

      const ok = await testConnectivity(cfg);
      if (!ok) {
        output.appendLine(`[Jenkins] Connectivity test failed for ${cfg.baseUrl}`);
        this._post('banner', { text: 'Cannot reach Jenkins — check VPN and credentials. Click ↻ to retry.' });
        return;
      }
      output.appendLine(`[Jenkins] Connected to ${cfg.baseUrl}`);
      this._post('banner', { text: '' });

      const prodCfg = { ...cfg, jobName: cfg.prodJobName };
      const [history, queue, buildNums, prodHistory, prodQueue, prodBuildNums, repofixes] = await Promise.all([
        getBuildHistory(cfg),
        getQueueItem(cfg),
        getLastBuildNums(cfg),
        getBuildHistory(prodCfg),
        getQueueItem(prodCfg),
        getLastBuildNums(prodCfg),
        getRepofixesData(cfg),
      ]);

      const [summary, prodSummary] = await Promise.all([
        buildNums.lastFailed ? getBuildSummary(cfg, buildNums.lastFailed, cfg.repoRoot) : Promise.resolve(null),
        prodBuildNums.lastFailed ? getBuildSummary(prodCfg, prodBuildNums.lastFailed, cfg.repoRoot) : Promise.resolve(null),
      ]);

      this._lastRepofixes = repofixes;
      this._annotateRepofixes(repofixes, cfg.repoRoot);
      this._scheduleRepoRefresh(repofixes.reportTimestamp);
      this._otherIssueCount = repofixes.linkErrors.filter((e: any) => !e.alreadyFixed && !e.falsePositive).length
        + repofixes.futureErrors.filter((e: any) => !e.alreadyFixed && !e.falsePositive).length;
      this._dataLoaded = true;
      this._updateBadge();

      this._post('statusData', {
        repo: cfg.repoSlug,
        branch: cfg.currentBranch,
        history,
        queue,
        lastFailed: buildNums.lastFailed,
        lastSuccess: buildNums.lastSuccess,
        summary,
        prodHistory,
        prodQueue,
        prodSummary,
      });
      output.appendLine(`[Jenkins] statusData posted: history=${history.length}, prodHistory=${prodHistory.length}`);
      this._post('repofixesData', repofixes);
      output.appendLine(`[Jenkins] repofixesData posted: future=${repofixes.futureErrors.length}, link=${repofixes.linkErrors.length}`);
    } catch (e: any) {
      output.appendLine(`[Jenkins] Refresh error: ${e.message}`);
      this._post('banner', { text: `Refresh failed: ${e.message}` });
    } finally {
      this._setLoading(false);
    }
  }

  private async _handleMergePush(): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }

    this._post('switchTab', { tab: 'build' });

    // Pre-flight checks
    let status;
    try {
      status = getStatus(this._cwd);
    } catch (e: any) {
      this._error(`Git error: ${e.message}`); return;
    }

    if (!status.clean) {
      this._error('Working tree is not clean. Commit or stash changes first.'); return;
    }
    if (status.branch === 'review') {
      this._error('Switch to your feature branch first — not on review.'); return;
    }

    this._log(`Fetching origin/review...`);
    try { fetchReview(this._cwd); } catch (e: any) { this._error(`Fetch failed: ${e.message}`); return; }

    // Record pre-push build number for fallback detection
    const { lastFailed, lastSuccess } = await getLastBuildNums(cfg);
    const before = Math.max(lastFailed, lastSuccess);

    this._log(`Merging ${status.branch} into _jenkins_push...`);
    let sha: string;
    try {
      sha = mergeIntoPushBranch(this._cwd, status.branch);
    } catch (e: any) { this._error(e.message); return; }

    this._log(`Pushing to review...`);
    try {
      pushToReview(this._cwd, status.branch);
    } catch (e: any) { this._error(e.message); return; }

    this._log(`Pushed ${sha.slice(0, 7)}. Waiting for build to start...`);
    await this._monitorBuild(cfg, sha, before);
  }

  private async _monitorBuild(cfg: JenkinsConfig, sha: string, before: number): Promise<void> {
    // Poll for new build (SHA-based, up to 3 min)
    let buildNum: number | null = null;
    for (let i = 0; i < 18 && !buildNum; i++) {
      await sleep(10000);
      buildNum = await findBuildBySha(cfg, sha, before);
    }

    if (!buildNum) {
      this._error('No new build detected after 3 minutes. Check Jenkins manually.');
      return;
    }

    this._log(`Build #${buildNum} started. Monitoring...`);
    this._post('buildStarted', { buildNum });
    this._buildRunning = true;
    this._updateBadge();

    // Get ETA estimate from history
    const history = await getBuildHistory(cfg);
    const completedRuns = history.filter(r => r.result && r.result !== 'ABORTED' && r.durationInMillis);
    const avgMs = completedRuns.length
      ? completedRuns.reduce((s, r) => s + r.durationInMillis!, 0) / completedRuns.length
      : 480000;
    const estSecs = Math.round(avgMs / 1000);

    // Poll until done (up to 20 min)
    for (let i = 0; i < 120; i++) {
      await sleep(10000);
      const info = await pollBuildByNumber(cfg, buildNum);
      const elapsed = Math.floor(Date.now() / 1000) - info.timestamp;
      const eta = Math.max(0, estSecs - elapsed);
      const etaStr = eta > 0 ? `ETA ~${Math.floor(eta / 60)}m ${eta % 60}s` : 'finishing...';

      this._post('buildProgress', { buildNum, elapsed, estSecs, etaStr, building: info.building });

      if (!info.building) {
        const result = info.result ?? 'UNKNOWN';
        this._log(`Build #${buildNum} ${result}`);
        this._post('buildDone', { buildNum, result });
        this._buildRunning = false;
        this._updateBadge();
        // Refresh status panel
        await this._handleRefresh();
        return;
      }
    }
    this._buildRunning = false;
    this._updateBadge();
    this._error('Build timed out after 20 minutes.');
  }

  private async _handleAutoFix(): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }

    this._post('switchTab', { tab: 'build' });

    const MAX_ITER = 5;
    for (let iter = 1; iter <= MAX_ITER; iter++) {
      this._log(`\n── Auto-fix iteration ${iter}/${MAX_ITER} ──`);

      // Run merge + push + monitor
      await this._handleMergePush();

      // Get latest errors
      const { lastFailed, lastSuccess } = await getLastBuildNums(cfg);
      if (!lastFailed || lastFailed <= lastSuccess) {
        this._log('Build passed — no errors to fix.');
        return;
      }

      const summary = await getBuildSummary(cfg, lastFailed, cfg.repoRoot);
      if (!summary) { this._error('Could not retrieve build summary.'); return; }

      const active = summary.errors.filter(e => e.active && e.fixStatus === 'path-fix');
      if (active.length === 0) {
        if (summary.errors.filter(e => e.active).length > 0) {
          this._error('No auto-fixable errors remain. Manual action required.');
        } else {
          this._log('All errors resolved.');
        }
        return;
      }

      this._log(`Applying ${active.length} path fix(es)...`);
      const fixed: string[] = [];
      const unfixable: string[] = [];

      for (const err of active) {
        const candidate = err.fixCandidates?.[0];
        if (!candidate) { unfixable.push(`${err.filepath}:${err.lineno}`); continue; }
        const absPath = path.resolve(cfg.repoRoot, candidate);
        const applied = applyPathFix(
          path.resolve(cfg.repoRoot, err.filepath),
          parseInt(err.lineno),
          err.target,
          absPath
        );
        if (applied) {
          fixed.push(`${err.filepath}:${err.lineno} → ${candidate}`);
        } else {
          unfixable.push(`${err.filepath}:${err.lineno} (pattern not matched)`);
        }
      }

      if (fixed.length === 0) {
        this._error('No fixes could be applied. Manual intervention needed.');
        return;
      }

      fixed.forEach(f => this._log(`  Fixed: ${f}`));
      if (unfixable.length) { unfixable.forEach(u => this._log(`  Skipped: ${u}`)); }

      const msg = `fix: correct broken link paths (${cfg.repoSlug}, attempt ${iter}) — ${fixed.length} fixed${unfixable.length ? `, ${unfixable.length} need manual fix` : ''}`;
      try {
        commitFixes(this._cwd, msg);
        this._log(`Committed: ${msg}`);
      } catch (e: any) {
        this._error(`Commit failed: ${e.message}`); return;
      }
    }

    this._error(`Could not fix build after ${MAX_ITER} attempts. Manual intervention needed.`);
  }

  private _annotateRepofixes(repofixes: { futureErrors: any[]; linkErrors: any[]; reportTimestamp?: number | null }, repoRoot: string): void {
    const fileCache = new Map<string, string>();
    const read = (file: string): string => {
      if (!fileCache.has(file)) {
        const abs = path.join(repoRoot, file.replace(/^\//, ''));
        try { fileCache.set(file, require('fs').readFileSync(abs, 'utf8')); } catch { fileCache.set(file, ''); }
      }
      return fileCache.get(file)!;
    };

    const GATEWAY_DOMAINS = new Set(['developer.apple.com', 'docs.microsoft.com', 'learn.microsoft.com', 'linkedin.com']);

    const urlPresent = (content: string, url: string) => {
      // Match url only when followed by a link terminator, not more URL chars like # or /
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(escaped + '[)"\'\\s]').test(content);
    };
    for (const e of repofixes.linkErrors) {
      if (e.url) {
        try {
          const host = new URL(e.url).hostname;
          if (GATEWAY_DOMAINS.has(host)) { e.falsePositive = true; continue; }
        } catch { /* invalid URL — fall through */ }
        e.alreadyFixed = !urlPresent(read(e.file), e.url);
      }
    }
    for (const e of repofixes.futureErrors) {
      const urlMatch = e.description?.match(/https?:\/\/\S+/);
      const needle = urlMatch?.[0];
      if (needle) { e.alreadyFixed = !urlPresent(read(e.file), needle); }
    }
  }

  private async _handleRepofixes(silent = false): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }

    if (!silent) {
      this._post('switchTab', { tab: 'othererrors' });
    }

    const { futureErrors, linkErrors, reportTimestamp } = await getRepofixesData(cfg);
    const prevTimestamp = this._lastRepofixes?.reportTimestamp ?? null;
    this._lastRepofixes = { futureErrors, linkErrors, reportTimestamp };
    this._annotateRepofixes(this._lastRepofixes, cfg.repoRoot);
    this._otherIssueCount = linkErrors.filter((e: any) => !e.alreadyFixed && !e.falsePositive).length
      + futureErrors.filter((e: any) => !e.alreadyFixed && !e.falsePositive).length;
    this._updateBadge();
    this._post('repofixesData', { futureErrors, linkErrors, reportTimestamp, isNew: !!(reportTimestamp && prevTimestamp && reportTimestamp > prevTimestamp) });
    this._scheduleRepoRefresh(reportTimestamp);
  }

  /** Schedule a silent re-fetch ~10 min after the next expected 4-hour report tick. */
  private _scheduleRepoRefresh(reportTimestamp: number | null): void {
    if (this._repoRefreshTimer) { clearTimeout(this._repoRefreshTimer); this._repoRefreshTimer = null; }
    if (!reportTimestamp) { return; }

    const INTERVAL_MS = 4 * 60 * 60 * 1000;
    const BUILD_BUFFER_MS = 10 * 60 * 1000; // 10 min for build to finish
    const ageMs = Date.now() - reportTimestamp;
    const msUntilNext = INTERVAL_MS - (ageMs % INTERVAL_MS) + BUILD_BUFFER_MS;

    this._repoRefreshTimer = setTimeout(async () => {
      this._repoRefreshTimer = null;
      await this._handleRepofixes(true);
    }, msUntilNext);
  }

  private async _handleApplyFixes(): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }
    if (!this._lastRepofixes) {
      this._otherError('Fetch errors first before applying fixes.');
      return;
    }

    this._post('showOtherLog', {});

    // Git preflight
    let status;
    try { status = getStatus(this._cwd); } catch (e: any) {
      this._otherError(`Git error: ${e.message}`); return;
    }
    if (status.branch === 'review') {
      this._otherError('Cannot apply fixes on review. Switch to a feature branch first.'); return;
    }
    if (!status.clean) {
      this._otherLog('Note: working tree has uncommitted changes — fixes will be added on top.');
    }


    // ── AI client — prefer Claude (Anthropic), fall back to OpenAI ──────
    const claudeKey = await this._context.secrets.get(ANTHROPIC_KEY_SECRET);
    const openAiKey = await this._context.secrets.get(OPENAI_KEY_SECRET);
    const claude = buildClaudeClient(claudeKey, openAiKey);
    const aiLabel = claudeKey ? 'Claude (Anthropic) API' : openAiKey ? 'OpenAI API (claude CLI fallback)' : 'claude CLI';
    this._otherLog(`Using ${aiLabel}`);

    const repairContext = loadRepairContext(this._context.extensionPath);

    const { futureErrors, linkErrors } = this._lastRepofixes;

    // ── Group all errors by file and read file contents ───────────────────
    const byFile = new Map<string, { linkErrors: any[]; futureErrors: any[]; lines: string[] }>();

    for (const e of [...linkErrors, ...futureErrors]) {
      if (!e.file) { continue; }
      if (!byFile.has(e.file)) {
        const absFile = path.join(cfg.repoRoot, e.file.replace(/^\//, ''));
        let lines: string[];
        try { lines = require('fs').readFileSync(absFile, 'utf8').split('\n'); } catch {
          this._otherLog(`  ⚠ Cannot read ${e.file} — skipped`);
          continue;
        }
        byFile.set(e.file, { linkErrors: [], futureErrors: [], lines });
      }
      const entry = byFile.get(e.file)!;
      const fileText = entry.lines.join('\n');

      if (linkErrors.includes(e)) {
        if (e.url && !fileText.includes(e.url)) {
          // already fixed — shown in list with Fixed Locally badge
        } else {
          entry.linkErrors.push(e);
        }
      } else {
        const urlMatch = e.description?.match(/https?:\/\/\S+/);
        const needle = urlMatch?.[0];
        if (needle && !fileText.includes(needle)) {
          // already fixed — shown in list with Fixed Locally badge
        } else {
          entry.futureErrors.push(e);
        }
      }
    }

    // Remove files that have no remaining errors after local pre-check
    for (const [file, entry] of byFile) {
      if (entry.linkErrors.length === 0 && entry.futureErrors.length === 0) {
        byFile.delete(file);
      }
    }

    if (byFile.size === 0) {
      this._otherLog('All errors already fixed locally — nothing to send to AI.');
      return;
    }

    // ── Programmatic pre-pass: trailing slash and #operation/ fixes ───────────
    const fileContentsEarly = new Map(Array.from(byFile.entries()).map(([k, v]) => [k, v.lines.join('\n')]));
    const fileChangedEarly = new Set<string>();
    for (const [relFile, entry] of byFile) {
      let content = fileContentsEarly.get(relFile)!;
      const toRemove: any[] = [];
      for (const e of entry.linkErrors) {
        if (!e.url) { continue; }
        const url: string = e.url;
        // Trailing slash removal
        if (url.endsWith('/') && content.includes(url)) {
          const fixed = url.slice(0, -1);
          content = content.split(url).join(fixed);
          fileContentsEarly.set(relFile, content);
          fileChangedEarly.add(relFile);
          this._actionResult(relFile, 'fix', url);
          toRemove.push(e);
        // Old Redocly #operation/ → #
        } else if (url.includes('#operation/') && content.includes(url)) {
          const fixed = url.replace(/#operation\/.*$/, '#');
          content = content.split(url).join(fixed);
          fileContentsEarly.set(relFile, content);
          fileChangedEarly.add(relFile);
          this._actionResult(relFile, 'fix', url);
          toRemove.push(e);
        }
      }
      for (const e of toRemove) {
        entry.linkErrors.splice(entry.linkErrors.indexOf(e), 1);
      }
    }
    // Write early fixes now
    for (const relFile of fileChangedEarly) {
      const absFile = path.join(cfg.repoRoot, relFile.replace(/^\//, ''));
      try {
        require('fs').writeFileSync(absFile, fileContentsEarly.get(relFile)!, 'utf8');
      } catch (e: any) {
        this._otherError(`Write failed for ${relFile}: ${e.message}`);
      }
    }
    if (fileChangedEarly.size > 0) {
      this._otherLog(`Auto-fixed ${fileChangedEarly.size} file(s) (trailing slash / #operation/).`);
    }

    // Remove files that no longer have any errors after programmatic pass
    for (const [file, entry] of byFile) {
      if (entry.linkErrors.length === 0 && entry.futureErrors.length === 0) {
        byFile.delete(file);
      }
    }

    if (byFile.size === 0) {
      this._post('fixDone', { changed: Array.from(fileChangedEarly).map(f => f.replace(/^\//, '')) });
      this._otherLog('All errors resolved without AI.');
      if (fileChangedEarly.size > 0) { this._otherLog('Review with git diff before committing.'); }
      return;
    }

    // ── Build prompt — send only relevant line windows, not full files ─────
    const CONTEXT = 4; // lines of context around each error
    let filesSection = '';
    for (const [relFile, entry] of byFile) {
      const { lines } = entry;

      // Collect line windows for each error that has a line number
      const windows: Array<{ lo: number; hi: number }> = [];
      for (const e of entry.linkErrors) {
        const n = parseInt(e.line) - 1; // 0-based
        if (!isNaN(n)) { windows.push({ lo: Math.max(0, n - CONTEXT), hi: Math.min(lines.length - 1, n + CONTEXT) }); }
      }
      // futureErrors have no line number — search file for referenced text
      for (const e of entry.futureErrors) {
        const urlMatch = e.description?.match(/https?:\/\/\S+/);
        const needle = urlMatch?.[0];
        if (needle) {
          const idx = lines.findIndex((l: string) => l.includes(needle));
          if (idx >= 0) { windows.push({ lo: Math.max(0, idx - CONTEXT), hi: Math.min(lines.length - 1, idx + CONTEXT) }); }
        }
      }

      // Merge overlapping windows and build snippet
      let snippet: string;
      if (windows.length === 0) {
        // No locatable lines — send first 30 lines as fallback
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

      const errorSummary = [
        ...entry.linkErrors.map((e: any) => `  line ${e.line}: broken external link ${e.url}${e.reason ? ` (${e.reason})` : ''}`),
        ...entry.futureErrors.map((e: any) => `  ${e.description}`),
      ].join('\n');

      filesSection += `\n---\nFile: ${relFile}\nIssues:\n${errorSummary}\n\nRelevant lines:\n\`\`\`markdown\n${snippet}\n\`\`\`\n`;
    }

    const userPrompt =
      `Repository: ${cfg.repoSlug}\n` +
      `The CI link checker flagged issues in ${byFile.size} file(s). ` +
      `For each issue, output one NDJSON action per line including the "file" field:\n` +
      `{"action":"fix","file":"<repo-relative path>","find":"<exact text>","replace":"<replacement>"}\n` +
      `{"action":"skip","file":"<repo-relative path>","reason":"<why no fix>"}\n` +
      `{"action":"note","file":"<repo-relative path>","text":"<related observation>"}\n\n` +
      `Rules:\n` +
      `- "find" must be the exact string as it appears in the file — do NOT include the line-number prefix shown in snippets (e.g. "42: ...")\n` +
      `- For URL-only fixes, "find" should be just the URL string itself, not the surrounding Markdown\n` +
      `- Fix broken external links: remove trailing slashes, update old Redocly #operation/ paths to #\n` +
      `- De-link truly broken references: keep the link text, remove the [...](url) wrapper\n` +
      `- Do not change correct links — mark them skip with reason "false positive"\n` +
      `- Output ONLY NDJSON lines, no prose\n` +
      filesSection;

    const systemPrompt = repairContext ||
      `You are an Adobe Experience League documentation repair tool. ` +
      `You fix broken links in EXL Markdown files. Output only NDJSON — one JSON object per line.`;

    // ── Stream response, apply fixes to in-memory file contents ───────────
    const fileContents = new Map(Array.from(byFile.entries()).map(([k, v]) => [k, v.lines.join('\n')]));
    const fileChanged = new Set<string>();
    let lineBuffer = '';
    let rawResponse = '';
    let aiError: string | null = null;
    let firstChunk = true;
    let actionCount = 0;

    this._otherLog(`Sending ${byFile.size} file(s) to AI…`);
    this._post('fixFilesStarting', { files: Array.from(byFile.keys()).map(f => f.replace(/^\//, '')) });

    const slowTimer = setTimeout(() => {
      if (firstChunk) { this._otherLog('Still waiting for response…'); }
    }, 15000);

    try {
      await claude.query(systemPrompt, userPrompt, (chunk) => {
        if (firstChunk) {
          firstChunk = false;
          clearTimeout(slowTimer);
          this._otherLog('Response streaming…');
        }

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
                this._actionResult(file, 'fix', action.find);
              } else {
                this._actionResult(file, 'notfound', action.find);
              }
            } else if (action.action === 'skip') {
              this._actionResult(file, 'skip', undefined, action.reason);
            } else if (action.action === 'note') {
              this._actionResult(file, 'note', undefined, action.text);
            }
          } catch { /* incomplete JSON — ignore */ }
        }
      });
    } catch (e: any) {
      aiError = e.message;
      this._otherError(`AI error: ${e.message}`);
    } finally {
      clearTimeout(slowTimer);
    }

    if (!aiError && actionCount === 0) {
      output.appendLine('[ApplyFixes] Raw AI response:\n' + rawResponse.slice(0, 2000));
      this._otherLog('No actions returned — response may not be valid NDJSON.');
    }

    // ── Write changed files ────────────────────────────────────────────────
    let totalChanged = 0;
    let totalFailed = 0;
    for (const relFile of fileChanged) {
      const absFile = path.join(cfg.repoRoot, relFile.replace(/^\//, ''));
      try {
        require('fs').writeFileSync(absFile, fileContents.get(relFile)!, 'utf8');
        totalChanged++;
      } catch (e: any) {
        this._otherError(`Write failed for ${relFile}: ${e.message}`);
        totalFailed++;
      }
    }

    // ── Finalize cards and summary ─────────────────────────────────────────
    this._post('fixDone', { changed: Array.from(fileChanged).map(f => f.replace(/^\//, '')) });
    const parts: string[] = [];
    if (totalChanged > 0) { parts.push(`${totalChanged} file(s) changed`); }
    if (totalFailed > 0) { parts.push(`${totalFailed} write error(s)`); }
    if (aiError) { parts.push('AI error — partial results only'); }
    this._otherLog(parts.length ? parts.join(' · ') : 'No changes needed.');
    if (totalChanged > 0) { this._otherLog('Review with git diff before committing.'); }
  }

  private async _openFile(filepath: string, line?: number): Promise<void> {
    const base = this._config?.repoRoot ?? this._cwd;
    // Jenkins paths often start with /help/... — they look absolute but are
    // repo-relative. Always join with the repo root after stripping any leading slash.
    const relative = filepath.replace(/^\//, '');
    const absPath = path.join(base, relative);
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
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 8px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    gap: 4px;
  }
  .repo-info { font-size: 11px; color: var(--vscode-descriptionForeground); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
    border-radius: 2px;
    white-space: nowrap;
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-danger { background: #c62828; }
  .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; }
  .tab {
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
    border: none;
    background: none;
    color: var(--vscode-foreground);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .section { margin-bottom: 12px; }
  .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin-bottom: 4px; letter-spacing: 0.5px; }
  .build-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .build-num { font-weight: 600; min-width: 36px; }
  .badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 2px;
    font-weight: 600;
    min-width: 64px;
    text-align: center;
  }
  .badge-success { background: #1b5e20; color: #a5d6a7; }
  .badge-failure { background: #7f0000; color: #ffcdd2; }
  .badge-running { background: #1565c0; color: #90caf9; }
  .badge-aborted { background: #424242; color: #bdbdbd; }
  .badge-queued { background: #e65100; color: #ffcc80; }
  .build-meta { font-size: 11px; color: var(--vscode-descriptionForeground); flex: 1; }
  .error-row {
    padding: 4px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px;
  }
  .error-file { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .error-target { font-family: var(--vscode-editor-font-family); background: var(--vscode-textBlockQuote-background); padding: 0 3px; border-radius: 2px; }
  .fix-badge { font-size: 10px; padding: 1px 4px; border-radius: 2px; margin-left: 4px; }
  .fix-path { background: #1b5e20; color: #a5d6a7; }
  .fix-delink { background: #e65100; color: #ffcc80; }
  .fix-ambiguous { background: #4a148c; color: #ce93d8; }
  .resolved { text-decoration: line-through; color: var(--vscode-disabledForeground); }
  .log-panel {
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    background: var(--vscode-terminal-background, var(--vscode-editor-background));
    color: var(--vscode-terminal-foreground, var(--vscode-editor-foreground));
    padding: 6px;
    height: 200px;
    overflow-y: auto;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 2px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .log-error { color: var(--vscode-terminal-ansiRed, #f44336); }
  .report-status-card {
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 6px 8px;
    margin-bottom: 8px;
    font-size: 11px;
  }
  .report-status-row { display: flex; align-items: center; gap: 6px; }
  .report-status-icon { font-size: 13px; line-height: 1; }
  .report-status-text { font-weight: 600; flex: 1; }
  .report-next-line { margin-top: 3px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .btn-xs { font-size: 10px; padding: 1px 6px; }
  .report-new-banner {
    font-size: 11px;
    background: var(--vscode-notificationCenterHeader-background, #1e5e1e);
    color: var(--vscode-notificationCenterHeader-foreground, #c8e6c9);
    padding: 4px 8px;
    border-radius: 2px;
    margin-bottom: 6px;
  }
  .other-status {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
    min-height: 16px;
  }
  .other-status .status-error { color: var(--vscode-errorForeground); }
  .fix-card {
    display: flex;
    flex-direction: column;
    padding: 4px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px;
  }
  .fix-card-row { display: flex; align-items: center; gap: 6px; }
  .fix-card-icon { min-width: 14px; text-align: center; }
  .fix-card-file { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); }
  .fix-card-badge { font-size: 10px; padding: 1px 5px; border-radius: 2px; font-weight: 600; white-space: nowrap; }
  .fix-card-badge-fixed { background: #1b5e20; color: #a5d6a7; }
  .fix-card-badge-fail { background: #7f0000; color: #ffcdd2; }
  .fix-card-badge-neutral { background: #37474f; color: #b0bec5; }
  .fix-card-detail { margin-top: 3px; padding-left: 20px; color: var(--vscode-errorForeground); font-size: 10px; font-family: var(--vscode-editor-font-family); word-break: break-all; }
  @keyframes spin2 { to { transform: rotate(360deg); } }
  .fix-spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin2 0.8s linear infinite; vertical-align: middle; }
  .progress-bar { height: 3px; background: var(--vscode-panel-border); border-radius: 2px; margin: 4px 0; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--vscode-progressBar-background); transition: width 1s; }
  .action-row { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 0; }
  .repofix-row { padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; }
  .repofix-desc { color: var(--vscode-descriptionForeground); margin-top: 2px; font-size: 10px; }
  .repofix-url { font-family: var(--vscode-editor-font-family); font-size: 10px; color: var(--vscode-descriptionForeground); word-break: break-all; margin-top: 2px; }
  .repofix-bucket { font-size: 9px; font-weight: 600; padding: 1px 4px; border-radius: 2px; margin-left: 5px; vertical-align: middle; }
  .bucket-fix { background: #0d47a1; color: #90caf9; }
  .bucket-manual { background: #37474f; color: #b0bec5; }
  .bucket-fixed { background: #1b5e20; color: #a5d6a7; }
  .bucket-flagged { background: #4a148c; color: #ce93d8; }
  .eta-row { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 4px 0; }
  .pipeline { margin-bottom: 8px; }
  .pipeline-step { display: flex; gap: 8px; align-items: flex-start; }
  .pipeline-action-step { background: var(--vscode-textBlockQuote-background); border-radius: 4px; padding: 6px; margin: 0 -6px; }
  .pipeline-icon { font-size: 14px; min-width: 18px; text-align: center; line-height: 1.4; }
  .pipeline-body { flex: 1; }
  .pipeline-label { font-size: 11px; font-weight: 600; margin-bottom: 2px; }
  .pipeline-desc { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
  .pipeline-desc code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textBlockQuote-background); padding: 0 3px; border-radius: 2px; color: var(--vscode-foreground); }
  .pipeline-arrow { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; padding: 1px 0 1px 9px; line-height: 1; }
  .icon-success { color: #66bb6a; }
  .icon-failure { color: #ef5350; }
  .icon-running { color: #42a5f5; }
  .icon-neutral { color: var(--vscode-descriptionForeground); }
  .setup-panel { padding: 8px 0; }
  .setup-panel p { font-size: 11px; margin-bottom: 8px; line-height: 1.5; }
  .setup-panel a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .setup-input {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 6px;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family);
    border-radius: 2px;
    margin-bottom: 6px;
    box-sizing: border-box;
  }
  .setup-input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .setup-label { display: block; font-size: 11px; font-weight: 600; margin-bottom: 3px; }
</style>
</head>
<body>

<!-- ── Setup form (shown when credentials are incomplete) ─────────────── -->
<div id="setupPanel" style="display:none">
  <div class="setup-panel">
    <p id="setupIntro">Enter your credentials below. At least one AI key (Claude or Anthropic) is required to use Apply Fixes.</p>

    <label class="setup-label">Jenkins API token</label>
    <p style="font-size:11px;margin:0 0 4px">
      Generate at your <a id="tokenLink" onclick="openTokenUrl()">Jenkins profile page</a>.
    </p>
    <input id="tokenInput" class="setup-input" type="password" placeholder="Jenkins API token" />

    <label class="setup-label" style="margin-top:12px">Claude API key <span style="opacity:0.6;font-weight:normal">(claude.ai)</span></label>
    <p style="font-size:11px;margin:0 0 4px">From <a onclick="openUrl('https://claude.ai/settings/api-keys')">claude.ai → Settings → API Keys</a>.</p>
    <input id="claudeKeyInput" class="setup-input" type="password" placeholder="sk-ant-..." />

    <label class="setup-label" style="margin-top:12px">ChatGPT API key <span style="opacity:0.6;font-weight:normal">(OpenAI)</span></label>
    <p style="font-size:11px;margin:0 0 4px">From <a onclick="openUrl('https://platform.openai.com/api-keys')">platform.openai.com → API Keys</a>.</p>
    <input id="openAiKeyInput" class="setup-input" type="password" placeholder="sk-..." />

    <div class="action-row" style="margin-top:14px">
      <button class="btn" onclick="submitCredentials()">Save</button>
    </div>
    <p id="setupError" style="color:var(--vscode-errorForeground);display:none"></p>
  </div>
</div>

<!-- ── Main UI (hidden during setup) ─────────────────────────────────── -->
<div id="mainPanel">

<div class="header">
  <span class="repo-info" id="repoInfo">Loading...</span>
  <button class="btn btn-secondary" onclick="refresh()" id="refreshBtn">↻ Refresh</button>
</div>
<div id="bannerError" style="display:none;font-size:11px;color:var(--vscode-errorForeground);background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);padding:4px 6px;border-radius:2px;margin-bottom:6px"></div>

<div class="tabs">
  <button class="tab active" data-tab="status" onclick="switchTab('status')">Status</button>
  <button class="tab" data-tab="build" onclick="switchTab('build')">Build</button>
  <button class="tab" id="tabOtherErrors" data-tab="othererrors" onclick="switchTab('othererrors')">Other Errors</button>
</div>

<!-- ── Status Tab ─────────────────────────────────────────────────────── -->
<div class="tab-panel active" id="tab-status">
  <div class="section">
    <div class="section-title">Review builds</div>
    <div id="buildHistory"><span class="empty">Loading...</span></div>
  </div>
  <div class="section">
    <div class="section-title">Prod builds</div>
    <div id="prodHistory"><span class="empty">Loading...</span></div>
  </div>
  <div class="section">
    <div class="section-title">Review errors</div>
    <div id="errorList"><span class="empty">—</span></div>
  </div>
  <div class="section">
    <div class="section-title">Prod errors</div>
    <div id="prodErrorList"><span class="empty">—</span></div>
  </div>
</div>

<!-- ── Build Tab ──────────────────────────────────────────────────────── -->
<div class="tab-panel" id="tab-build">
  <div class="pipeline">
    <div class="pipeline-step">
      <div class="pipeline-icon">⎇</div>
      <div class="pipeline-body">
        <div class="pipeline-label">Your branch</div>
        <div class="pipeline-desc" id="pipelineBranch">—</div>
      </div>
    </div>
    <div class="pipeline-step pipeline-action-step">
      <div class="pipeline-icon">⬆</div>
      <div class="pipeline-body">
        <div class="pipeline-label">Review &amp; Fix</div>
        <div class="action-row" style="margin-top:6px">
          <button class="btn" onclick="mergePush()">Single Fix Cycle</button>
          <button class="btn btn-secondary" onclick="autoFix()">⚙ Auto Fix</button>
        </div>
        <div class="pipeline-desc"><b>Single Fix Cycle</b> merges to <code>review</code> and fixes build issues. Stops before commit.</div>
        <div class="pipeline-desc"><b>Auto Fix</b> reviews and fixes and commits until passes.</div>
      </div>
    </div>
    <div class="pipeline-arrow">↓</div>
    <div class="pipeline-step">
      <div class="pipeline-icon" id="reviewBuildIcon">○</div>
      <div class="pipeline-body">
        <div class="pipeline-label">Review build</div>
        <div class="pipeline-desc">Link checking and staging publish — <span id="pipelineReviewStatus">—</span></div>
      </div>
    </div>
    <div class="pipeline-arrow">↓</div>
    <div class="pipeline-step">
      <div class="pipeline-icon" id="prodBuildIcon">○</div>
      <div class="pipeline-body">
        <div class="pipeline-label">Prod build</div>
        <div class="pipeline-desc">Publishes to live Experience League — <span id="pipelineProdStatus">—</span></div>
      </div>
    </div>
  </div>
  <div style="margin-top:8px">
  <div id="progressWrap" style="display:none">
    <div class="eta-row" id="etaRow"></div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
  </div>
  <div class="log-panel" id="buildLog"></div>
  </div>
</div>

<!-- ── Other Errors Tab ───────────────────────────────────────────────── -->
<div class="tab-panel" id="tab-othererrors">
  <div id="reportStatusCard" class="report-status-card" style="display:none">
    <div class="report-status-row">
      <span id="reportStatusIcon" class="report-status-icon">○</span>
      <span id="reportStatusText" class="report-status-text"></span>
      <button class="btn btn-secondary btn-xs" onclick="repofixes()" style="margin-left:auto">↻ Refresh</button>
    </div>
    <div id="reportNextLine" class="report-next-line"></div>
  </div>
  <div id="reportNewBanner" style="display:none" class="report-new-banner">New report available — list updated</div>
  <div class="action-row" style="margin-top:6px">
    <button class="btn" id="applyFixesBtn" onclick="applyFixes()">⚡ Apply Fixes</button>
  </div>
  <div id="otherStatus" class="other-status" style="display:none"></div>
  <div id="fixCards" style="display:none;margin-bottom:8px"></div>
  <div id="repofixList"><span class="empty">Loading...</span></div>
</div>

</div> <!-- /mainPanel -->

<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
