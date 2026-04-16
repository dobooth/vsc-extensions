import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { JenkinsConfig } from './jenkins-config';

export interface BuildRun {
  id: string;
  result: 'SUCCESS' | 'FAILURE' | 'UNSTABLE' | 'ABORTED' | 'RUNNING' | 'QUEUED' | null;
  state: string;
  startTime: string | null;
  durationInMillis: number | null;
  estimatedDurationInMillis: number | null;
}

export interface BuildError {
  filepath: string;
  lineno: string;
  target: string;
  reason: string;
  active: boolean;
  fixStatus: 'path-fix' | 'delink' | 'ambiguous' | 'unknown';
  fixCandidates?: string[];
}

export interface BuildSummary {
  buildNum: number;
  errors: BuildError[];
  unparsed: Array<{ stage: string; line: string; loglink?: string }>;
}

export interface FutureError {
  file: string;
  description: string;
  bucket: 'suggest-delink' | 'no-auto-fix';
}

export interface LinkError {
  file: string;
  line: string;
  url: string;
  reason: string;
}

export interface QueueItem {
  id: number;
  why: string;
}

/** Parse one line of CSV, respecting double-quoted fields. */
function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function httpsGet(url: string, authHeader: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: `Basic ${authHeader}` },
      timeout: 15000,
    }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function httpsGetBinary(url: string, authHeader: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: `Basic ${authHeader}` },
      timeout: 15000,
    }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

export async function testConnectivity(config: JenkinsConfig): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get(`${config.baseUrl}/api/json`, {
      headers: { Authorization: `Basic ${config.authHeader}` },
      timeout: 10000,
    }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export async function getBuildHistory(config: JenkinsConfig): Promise<BuildRun[]> {
  // Try Blue Ocean API first (pipeline jobs); fall back to classic API (freestyle jobs)
  try {
    const url = `${config.baseUrl}/blue/rest/organizations/jenkins/pipelines/${config.jobName}/runs/?start=0&limit=5`;
    const body = await httpsGet(url, config.authHeader);
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as BuildRun[];
    }
  } catch { /* fall through */ }

  // Classic API fallback
  try {
    const url = `${config.baseUrl}/job/${config.jobName}/api/json?tree=builds%5Bnumber,result,timestamp,duration,building%5D%7B,5%7D`;
    const body = await httpsGet(url, config.authHeader);
    const data = JSON.parse(body);
    return (data.builds || []).map((b: any): BuildRun => ({
      id: String(b.number),
      result: b.building ? null : (b.result ?? null),
      state: b.building ? 'RUNNING' : 'FINISHED',
      startTime: b.timestamp ? new Date(b.timestamp).toISOString() : null,
      durationInMillis: b.duration || null,
      estimatedDurationInMillis: null,
    }));
  } catch {
    return [];
  }
}

export async function getQueueItem(config: JenkinsConfig): Promise<QueueItem | null> {
  try {
    const url = `${config.baseUrl}/queue/api/json?tree=items%5Bid,why,task%5Bname%5D%5D`;
    const body = await httpsGet(url, config.authHeader);
    const data = JSON.parse(body);
    const item = (data.items || []).find((i: any) => i?.task?.name === config.jobName);
    return item ? { id: item.id, why: item.why } : null;
  } catch {
    return null;
  }
}

export async function getLastBuildNums(config: JenkinsConfig): Promise<{ lastFailed: number; lastSuccess: number }> {
  try {
    const url = `${config.baseUrl}/job/${config.jobName}/api/json?tree=lastFailedBuild%5Bnumber%5D,lastSuccessfulBuild%5Bnumber%5D`;
    const body = await httpsGet(url, config.authHeader);
    const data = JSON.parse(body);
    return {
      lastFailed: data.lastFailedBuild?.number ?? 0,
      lastSuccess: data.lastSuccessfulBuild?.number ?? 0,
    };
  } catch {
    return { lastFailed: 0, lastSuccess: 0 };
  }
}

export async function getBuildSummary(config: JenkinsConfig, buildNum: number, repoRoot: string): Promise<BuildSummary | null> {
  if (!buildNum) { return null; }
  try {
    const url = `${config.baseUrl}/job/${config.jobName}/${buildNum}/artifact/logs/buildsummary.json`;
    const body = await httpsGet(url, config.authHeader);
    const summary = JSON.parse(body);
    return parseBuildSummary(buildNum, summary, repoRoot);
  } catch {
    return null;
  }
}

const ERROR_PATTERN = /^\[ERROR\] ([^:]+):(\d+) (\S+) - (.+)/;

function parseBuildSummary(buildNum: number, summary: any, repoRoot: string): BuildSummary {
  const errors: BuildError[] = [];
  const unparsed: BuildSummary['unparsed'] = [];

  for (const [, stage] of Object.entries(summary.stages || {})) {
    const s = stage as any;
    if (s.status !== 'FAIL') { continue; }
    for (const line of (s.errorlines || []) as string[]) {
      const m = ERROR_PATTERN.exec(line);
      if (!m) {
        unparsed.push({ stage: s.name || '', line, loglink: s.loglink });
        continue;
      }
      const [, filepath, lineno, target, reason] = m;
      const fullPath = path.isAbsolute(filepath) ? filepath : path.join(repoRoot, filepath);
      const active = errorStillActive(fullPath, parseInt(lineno), target);
      const { fixStatus, fixCandidates } = evaluateFix(repoRoot, target);
      errors.push({ filepath, lineno, target, reason, active, fixStatus, fixCandidates });
    }
  }

  return { buildNum, errors, unparsed };
}

