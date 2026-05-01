# Adobe Experience League Markdown Authoring

A Visual Studio Code extension for authoring Adobe Experience League documentation. It enhances the built-in Markdown preview with Adobe-flavored syntax and adds a Build Monitor panel for PR status visibility.

**Note:** The Markdown Preview Enhanced extension deletes the Right Click > Open Preview option. Disable or uninstall that extension to see the new preview.

## Features

### Adobe Markdown preview

Renders EXL-specific Markdown extensions in the VS Code preview panel:

- Alert blocks: `>[!NOTE]`, `>[!TIP]`, `>[!IMPORTANT]`, `>[!WARNING]`, `>[!CAUTION]`, and more
- Shade boxes: `>[!BEGINSHADEBOX]` / `>[!ENDSHADEBOX]`
- Tabs: `>[!BEGINTABS]` / `>[!TAB Label]` / `>[!ENDTABS]`
- Collapsible sections: `+++Title` / `+++`
- Hides Contextual Help
- Embedded video: `>[!VIDEO](url)`
- Inline badges: `[!BADGE Label]{type=Informative}`
- Localization macros: `[!DNL product]`, `[!UICONTROL label]`
- Prism syntax highlighting for code blocks (JavaScript, TypeScript, JSON, Bash, Python, SQL, YAML, and more)

**To see all supported syntax in action:** open [preview-test.md](preview-test.md), right-click on the file name tab and Open Preview.

### GitHub Actions CI Monitor

Note: This feature is still under development.

A sidebar panel (Activity Bar) for monitoring GitHub Actions CI builds without leaving VS Code.

**Setup:** It should pick up your GHEC account automatically. Authenticate with the GitHub CLI (`gh auth login`) if it does not.

**Tabs:**

- **Status** — Shows recent workflow run results with error counts. Lists markdownlint and spelling errors from the latest failed run with inline fix options. Apply individual fixes and commit directly from the panel.
- **Build** — Pipeline view with push, auto-fix, and rerun actions. Displays live build progress and history.

#### Auto-fix

The panel can automatically fix a wide range of common EXL markdown violations without leaving VS Code. Supported rules include:

| Rule | Fix applied |
| --- | --- |
| AM007 | Anchor tag `{[id]}` → `{#id}` |
| AM009 | Malformed Adobe block — corrects or adds the `>` prefix |
| AM011 / AM019 | Space between `]` and `(` in link syntax |
| AM013 | Four-or-more backtick fence → three backticks |
| MD001 | Heading level adjusted to expected depth |
| MD004 | Asterisk list marker `*` → dash `-` |
| MD009 | Trailing spaces removed |
| MD010 | Hard tabs → two spaces |
| MD018 | Missing space after `#` in ATX heading |
| MD019 | Multiple spaces after `#` in ATX heading |
| MD022 | Blank line inserted before heading |
| MD023 | Leading whitespace removed from heading |
| MD029 | Ordered list item prefix normalized to `1.` |
| MD031 / MD032 | Blank line inserted before fenced block or list |
| MD047 | Trailing newline appended to file |

Unfixable errors are surfaced as VS Code diagnostics in the **Problems** panel, making them visible to AI coding assistants (GitHub Copilot, Cursor, Claude Code).

#### Local lint

Version 2 uses the updated Adobe markdown linting rules.
The panel also runs cspell against your locally changed files on every refresh, catching issues before you push. The spell checker is pre-configured to ignore EXL macro syntax.

### Markdown shortcuts

Keyboard shortcuts for common EXL authoring tasks.

| Command | Description | Default key binding |
| --- | --- | --- |
| md-shortcut.showCommandPalette | Display all commands | ctrl+M ctrl+M |
| md-shortcut.toggleBold | Make **bold** | ctrl+B |
| md-shortcut.toggleItalic | Make _italic_ | ctrl+I |
| md-shortcut.toggleLink | Make a hyperlink | ctrl+L |
| md-shortcut.toggleImage | Insert image | ctrl+shift+L |
| md-shortcut.toggleCodeBlock | Insert code block | ctrl+M ctrl+C |
| md-shortcut.toggleInlineCode | Inline code | ctrl+M ctrl+I |
| md-shortcut.toggleBullets | Bullet list | ctrl+M ctrl+B |
| md-shortcut.toggleNumbers | Numbered list | ctrl+M ctrl+1 |
| md-shortcut.toggleNote | `>[!NOTE]` block | ctrl+M ctrl+N |
| md-shortcut.toggleTip | `>[!TIP]` block | ctrl+M ctrl+T |
| md-shortcut.toggleCaution | `>[!CAUTION]` block | ctrl+M ctrl+C |
| md-shortcut.toggleImportant | `>[!IMPORTANT]` block | ctrl+M ctrl+P |
| md-shortcut.toggleWarning | `>[!WARNING]` block | ctrl+M ctrl+W |
| md-shortcut.toggleVideo | `>[!VIDEO]` block | ctrl+M ctrl+V |
| md-shortcut.toggleDNL | `[!DNL]` macro | ctrl+M ctrl+D |
| md-shortcut.toggleUIControl | `[!UICONTROL]` macro | ctrl+M ctrl+U |
| md-shortcut.toggleTabs | `>[!BEGINTABS]` block | — |
| md-shortcut.toggleShadebox | `>[!BEGINSHADEBOX]` block | — |
| md-shortcut.toggleCollapsible | `+++` collapsible section | — |

### Markdown lint validation

Validates EXL Markdown on save using [markdownlint](https://github.com/DavidAnson/markdownlint) with Adobe-specific custom rules (AM001, AM009, AM011, etc.). Default rules are applied on first run; override them in **Preferences > Settings > markdownlint**.

## Installation

Install from the Visual Studio Code Marketplace, or install the `.vsix` directly via **Extensions > Install from VSIX**.

Requires VS Code 1.44.0 or higher.

## More information

- [Adobe Contributor Guide](https://experienceleague.adobe.com/en/docs/contributor/contributor-guide/introduction)
- [Adobe Markdown Authoring Guide](https://experienceleague.adobe.com/en/docs/authoring-guide/using/home)
- [markdownlint](https://github.com/DavidAnson/markdownlint)
