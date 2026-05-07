// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
  ExtensionContext,
  workspace,
  commands,
  window,
  ConfigurationTarget,
} from 'vscode';
import { GhecPanelProvider } from './panels/ghec-panel';
import { AdobePreviewManager } from './panels/adobe-preview-panel';

import {
	checkMarkdownlintCustomProperty,checkMarkdownlintConfigSettings
} from './controllers/lint-config-controller';
import { generateTimestamp, output } from './lib/common';
import { register } from './lib/commands';
import { findAndReplaceTargetExpressions } from './lib/utiity';

const AFM_TOKEN_RULES = [
  {
    scope: [
      'punctuation.definition.afm.begin.markdown',
      'punctuation.definition.afm.end.markdown',
      'punctuation.definition.afm.attributes.begin.markdown',
      'punctuation.definition.afm.attributes.end.markdown',
      'punctuation.definition.afm.video-url.begin.markdown',
      'punctuation.definition.afm.video-url.end.markdown',
      'keyword.other.afm.macro.markdown',
    ],
    settings: { foreground: '#999999' },
  },
  {
    scope: [
      'keyword.other.afm.admonition.informative.markdown',
      'string.quoted.double.afm.value.admonition.informative.markdown',
      'string.unquoted.afm.value.admonition.informative.markdown',
    ],
    settings: { foreground: '#1473E6', fontStyle: 'bold' },
  },
  {
    scope: [
      'keyword.other.afm.admonition.positive.markdown',
      'string.quoted.double.afm.value.admonition.positive.markdown',
      'string.unquoted.afm.value.admonition.positive.markdown',
    ],
    settings: { foreground: '#268E6C', fontStyle: 'bold' },
  },
  {
    scope: [
      'keyword.other.afm.admonition.caution.markdown',
      'string.quoted.double.afm.value.admonition.caution.markdown',
      'string.unquoted.afm.value.admonition.caution.markdown',
    ],
    settings: { foreground: '#C07B15', fontStyle: 'bold' },
  },
  {
    scope: [
      'keyword.other.afm.admonition.negative.markdown',
      'string.quoted.double.afm.value.admonition.negative.markdown',
      'string.unquoted.afm.value.admonition.negative.markdown',
    ],
    settings: { foreground: '#D7373F', fontStyle: 'bold' },
  },
  {
    scope: [
      'keyword.other.afm.admonition.neutral.markdown',
      'string.quoted.double.afm.value.admonition.neutral.markdown',
      'string.unquoted.afm.value.admonition.neutral.markdown',
    ],
    settings: { foreground: '#767676', fontStyle: 'bold' },
  },
  {
    scope: [
      'keyword.other.afm.tag.markdown',
      'string.quoted.double.afm.value.markdown',
      'string.unquoted.afm.value.markdown',
      'string.unquoted.afm.collapsible.title.markdown',
    ],
    settings: { foreground: '#5C6BC0' },
  },
  {
    scope: 'keyword.other.afm.collapsible.markdown',
    settings: { foreground: '#7B61FF', fontStyle: 'bold' },
  },
  {
    scope: 'string.other.link.afm.value.markdown',
    settings: { foreground: '#1473E6' },
  },
  {
    scope: 'entity.other.attribute-name.afm.markdown',
    settings: { foreground: '#5C6BC0' },
  },
  {
    scope: 'string.unquoted.afm.attribute-value.markdown',
    settings: { foreground: '#267F99' },
  },
];

async function ensureAfmTokenColors(): Promise<void> {
  const config = workspace.getConfiguration('editor');
  const current = (config.get<Record<string, any>>('tokenColorCustomizations')) ?? {};
  const existing: any[] = current.textMateRules ?? [];
  const filtered = existing.filter((rule: any) => {
    const scopes: string[] = Array.isArray(rule.scope) ? rule.scope : [rule.scope ?? ''];
    return !scopes.some((s: string) => s.includes('.afm.'));
  });
  await config.update(
    'tokenColorCustomizations',
    { ...current, textMateRules: [...filtered, ...AFM_TOKEN_RULES] },
    ConfigurationTarget.Global
  );
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  var extensionPath: string = context.extensionPath;
  const { msTimeValue } = generateTimestamp();
  output.appendLine(
    `[${msTimeValue}] - Activating Adobe Flavored Markdown extension at ${extensionPath}`
  );
  void ensureAfmTokenColors();
  
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
  workspace.onDidChangeTextDocument(
    findAndReplaceTargetExpressions,
    null,
    context.subscriptions
  );

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

  const adobePreview = new AdobePreviewManager(context);
  context.subscriptions.push(adobePreview);
  context.subscriptions.push(
    commands.registerCommand('adobeExl.openAdobePreview', () => adobePreview.show())
  );
  context.subscriptions.push(
    commands.registerCommand(
      'adobeExl.openAdobePreviewDeveloperTools',
      async () => {
        try {
          await commands.executeCommand(
            'workbench.action.webview.openDeveloperTools'
          );
        } catch {
          void window.showWarningMessage(
            'Could not open webview DevTools from the extension. Focus the Adobe Preview panel, then run **Developer: Open Webview Developer Tools** from the Command Palette.'
          );
        }
      }
    )
  );

  const ghecProvider = new GhecPanelProvider(context);
  context.subscriptions.push(
    window.registerWebviewViewProvider('adobeExl.ghecPanel', ghecProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}