function errorStillActive(filepath: string, lineno: number, target: string): boolean {
  try {
    const lines = fs.readFileSync(filepath, 'utf8').split('\n');
    const lo = Math.max(0, lineno - 3);
    const hi = Math.min(lines.length, lineno + 2);
    const chunk = lines.slice(lo, hi).join('\n');
    const basename = path.basename(target);
    return /\]\([^)]*/.test(chunk) && chunk.includes(basename);
  } catch {
    return false;
  }
}

export function evaluateFix(repoRoot: string, target: string): { fixStatus: BuildError['fixStatus']; fixCandidates?: string[] } {
  const clean = target.split('#')[0].trim().replace(/^<|>$/g, '').replace(/\/+$/, ''); // strip trailing slash
  if (!clean) { return { fixStatus: 'unknown' }; }

  const parts = clean.split('/').filter(p => p && p !== '.');
  let matches: string[] = [];

  for (let i = 0; i < parts.length && matches.length === 0; i++) {
    const suffix = parts.slice(i).join('/');

    // Build candidates: exact suffix, then with .md if no extension
    const ext = path.extname(suffix);
    const suffixCandidates = ext ? [suffix] : [suffix, suffix + '.md'];

    for (const s of suffixCandidates) {
      try {
        const { execSync } = require('child_process');
        const result = execSync(
          `find . -path '*/${s}' -not -path '*/.git/*'`,
          { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
        ).trim();
        matches = result ? result.split('\n').filter(Boolean) : [];
      } catch {
        matches = [];
      }
      if (matches.length > 0) { break; }
    }
  }

  if (matches.length === 0) { return { fixStatus: 'delink' }; }
  if (matches.length === 1) { return { fixStatus: 'path-fix', fixCandidates: matches }; }

  // Multiple matches — pick best by directory proximity heuristic
  return { fixStatus: 'ambiguous', fixCandidates: matches.slice(0, 3) };
}

export async function getRepofixesData(config: JenkinsConfig): Promise<{
  futureErrors: FutureError[];
  linkErrors: LinkError[];
}> {
  const tmpDir = path.join(os.tmpdir(), `jenkins-${config.repoSlug}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const [futureBody, linkBody] = await Promise.allSettled([
    httpsGet(
      `${config.baseUrl}/view/Reporting/job/FutureErrorsCheckExl/lastSuccessfulBuild/artifact/futureErrors.json`,
      config.authHeader
    ),
    httpsGet(
      `${config.baseUrl}/view/Reporting/job/LinkCheckExl/lastSuccessfulBuild/artifact/${config.repoSlug}.csv`,
      config.authHeader
    ),
  ]);

  const futureErrors: FutureError[] = [];
  if (futureBody.status === 'fulfilled') {
    try {
      const data = JSON.parse(futureBody.value);
      const errors: any[] = data[config.repoSlug]?.futureErrors || [];
      for (const err of errors) {
        const desc: string = err[1] || '';
        const file: string = (err[0] || '').replace(/:$/, '');
        if (desc.startsWith('Internal link found in') || desc.startsWith('Bad external link found in TOC')) {
          futureErrors.push({ file, description: desc, bucket: 'suggest-delink' });
        } else {
          futureErrors.push({ file, description: desc, bucket: 'no-auto-fix' });
        }
      }
    } catch { /* ignore */ }
  }

  const linkErrors: LinkError[] = [];
  if (linkBody.status === 'fulfilled') {
    try {
      const lines = linkBody.value.split('\n');
      // CSV has shifted headers: repo=source+line, srcfile=url, link=reason
      // Fields may be quoted — strip surrounding quotes before use
      for (const line of lines.slice(1)) {
        if (!line.trim()) { continue; }
        const cols = parseCSVLine(line);
        if (cols.length < 3) { continue; }
        const repoCol = cols[0];
        const colonIdx = repoCol.lastIndexOf(':');
        const file = colonIdx > 0 ? repoCol.slice(0, colonIdx) : repoCol;
        const lineNum = colonIdx > 0 ? repoCol.slice(colonIdx + 1) : '';
        linkErrors.push({ file, line: lineNum, url: cols[1], reason: cols[2] });
      }
    } catch { /* ignore */ }
  }

  return { futureErrors, linkErrors };
}

export async function pollBuildByNumber(config: JenkinsConfig, buildNum: number): Promise<{
  building: boolean;
  result: string | null;
  timestamp: number;
  estimatedDuration: number;
}> {
  const url = `${config.baseUrl}/job/${config.jobName}/${buildNum}/api/json?tree=building,result,timestamp,estimatedDuration`;
  const body = await httpsGet(url, config.authHeader);
  const data = JSON.parse(body);
  return {
    building: data.building === true,
    result: data.result ?? null,
    timestamp: Math.floor((data.timestamp || 0) / 1000),
    estimatedDuration: Math.floor((data.estimatedDuration || 0) / 1000),
  };
}

export async function findBuildBySha(config: JenkinsConfig, sha: string, after: number): Promise<number | null> {
  try {
    const url = `${config.baseUrl}/job/${config.jobName}/api/json`;
    const body = await httpsGet(url, config.authHeader);
    const data = JSON.parse(body);
    for (const b of (data.builds || [])) {
      if (b.number <= after) { continue; }
      const buildUrl = `${config.baseUrl}/job/${config.jobName}/${b.number}/api/json`;
      const buildBody = await httpsGet(buildUrl, config.authHeader);
      const buildData = JSON.parse(buildBody);
      for (const action of (buildData.actions || [])) {
        if (action?.lastBuiltRevision?.SHA1 === sha) { return b.number; }
      }
    }
  } catch { /* ignore */ }
  return null;
}
