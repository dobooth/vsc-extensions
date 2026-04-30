import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import type { BuildError } from './ghec-service';
// markdownlint ships CommonJS only — no ESM entry point available
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const markdownlint = require('markdownlint');

export function runLocalLint(
  repoRoot: string,
  extensionPath: string,
  changedFiles: string[]
): BuildError[] {
  const mdFiles = changedFiles.filter(f => f.endsWith('.md'));
  if (mdFiles.length === 0) { return []; }

  const errors: BuildError[] = [];

  // ── markdownlint ────────────────────────────────────────────────────────────
  try {
    const configPath = path.join(repoRoot, '.markdownlint.json');
    const config = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
      : { MD013: false };

    const rulesPath = path.join(extensionPath, 'markdownlint-custom-rules', 'rules.js');
    const customRules = fs.existsSync(rulesPath) ? require(rulesPath) : [];

    const absFiles = mdFiles.map(f => path.join(repoRoot, f));
    const results = markdownlint.sync({ files: absFiles, config, customRules });

    for (const [absFile, fileErrors] of Object.entries(results) as [string, any[]][]) {
      const relFile = path.relative(repoRoot, absFile).replace(/\\/g, '/');
      for (const e of fileErrors) {
        const rule = (e.ruleNames as string[]).join('/');
        const detail = e.errorDetail ? ': ' + e.errorDetail : '';
        errors.push({
          filepath: relFile,
          lineno: String(e.lineNumber ?? 1),
          rule,
          reason: (e.ruleDescription ?? rule) + detail,
          target: '',
          active: true,
          fixStatus: 'unknown',
          source: 'local',
        });
      }
    }
  } catch (e) { console.debug('[local-lint] markdownlint skipped:', e); }

  // ── cspell ──────────────────────────────────────────────────────────────────
  try {
    const absFiles = mdFiles.map(f => path.join(repoRoot, f));
    const wordsFile = path.join(extensionPath, 'assets', 'cspell-exl-words.txt');
    const args = [
      '--no-progress', '--no-summary', '--no-color',
      '--ignore-regexp', '`[^`\\n]+`',           // inline code
      '--ignore-regexp', 'https?://\\S+',         // URLs
      '--ignore-regexp', '\\[![A-Z][A-Z0-9]*[^\\]]*\\]', // EXL macros [!NOTE] [!DNL ...] etc.
      '--ignore-regexp', '\\{[^}]+\\}',           // attribute blocks {#id} {width="640"}
      ...(fs.existsSync(wordsFile) ? ['--words-only', '--user-words-file', wordsFile] : []),
      ...absFiles,
    ];
    const result = spawnSync('cspell', args, { cwd: repoRoot, encoding: 'utf8' });

    for (const line of (result.stdout || '').split('\n')) {
      // cspell output: /abs/path/file.md:14:7 - Unknown word (someword)
      // The separator is " - " but locale may vary; match flexibly on the colon-number-number prefix.
      const m = line.match(/^(.+?):(\d+):\d+\s+-\s+(.+)$/);
      if (!m) { continue; }
      const relFile = path.relative(repoRoot, m[1]).replace(/\\/g, '/');
      errors.push({
        filepath: relFile,
        lineno: m[2],
        rule: 'SPELL',
        reason: m[3],
        target: '',
        active: true,
        fixStatus: 'unknown',
        source: 'local',
      });
    }
  } catch (e) { console.debug('[local-lint] cspell skipped:', e); }

  return errors;
}
