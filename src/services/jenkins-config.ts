import { execSync } from 'child_process';

export interface JenkinsConfig {
  baseUrl: string;
  authHeader: string; // Base64-encoded "user:token" for Authorization: Basic
  jobName: string;    // review job: {slug}_review-exl
  prodJobName: string; // prod job: {slug}_en
  currentBranch: string;
  repoSlug: string;
  repoRoot: string;
}

const BASE_URL = 'https://docs.ci.corp.adobe.com';
export const SECRETS_KEY = 'exl-jenkins-auth'; // key used with vscode SecretStorage

function getRepoSlug(cwd: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf8' }).trim();
    const slug = remote.replace(/\.git$/, '').split(/[/:]/).pop();
    return slug || null;
  } catch {
    return null;
  }
}

function getCurrentBranch(cwd: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getRepoRoot(cwd: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Build a JenkinsConfig from a raw "user:token" credential string and the
 * current working directory. Returns null if the cwd is not a git repo.
 */
export function buildConfig(rawAuth: string, cwd: string): JenkinsConfig | null {
  const repoSlug = getRepoSlug(cwd);
  if (!repoSlug) { return null; }

  const repoRoot = getRepoRoot(cwd);
  if (!repoRoot) { return null; }

  const authHeader = Buffer.from(rawAuth).toString('base64');
  const jobName = `${repoSlug}_review-exl`;
  const prodJobName = `${repoSlug}_exl`;
  const currentBranch = getCurrentBranch(cwd);

  return { baseUrl: BASE_URL, authHeader, jobName, prodJobName, currentBranch, repoSlug, repoRoot };
}
