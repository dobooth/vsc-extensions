// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
  ExtensionContext,
  workspace,
  commands,
  window,
  WorkspaceFolder,
} from 'vscode';
import { JenkinsPanelProvider } from './panels/jenkins-panel';

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
    commands.executeCommand(
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

  const jenkinsProvider = new JenkinsPanelProvider(context);
  context.subscriptions.push(
    (window as any).registerWebviewViewProvider('adobeExl.jenkinsPanel', jenkinsProvider)
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

      // Transform Adobe-flavored alert blockquotes into styled divs.
      //   >[!NOTE]  → <div class="extension note" data-label="NOTE">…</div>
      // The docs.css .extension.* rules apply Spectrum colours; adobe-preview.css
      // uses data-label for the visible type label via ::before { content: attr(data-label) }.
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

          // Inspect the first inline token inside the blockquote for [!TYPE].
          let alertType: {cls: string, label: string} | null = null;
          let typeParaOpen = -1;
          let typeParaClose = -1;
          for (let j = i + 1; j < closeIdx; j++) {
            if (tokens[j].type !== 'inline') { continue; }
            const m = /^\[!([\w]+)\]\s*$/.exec(tokens[j].content.trim());
            if (m && alertTypes[m[1]]) {
              alertType = alertTypes[m[1]];
              if (tokens[j - 1]?.type === 'paragraph_open') { typeParaOpen = j - 1; }
              if (tokens[j + 1]?.type === 'paragraph_close') { typeParaClose = j + 1; }
            }
            break; // Only check the first inline token.
          }
          if (!alertType) { continue; }

          // Replace blockquote_close first (highest index — safe to modify first).
          tokens[closeIdx].type = 'html_block';
          tokens[closeIdx].content = '</div>';
          tokens[closeIdx].tag = '';

          // Remove the [!TYPE] paragraph (paragraph_open + inline + paragraph_close).
          if (typeParaOpen >= 0 && typeParaClose >= 0) {
            tokens.splice(typeParaOpen, typeParaClose - typeParaOpen + 1);
          }

          // Replace blockquote_open with the opening div (data-label drives the ::before label).
          tokens[i].type = 'html_block';
          tokens[i].content = `<div class="extension ${alertType.cls}" data-label="${alertType.label}">`;
          tokens[i].tag = '';
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

      return md;
    },
  };
}
