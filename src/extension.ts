// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
  ExtensionContext,
  workspace,
  commands,
  window,
  WorkspaceFolder,
} from 'vscode';
import { GhecPanelProvider } from './panels/ghec-panel';

import {
	checkMarkdownlintCustomProperty,checkMarkdownlintConfigSettings
} from './controllers/lint-config-controller';
import { generateTimestamp, output } from './lib/common';
import { register } from './lib/commands';
import MarkdownIt = require('markdown-it');

import * as fs from 'fs';
import * as path from 'path';
import { findAndReplaceTargetExpressions } from './lib/utiity';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  var extensionPath: string = context.extensionPath;
  const { msTimeValue } = generateTimestamp();
  output.appendLine(
    `[${msTimeValue}] - Activating Adobe Flavored Markdown extension at ${extensionPath}`
  );
  
  output.appendLine(`[${msTimeValue}] - Activating docs linting extension.`);
  // Markdown Lint custom rule check
  checkMarkdownlintCustomProperty();
  // Markdown Lint config check
  checkMarkdownlintConfigSettings();

  // Markdown Shortcuts
  function buildLanguageRegex(): RegExp {
    const languageArray: string[] | undefined = workspace
      .getConfiguration('markdown')
      .get('languages') || ['markdown'];
    return new RegExp('(' + languageArray.join('|') + ')');
  }

  function togglemarkdown(langId: string) {
    void commands.executeCommand(
      'setContext',
      'markdown:enabled',
      languageRegex.test(langId)
    );
  }

  // Execute on activate
  let languageRegex = buildLanguageRegex();
  let activeEditor = window.activeTextEditor;
  if (activeEditor) {
    togglemarkdown(activeEditor.document.languageId);
  }

  // Update languageRegex if the configuration changes
  workspace.onDidChangeConfiguration(
    (configChange) => {
      if (configChange.affectsConfiguration('markdown.languages')) {
        languageRegex = buildLanguageRegex();
      }
    },
    null,
    context.subscriptions
  );

  // Enable/disable markdown
  window.onDidChangeActiveTextEditor(
    (editor) => {
      activeEditor = editor;
      if (activeEditor) {
        togglemarkdown(activeEditor.document.languageId);
      }
    },
    null,
    context.subscriptions
  );

	// When the document changes, find and replace target expressions (for example, smart quotes).
	workspace.onDidChangeTextDocument(findAndReplaceTargetExpressions);

  // Triggered with language id change
  workspace.onDidOpenTextDocument(
    (document) => {
      if (activeEditor && activeEditor.document === document) {
        togglemarkdown(activeEditor.document.languageId);
      }
    },
    null,
    context.subscriptions
  );

  register(context);
  output.appendLine(`[${msTimeValue}] - Registered markdown shortcuts`);

  const ghecProvider = new GhecPanelProvider(context);
  context.subscriptions.push(
    (window as any).registerWebviewViewProvider('adobeExl.ghecPanel', ghecProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // /**
  //  * Function to compute the relative path between src and tgt without regard
  //  * to the current working directory.  The built-in path.relative() function
  //  * uses the CWD as a base, which cannot be changed. Weird that we have to
  //  * do this.
  //  *
  //  * @param {string} src
  //  * @param {string} tgt
  //  * @return {*}  {string}
  //  */
  function relativePath(src: string, tgt: string): string {
    const srcelts: string[] = src.split('/');
    const tgtelts: string[] = tgt.split('/');
    // Find the offset in tgt where folder paths are no longer the same.
    let srcelt: string | undefined = srcelts.shift();
    let tgtelt: string | undefined = tgtelts.shift();
    while (srcelt !== undefined && tgtelt !== undefined && srcelt === tgtelt) {
      srcelt = srcelts.shift();
      tgtelt = tgtelts.shift();
    }
    let popups = Math.max(tgtelts.length - srcelts.length - 1, 0);
    const fname = ''
      .concat('../'.repeat(popups))
      .concat(tgtelt || '')
      .concat('/')
      .concat(tgtelts.join('/'));
    return fname;
  }

  /**
   * Given a link file path, return the path relative to the current workspace folder.
   */
  function makeRelativeLink(link: string): string {
    // If link is a url, return it.
    if (link.startsWith('http') || link.startsWith('https')) {
      return link;
    }
    // Get list of folders in the current workspace.
    const folders = workspace.workspaceFolders;
    // Get the current file.
    const currentFile: string | undefined =
      activeEditor && activeEditor.document.fileName;
    if (!currentFile) {
      output.appendLine(
        `[${msTimeValue}] - No current editor to compute relative links.`
      );
      return link;
    }
    output.appendLine(
      `[${msTimeValue}] - Current editor file path is: ${currentFile}`
    );
    let relpath: string = link;
    if (fs.existsSync(link)) {
      relpath = relativePath(currentFile, link);
      output.appendLine(
        `[${msTimeValue}] - Resolved absolute link path ${link} .`
      );
    } else {
      output.appendLine(
        `[${msTimeValue}] - Attempting to resolve relative path: ${relpath}`
      );
      if (folders) {
        folders.forEach((folder: WorkspaceFolder) => {
          link = path.join(folder.uri.path, link);
          if (fs.existsSync(link)) {
            output.appendLine(
              `[${msTimeValue}] - Absolute path found, and exists. ${link}`
            );
            relpath = relativePath(currentFile, link);
            output.appendLine(
              `[${msTimeValue}] - Resolved relative path: ${relpath}`
            );
            if (fs.existsSync(relpath)) {
              output.appendLine(
                `[${msTimeValue}] - Resolved relative path exists. ${relpath}`
              );
            } else {
              output.appendLine(
                `[${msTimeValue}] - Resolved relative path does not exist. ${relpath}`
              );
            }
          } else {
            output.appendLine(
              `[${msTimeValue}] - Link Path ${link} does not exist.`
            );
          }
        });
      }
    }
    output.appendLine(
      `[${msTimeValue}] - Relative path resolved to: ${relpath}.`
    );
    return relpath;
  }
  return {
    extendMarkdownIt(md: MarkdownIt) {
      output.appendLine(
        `[${msTimeValue}] - Markdown-it plugin options are ${JSON.stringify(
          md.options
        )}`
      );

      md.use(require('markdown-it-replace-link'), {
        replaceLink: function (link: string, _env: any) {
          return makeRelativeLink(link);
        },
      });

      // HTML-escape helper used throughout the inline token builders.
      const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // Adobe inline tags: strip the wrapper, render text content only.
      //   [!DNL Marketo]      → Marketo   (do-not-localize; purely a translation directive)
      //   [!UICONTROL Save]   → Save      (UI label; purely a translation directive)
      //
      // We register these before the built-in 'link' rule so that markdown-it
      // never misinterprets [ as the start of a link.
      const adobeInlineRule = (tag: string) => {
        const re = new RegExp('^\\[!' + tag + '\\s+([^\\]]+)\\]');
        return function (state: any, silent: boolean): boolean {
          if (state.src.charCodeAt(state.pos) !== 0x5B /* [ */) { return false; }
          const m = re.exec(state.src.slice(state.pos));
          if (!m) { return false; }
          if (!silent) {
            const token = state.push('text', '', 0);
            token.content = m[1];
          }
          state.pos += m[0].length;
          return true;
        };
      };
      md.inline.ruler.before('link', 'adobe-dnl', adobeInlineRule('DNL'));
      md.inline.ruler.before('link', 'adobe-uicontrol', adobeInlineRule('UICONTROL'));

      // Inline badge: [!BADGE text]{type=Informative url="..." tooltip="..."}
      // Types: Informative (blue), Positive (green), Negative (red), Neutral (gray), Caution (yellow)
      md.inline.ruler.before('link', 'adobe-badge', function (state: any, silent: boolean): boolean {
        if (state.src.charCodeAt(state.pos) !== 0x5B /* [ */) { return false; }
        const m = /^\[!BADGE\s+([^\]]+)\](?:\{([^}]*)\})?/.exec(state.src.slice(state.pos));
        if (!m) { return false; }
        if (!silent) {
          const text = m[1].trim();
          const attrs = m[2] || '';
          const typeMatch = /type=(\w+)/i.exec(attrs);
          const badgeType = (typeMatch ? typeMatch[1] : 'Informative').toLowerCase();
          const typeClass: {[k: string]: string} = {
            informative: 'badge-informative',
            positive:    'badge-positive',
            negative:    'badge-negative',
            neutral:     'badge-neutral',
            caution:     'badge-caution',
          };
          const cls = typeClass[badgeType] || 'badge-informative';
          const urlMatch     = /url="([^"]*)"/.exec(attrs);
          const tooltipMatch = /tooltip="([^"]*)"/.exec(attrs);
          const url     = urlMatch     ? urlMatch[1]     : '';
          const tooltip = tooltipMatch ? tooltipMatch[1] : '';
          const tipAttr = tooltip ? ` title="${esc(tooltip)}"` : '';
          const safeText = esc(text);
          let html: string;
          if (url) {
            html = `<a href="${esc(url)}" class="exl-badge ${cls}"${tipAttr}>${safeText}</a>`;
          } else {
            html = `<span class="exl-badge ${cls}"${tipAttr}>${safeText}</span>`;
          }
          const token = state.push('html_inline', '', 0);
          token.content = html;
        }
        state.pos += m[0].length;
        return true;
      });

      // Transform Adobe-flavored blockquotes into styled elements.
      //
      //   Alert types  >[!NOTE]           → <div class="extension note" …>…</div>
      //   Shade boxes  >[!BEGINSHADEBOX]  → <div class="shadebox">…</div>
      //   Tabs         >[!BEGINTABS]      → tab container (JS restructures DOM)
      //   Video        >[!VIDEO](url)     → <div class="exl-video">…</div>
      const alertTypes: {[key: string]: {cls: string, label: string}} = {
        NOTE:           {cls: 'note',           label: 'NOTE'},
        TIP:            {cls: 'tip',            label: 'TIP'},
        IMPORTANT:      {cls: 'important',      label: 'IMPORTANT'},
        WARNING:        {cls: 'warning',        label: 'WARNING'},
        CAUTION:        {cls: 'caution',        label: 'CAUTION'},
        ADMIN:          {cls: 'admin',          label: 'ADMIN'},
        ADMINISTRATION: {cls: 'administration', label: 'ADMIN'},
        AVAILABILITY:   {cls: 'availability',   label: 'AVAILABILITY'},
        PREREQUISITES:  {cls: 'prerequisites',  label: 'PREREQUISITES'},
        INFO:           {cls: 'info',           label: 'INFO'},
        ERROR:          {cls: 'error',          label: 'ERROR'},
        SUCCESS:        {cls: 'success',        label: 'SUCCESS'},
        MORELIKETHIS:   {cls: 'morelikethis',   label: 'More like this'},
      };
      const contextualHelpMarker = /^\[!CONTEXTUALHELP\]\s*$/i;
      const contextualHelpAttrLine = /^[a-z][\w-]*(?:="[^"]*")(?:\s+[a-z][\w-]*="[^"]*")*\s*$/i;

      const isContextualHelpBlock = (tokens: any[], openIdx: number, closeIdx: number): boolean => {
        const lines: string[] = [];
        for (let j = openIdx + 1; j < closeIdx; j++) {
          if (tokens[j].type !== 'inline') { continue; }
          lines.push(...tokens[j].content.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean));
        }
        if (!lines.length || !contextualHelpMarker.test(lines[0])) { return false; }
        return lines.slice(1).every((line) => contextualHelpAttrLine.test(line));
      };

      md.core.ruler.push('adobe-alerts', function (state) {
        const tokens = state.tokens;
        // Iterate in reverse so splice offsets don't disturb earlier unprocessed indices.
        for (let i = tokens.length - 1; i >= 0; i--) {
          if (tokens[i].type !== 'blockquote_open') { continue; }

          // Find the matching blockquote_close (handles nested blockquotes).
          let closeIdx = -1;
          let depth = 0;
          for (let j = i + 1; j < tokens.length; j++) {
            if (tokens[j].type === 'blockquote_open') { depth++; continue; }
            if (tokens[j].type === 'blockquote_close') {
              if (depth === 0) { closeIdx = j; break; }
              depth--;
            }
          }
          if (closeIdx < 0) { continue; }

          // Get the first inline token inside the blockquote and its surrounding paragraph.
          let firstInlineIdx = -1;
          let typeParaOpen   = -1;
          let typeParaClose  = -1;
          for (let j = i + 1; j < closeIdx; j++) {
            if (tokens[j].type !== 'inline') { continue; }
            firstInlineIdx = j;
            if (tokens[j - 1]?.type === 'paragraph_open')  { typeParaOpen  = j - 1; }
            if (tokens[j + 1]?.type === 'paragraph_close') { typeParaClose = j + 1; }
            break; // Only inspect the first inline token.
          }
          if (firstInlineIdx < 0) { continue; }

          const raw = tokens[firstInlineIdx].content.trim();

          // Contextual help is publishing metadata, not article body content.
          if (isContextualHelpBlock(tokens, i, closeIdx)) {
            tokens.splice(i, closeIdx - i + 1);
            continue;
          }

          // Replace blockquote tokens with raw HTML.
          // Order matters: set closeIdx first (highest index), splice middle, set i last.
          const apply = (openHtml: string, closeHtml: string) => {
            tokens[closeIdx].type = 'html_block';
            tokens[closeIdx].content = closeHtml;
            tokens[closeIdx].tag = '';
            if (typeParaOpen >= 0 && typeParaClose >= 0) {
              tokens.splice(typeParaOpen, typeParaClose - typeParaOpen + 1);
            }
            tokens[i].type = 'html_block';
            tokens[i].content = openHtml;
            tokens[i].tag = '';
          };

          // ─── Standard alert types (NOTE, TIP, IMPORTANT, …) ───────────────
          let m: RegExpExecArray | null;
          m = /^\[!([\w]+)\]\s*$/.exec(raw);
          if (m && alertTypes[m[1]]) {
            const at = alertTypes[m[1]];
            apply(`<div class="extension ${at.cls}" data-label="${at.label}">`, '</div>');
            continue;
          }

          // ─── BEGINSHADEBOX ────────────────────────────────────────────────
          m = /^\[!BEGINSHADEBOX(?:\s+"([^"]*)")?\]\s*$/.exec(raw);
          if (m) {
            const title = m[1];
            const titleHtml = title ? `<p class="shadebox-title">${esc(title)}</p>\n` : '';
            apply(`<div class="shadebox">\n${titleHtml}`, '');
            continue;
          }

          // ─── ENDSHADEBOX ──────────────────────────────────────────────────
          if (/^\[!ENDSHADEBOX\]\s*$/.test(raw)) {
            apply('', '</div>\n');
            continue;
          }

          // ─── BEGINTABS ────────────────────────────────────────────────────
          // Emits an open container div; JS in prism-init.js restructures contents
          // into labelled tab panels after the preview renders.
          if (/^\[!BEGINTABS\]\s*$/.test(raw)) {
            apply('<div class="exl-tabs">\n', '');
            continue;
          }

          // ─── TAB ──────────────────────────────────────────────────────────
          m = /^\[!TAB\s+([^\]]+)\]\s*$/.exec(raw);
          if (m) {
            apply(`<div class="exl-tab-start" data-title="${esc(m[1].trim())}"></div>\n`, '');
            continue;
          }

          // ─── ENDTABS ──────────────────────────────────────────────────────
          if (/^\[!ENDTABS\]\s*$/.test(raw)) {
            apply('<div class="exl-tab-end"></div>\n', '</div>\n');
            continue;
          }

          // ─── VIDEO ────────────────────────────────────────────────────────
          m = /^\[!VIDEO\]\(([^)]+)\)\s*$/.exec(raw);
          if (m) {
            const url = m[1].replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            apply(
              `<div class="exl-video"><a class="exl-video-link" href="${url}" target="_blank">▶ Watch video</a></div>\n`,
              ''
            );
            continue;
          }
        }
      });

      // Transform +++ collapsible sections into <details>/<summary>.
      //   +++Title text        →  <details><summary>Title text</summary>
      //   Content here.        →    <p>Content here.</p>
      //   +++                  →  </details>
      md.block.ruler.before('fence', 'collapsible', (state: any, startLine: number, endLine: number, silent: boolean): boolean => {
        const pos = state.bMarks[startLine] + state.tShift[startLine];
        const max = state.eMarks[startLine];
        const lineText = state.src.slice(pos, max).trim();

        if (!lineText.startsWith('+++')) { return false; }
        const title = lineText.slice(3).trim();
        if (!title) { return false; } // bare +++ is a closing marker, not an opener

        // Find the matching closing +++ (alone on its own line)
        let closeIdx = -1;
        for (let i = startLine + 1; i < endLine; i++) {
          const p = state.bMarks[i] + state.tShift[i];
          const m = state.eMarks[i];
          if (state.src.slice(p, m).trim() === '+++') { closeIdx = i; break; }
        }
        if (closeIdx < 0) { return false; }

        if (silent) { return true; }

        const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        let token = state.push('html_block', '', 0);
        token.content = `<details>\n<summary>${safeTitle}</summary>\n`;
        token.map = [startLine, startLine + 1];

        const oldParent  = state.parentType;
        const oldLineMax = state.lineMax;
        state.parentType = 'container';
        state.lineMax    = closeIdx;

        state.md.block.tokenize(state, startLine + 1, closeIdx);

        state.parentType = oldParent;
        state.lineMax    = oldLineMax;

        token = state.push('html_block', '', 0);
        token.content = '</details>\n';
        token.map = [closeIdx, closeIdx + 1];

        state.line = closeIdx + 1;
        return true;
      }, { alt: ['paragraph', 'reference'] });

      // Strip standalone EXL attribute blocks: {style="..."}, {line-numbers="true"}, etc.
      // These appear as lone paragraphs after code fences and tables and have no meaning
      // in VS Code preview — they are publishing directives for the EXL build system.
      md.core.ruler.push('strip_attr_blocks', (state: any) => {
        const tokens = state.tokens;
        for (let i = tokens.length - 3; i >= 0; i--) {
          if (
            tokens[i].type     === 'paragraph_open'  &&
            tokens[i + 1].type === 'inline'           &&
            tokens[i + 2].type === 'paragraph_close'  &&
            /^\{[^}]*\}\s*$/.test(tokens[i + 1].content.trim())
          ) {
            tokens.splice(i, 3);
          }
        }
      });

      return md;
    },
  };
}
