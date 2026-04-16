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
  private _lastRepofixes: { futureErrors: any[]; linkErrors: any[] } | null = null;

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    (webviewView as any).retainContextWhenHidden = true;
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'refresh': await this._handleRefresh(); break;
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
    const cfg = await this._loadConfig();
    if (!cfg) { this._setLoading(false); return; }

    const ok = await testConnectivity(cfg);
    if (!ok) {
      output.appendLine(`[Jenkins] Connectivity test failed for ${cfg.baseUrl}`);
      this._post('banner', { text: 'Cannot reach Jenkins — check VPN and credentials. Click ↻ to retry.' });
      this._setLoading(false);
      return;
    }
    output.appendLine(`[Jenkins] Connected to ${cfg.baseUrl}`);
    this._post('banner', { text: '' }); // clear any previous error

    // Fetch review, prod, and other errors data all in parallel
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
    this._post('repofixesData', repofixes);

    this._setLoading(false);
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
        // Refresh status panel
        await this._handleRefresh();
        return;
      }
    }
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

  private _annotateRepofixes(repofixes: { futureErrors: any[]; linkErrors: any[] }, repoRoot: string): void {
    const fileCache = new Map<string, string>();
    const read = (file: string): string => {
      if (!fileCache.has(file)) {
        const abs = path.join(repoRoot, file.replace(/^\//, ''));
        try { fileCache.set(file, require('fs').readFileSync(abs, 'utf8')); } catch { fileCache.set(file, ''); }
      }
      return fileCache.get(file)!;
    };

    for (const e of repofixes.linkErrors) {
      if (e.url) { e.alreadyFixed = !read(e.file).includes(e.url); }
    }
    for (const e of repofixes.futureErrors) {
      const urlMatch = e.description?.match(/https?:\/\/\S+/);
      const needle = urlMatch?.[0];
      if (needle) { e.alreadyFixed = !read(e.file).includes(needle); }
    }
  }

  private async _handleRepofixes(): Promise<void> {
    const cfg = await this._loadConfig();
    if (!cfg) { return; }

    this._post('switchTab', { tab: 'othererrors' });
    this._log('Fetching other errors...');

    const { futureErrors, linkErrors } = await getRepofixesData(cfg);
    this._lastRepofixes = { futureErrors, linkErrors };
    this._annotateRepofixes(this._lastRepofixes, cfg.repoRoot);
    this._post('repofixesData', { futureErrors, linkErrors });
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

    this._otherLog(`Branch: ${status.branch}  Root: ${cfg.repoRoot}`);

    // ── AI client — prefer Claude (Anthropic), fall back to OpenAI ──────
    const claudeKey = await this._context.secrets.get(ANTHROPIC_KEY_SECRET);
    const openAiKey = await this._context.secrets.get(OPENAI_KEY_SECRET);
    const claude = buildClaudeClient(claudeKey, openAiKey);
    const aiLabel = claudeKey ? 'Claude (Anthropic) API' : openAiKey ? 'OpenAI API (claude CLI fallback)' : 'claude CLI';
    this._otherLog(`Using ${aiLabel}`);

    const repairContext = loadRepairContext(this._context.extensionPath);

    const { futureErrors, linkErrors } = this._lastRepofixes;
    this._otherLog(`${futureErrors.length} internal issue(s), ${linkErrors.length} external link error(s)`);

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
          this._otherLog(`  ✓ already fixed: ${e.file} — ${e.url.slice(0, 60)}`);
        } else {
          entry.linkErrors.push(e);
        }
      } else {
        const urlMatch = e.description?.match(/https?:\/\/\S+/);
        const needle = urlMatch?.[0];
        if (needle && !fileText.includes(needle)) {
          this._otherLog(`  ✓ already fixed: ${e.file} — ${needle.slice(0, 60)}`);
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
      `- "find" must be the exact string as it appears in the file\n` +
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
    let aiError: string | null = null;
    let firstChunk = true;
    let actionCount = 0;

    this._otherLog(`Sending ${byFile.size} file(s) to AI…`);

    const slowTimer = setTimeout(() => {
      if (firstChunk) { this._otherLog('  Still waiting for response…'); }
    }, 15000);

    try {
      await claude.query(systemPrompt, userPrompt, (chunk) => {
        if (firstChunk) {
          firstChunk = false;
          clearTimeout(slowTimer);
          this._otherLog('  Response streaming…');
        }

        lineBuffer += chunk;
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
                this._otherLog(`  ✓ [${file}] ${action.find.slice(0, 50)}${action.find.length > 50 ? '…' : ''}`);
              } else {
                this._otherLog(`  ✗ [${file}] Not found: ${action.find.slice(0, 50)}${action.find.length > 50 ? '…' : ''}`);
              }
            } else if (action.action === 'skip') {
              this._otherLog(`  · [${file}] skip: ${action.reason}`);
            } else if (action.action === 'note') {
              this._otherLog(`  ℹ [${file}] ${action.text}`);
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
      this._otherLog('  No actions returned — response may not be valid NDJSON.');
    }

    // ── Write changed files ────────────────────────────────────────────────
    let totalChanged = 0;
    let totalFailed = 0;
    for (const relFile of fileChanged) {
      const absFile = path.join(cfg.repoRoot, relFile.replace(/^\//, ''));
      try {
        require('fs').writeFileSync(absFile, fileContents.get(relFile)!, 'utf8');
        this._otherLog(`  saved: ${relFile}`);
        totalChanged++;
      } catch (e: any) {
        this._otherError(`  Write failed for ${relFile}: ${e.message}`);
        totalFailed++;
      }
    }

    // ── Summary ────────────────────────────────────────────────────────────
    const parts: string[] = [];
    if (totalChanged > 0) { parts.push(`${totalChanged} file(s) changed`); }
    if (totalFailed > 0) { parts.push(`${totalFailed} write error(s)`); }
    if (aiError) { parts.push('AI error — partial results only'); }
    this._otherLog(`\n${parts.length ? parts.join(' · ') : 'No changes needed.'}`);
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

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
        <div class="pipeline-desc"><b>Single Fix Cycle</b> merges to <code>review</code> and fixes build issues. Stops for manual check.</div>
        <div class="pipeline-desc"><b>Auto Fix</b> reviews and fixes until the build passes.</div>
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
  <div class="action-row">
    <button class="btn" onclick="applyFixes()">⚡ Apply Fixes</button>
  </div>
  <div id="otherLog" class="log-panel" style="display:none;margin-bottom:8px;height:130px"></div>
  <div id="repofixList"><span class="empty">Loading...</span></div>
</div>

</div> <!-- /mainPanel -->

<script>
  const vscode = acquireVsCodeApi();
  let _tokenUrl = '';

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

    function fileLink(file, line, fixed) {
      return '<span class="error-file open-file" data-file="' + escAttr(file) + '" data-line="' + escAttr(line || '') + '">'
        + escHtml(file) + (line ? '<span style="color:var(--vscode-descriptionForeground)">:' + escHtml(line) + '</span>' : '')
        + '</span>';
    }

    if (futureErrors && futureErrors.length) {
      const active = futureErrors.filter(e => !e.alreadyFixed);
      if (active.length) {
        html += '<div class="section-title" style="margin-bottom:4px">Internal Link Issues (' + active.length + ')</div>';
        for (const e of active) {
          const canFix = e.bucket === 'suggest-delink';
          const badge = canFix
            ? '<span class="repofix-bucket bucket-fix">Auto Fix</span>'
            : '<span class="repofix-bucket bucket-manual">manual</span>';
          html += '<div class="repofix-row">' + fileLink(e.file, '', false) + badge;
          html += '<div class="repofix-desc">' + escHtml(e.description) + '</div></div>';
        }
      }
      for (const e of futureErrors.filter(e => e.alreadyFixed)) {
        fixedRows.push('<div class="repofix-row">' + fileLink(e.file, '', true)
          + '<span class="repofix-bucket bucket-fixed">Fixed Locally</span></div>');
      }
    }

    if (linkErrors && linkErrors.length) {
      const active = linkErrors.filter(e => !e.alreadyFixed);
      if (active.length) {
        html += '<div class="section-title" style="margin:10px 0 4px">External Link Issues (' + active.length + ')</div>';
        for (const e of active) {
          html += '<div class="repofix-row">' + fileLink(e.file, e.line, false)
            + '<span class="repofix-bucket bucket-fix">Auto Fix</span>';
          html += '<div class="repofix-url">' + escHtml(e.url) + '</div>';
          if (e.reason) { html += '<div class="repofix-desc">' + escHtml(e.reason) + '</div>'; }
          html += '</div>';
        }
      }
      for (const e of linkErrors.filter(e => e.alreadyFixed)) {
        fixedRows.push('<div class="repofix-row">' + fileLink(e.file, e.line, true)
          + '<span class="repofix-bucket bucket-fixed">Fixed Locally</span></div>');
      }
    }

    if (fixedRows.length) {
      html += '<div class="section-title" style="margin:10px 0 4px">Fixed Locally (' + fixedRows.length + ')</div>';
      html += fixedRows.join('');
    }

    if (!html) { html = '<span class="empty">No outstanding issues.</span>'; }
    return html;
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
        const count = (msg.futureErrors?.length || 0) + (msg.linkErrors?.length || 0);
        document.getElementById('tabOtherErrors').textContent = count ? 'Other Errors (' + count + ')' : 'Other Errors';
        document.getElementById('repofixList').innerHTML = renderRepofixes(msg.futureErrors, msg.linkErrors);
        break;
      }

      case 'showOtherLog': {
        const el = document.getElementById('otherLog');
        el.innerHTML = '';
        el.style.display = 'block';
        break;
      }

      case 'otherLog': {
        const el = document.getElementById('otherLog');
        const text = msg.text || '';
        // Leading \\n → insert a blank spacer line first
        if (text.startsWith('\\n')) {
          const spacer = document.createElement('div');
          spacer.innerHTML = '&nbsp;';
          el.appendChild(spacer);
        }
        const div = document.createElement('div');
        if (msg.isError) div.className = 'log-error';
        div.textContent = text.replace(/^\\n/, '');
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
        break;
      }
    }
  });
</script>
</body>
</html>`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
