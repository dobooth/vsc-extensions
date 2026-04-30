import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitStatus {
  clean: boolean;
  branch: string;
  repoRoot: string;
}

export function getStatus(cwd: string): GitStatus {
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();
  const porcelain = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
  const repoRoot = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8' }).trim();
  return { clean: porcelain.length === 0, branch, repoRoot };
}


/**
 * Apply a path fix: replace the broken link target with a corrected relative path.
 * Returns true if a replacement was made.
 */
export function applyPathFix(
  filepath: string,
  lineno: number,
  brokenTarget: string,
  correctAbsPath: string
): boolean {
  const srcDir = path.dirname(path.resolve(filepath));
  const relPath = path.relative(srcDir, correctAbsPath);

  try {
    const lines = fs.readFileSync(filepath, 'utf8').split('\n');
    const basename = path.basename(brokenTarget);
    const lo = Math.max(0, lineno - 3);
    const hi = Math.min(lines.length, lineno + 2);

    for (let i = lo; i < hi; i++) {
      if (!lines[i].includes(basename)) { continue; }
      const original = lines[i];

      // Markdown link: ](path/file.md), ](file.md#anchor), ](file.md "title")
      let updated = original.replace(
        new RegExp(`\\]\\([^)]*${escapeRegex(basename)}((?:#[^)"# ]+)?(?:\\s+"[^"]*")?\\))`),
        `](${relPath}$1`
      );

      // HTML href: href="path/file.md"
      if (updated === original) {
        updated = original.replace(
          new RegExp(`(href=["'])(?:[^"']*/)${escapeRegex(basename)}((?:#[^"']+)?["'])`),
          `$1${relPath}$2`
        );
      }

      if (updated !== original) {
        lines[i] = updated;
        fs.writeFileSync(filepath, lines.join('\n'), 'utf8');
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Commit all modified tracked files.
 */
export function commitFixes(cwd: string, message: string): void {
  execSync('git add -u', { cwd });
  const r = spawnSync('git', ['commit', '-m', message], { cwd, encoding: 'utf8' });
  if (r.status !== 0) { throw new Error(r.stderr?.trim() || 'git commit failed'); }
}

/**
 * Fix a specific broken URL in a file at a given line.
 * Replaces all occurrences of brokenUrl anywhere in the file.
 * lineno is ignored — full-file scan is more reliable than a line window.
 */
export function fixLinkInFile(
  filepath: string,
  _lineno: number,
  brokenUrl: string,
  fixedUrl: string
): boolean {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    if (!content.includes(brokenUrl)) { return false; }
    fs.writeFileSync(filepath, content.split(brokenUrl).join(fixedUrl), 'utf8');
    return true;
  } catch { return false; }
}

/**
 * Find all markdown files that link to brokenBasename and rewrite those links
 * to point to correctAbsPath (converted to a relative path from each source file).
 * Returns the list of changed files.
 */
export function updateLinksToTarget(
  repoRoot: string,
  brokenTarget: string,
  correctAbsPath: string
): { file: string; count: number }[] {
  const basename = path.basename(brokenTarget.split('#')[0].replace(/\/+$/, ''));
  if (!basename) { return []; }

  const results: { file: string; count: number }[] = [];
  try {
    const grep = spawnSync('grep', ['-rl', basename, '--include=*.md', '.'], {
      cwd: repoRoot, encoding: 'utf8',
    });
    const files = (grep.stdout || '').trim().split('\n').filter(Boolean);

    for (const relFile of files) {
      const absFile = path.join(repoRoot, relFile);
      let content: string;
      try { content = fs.readFileSync(absFile, 'utf8'); } catch { continue; }
      const original = content;

      const srcDir = path.dirname(absFile);
      const relTarget = path.relative(srcDir, correctAbsPath);
      const esc = escapeRegex(basename);

      // Replace ](*/basename[/][#anchor]["title"]) with ](relTarget[#anchor]["title"])
      content = content.replace(
        new RegExp(`(\\]\\()([^)]*${esc})[/]?((?:#[^)"# ]+)?(?:\\s+"[^"]*")?)(\\))`, 'g'),
        (_m, open, _broken, suffix, close) => `${open}${relTarget}${suffix}${close}`
      );
      // Replace href="*/basename[/]" with href="relTarget"
      content = content.replace(
        new RegExp(`(href=["'])([^"']*${esc})[/]?(["'])`, 'g'),
        (_m, pre, _broken, q) => `${pre}${relTarget}${q}`
      );

      if (content !== original) {
        fs.writeFileSync(absFile, content, 'utf8');
        const count = (original.match(new RegExp(esc, 'g')) || []).length;
        results.push({ file: relFile, count: Math.max(1, count) });
      }
    }
  } catch { /* ignore */ }
  return results;
}

/**
 * Find all markdown files in repoRoot that link to targetFile (by basename),
 * remove the link wrapper keeping the text, and return the list of changed files.
 */
export function delinkBrokenRef(
  repoRoot: string,
  targetFile: string
): { file: string; count: number }[] {
  const basename = path.basename(targetFile.split('#')[0]);
  if (!basename) { return []; }

  const results: { file: string; count: number }[] = [];
  try {
    const grep = spawnSync('grep', ['-rl', basename, '--include=*.md', '.'], {
      cwd: repoRoot, encoding: 'utf8',
    });
    const files = (grep.stdout || '').trim().split('\n').filter(Boolean);

    for (const relFile of files) {
      const absFile = path.join(repoRoot, relFile);
      let content: string;
      try { content = fs.readFileSync(absFile, 'utf8'); } catch { continue; }
      const original = content;
      const esc = escapeRegex(basename);

      // [text](*/basename[#anchor]["title"]){attrs} → text
      content = content.replace(
        new RegExp(`\\[([^\\]]+)\\]\\([^)]*${esc}[^)]*\\)(?:\\{[^}]*\\})?`, 'g'),
        '$1'
      );
      // <a href="*/basename[#anchor]">text</a> → text
      content = content.replace(
        new RegExp(`<a[^>]*href="[^"]*${esc}[^"]*"[^>]*>([^<]*)<\\/a>`, 'g'),
        '$1'
      );
      // Orphaned {target="_blank"} not preceded by )
      content = content.replace(/(?<!\))\{target="_blank"\}/g, '');

      if (content !== original) {
        fs.writeFileSync(absFile, content, 'utf8');
        const count = (original.match(new RegExp(`\\[[^\\]]+\\]\\([^)]*${esc}`, 'g')) || []).length;
        results.push({ file: relFile, count: Math.max(1, count) });
      }
    }
  } catch { /* ignore */ }
  return results;
}

/**
 * Push current branch to origin and return the pushed HEAD SHA.
 */
export function pushCurrentBranch(cwd: string): string {
  execSync('git push origin HEAD', { cwd, encoding: 'utf8' });
  return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
}

/**
 * Stage all modified tracked files, commit, and push HEAD to origin.
 */
export function commitAndPush(cwd: string, message: string): void {
  execSync('git add -u', { cwd });
  const r = spawnSync('git', ['commit', '-m', message], { cwd, encoding: 'utf8' });
  if (r.status !== 0) { throw new Error(r.stderr?.trim() || 'git commit failed'); }
  execSync('git push origin HEAD', { cwd, encoding: 'utf8' });
}

/**
 * Return repo-relative paths of files with uncommitted changes (M, A, D, etc.).
 */
export function getUncommittedFiles(cwd: string): string[] {
  try {
    const out = execSync('git status --porcelain', { cwd, encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(l => l.slice(3).trim());
  } catch { return []; }
}

/**
 * Remove the markdown link wrapping `target` on or near `lineno`, keeping the link text.
 * Returns true if a replacement was made.
 */
export function delinkAtLine(filepath: string, lineno: number, target: string): boolean {
  try {
    const lines = fs.readFileSync(filepath, 'utf8').split('\n');
    const basename = path.basename(target.split('#')[0]);
    const lo = Math.max(0, lineno - 3);
    const hi = Math.min(lines.length, lineno + 2);

    for (let i = lo; i < hi; i++) {
      if (!lines[i].includes(basename)) { continue; }
      const original = lines[i];

      // [text](…basename…) → text
      let updated = original.replace(
        new RegExp(`\\[([^\\]]+)\\]\\([^)]*${escapeRegex(basename)}[^)]*\\)(?:\\{[^}]*\\})?`, 'g'),
        '$1'
      );
      // <a href="…basename…">text</a> → text
      if (updated === original) {
        updated = original.replace(
          new RegExp(`<a[^>]*href="[^"]*${escapeRegex(basename)}[^"]*"[^>]*>([^<]*)<\\/a>`, 'g'),
          '$1'
        );
      }
      // Orphaned {target="_blank"} left after link removal
      updated = updated.replace(/(?<!\))\{target="_blank"\}/g, '');

      if (updated !== original) {
        lines[i] = updated;
        fs.writeFileSync(filepath, lines.join('\n'), 'utf8');
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Replace a single line in a file. Verifies the existing content matches
 * `before` to avoid blind overwrites. Returns true if the replacement was made.
 */
export function applyLineFix(filepath: string, lineno: number, before: string, after: string): boolean {
  try {
    const lines = fs.readFileSync(filepath, 'utf8').split('\n');
    const idx = lineno - 1;
    if (idx < 0 || idx >= lines.length) { return false; }
    if (lines[idx] !== before) { return false; }
    lines[idx] = after;
    fs.writeFileSync(filepath, lines.join('\n'), 'utf8');
    return true;
  } catch { return false; }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
