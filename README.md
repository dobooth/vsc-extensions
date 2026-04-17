# Adobe Experience League Markdown Authoring

A Visual Studio Code extension for authoring Adobe Experience League documentation. It enhances the built-in Markdown preview with Adobe-flavored syntax and adds a Jenkins Build Monitor panel for CI/CD visibility.

## Features

### Adobe Markdown preview

Renders EXL-specific Markdown extensions in the VS Code preview panel:

- Alert blocks: `>[!NOTE]`, `>[!TIP]`, `>[!IMPORTANT]`, `>[!WARNING]`, `>[!CAUTION]`, and more
- Shade boxes: `>[!BEGINSHADEBOX]` / `>[!ENDSHADEBOX]`
- Tabs: `>[!BEGINTABS]` / `>[!TAB Label]` / `>[!ENDTABS]`
- Collapsible sections: `+++Title` / `+++`
- Embedded video: `>[!VIDEO](url)`
- Inline badges: `[!BADGE Label]{type=Informative}`
- Localization macros: `[!DNL product]`, `[!UICONTROL label]`
- Prism syntax highlighting for code blocks (JavaScript, TypeScript, JSON, Bash, Python, SQL, YAML, and more)

**To see all supported syntax in action:** open [preview-test.md](preview-test.md) and run **Markdown: Open Preview to the Side** (`Ctrl+K V`).

### Jenkins Build Monitor

A sidebar panel (Activity Bar) for monitoring Jenkins CI builds without leaving VS Code.

**Setup:** Open the Jenkins panel, enter your `username:api-token` credential, and save. Credentials are stored in VS Code's SecretStorage (never on disk). To get an API token, visit `https://docs.ci.corp.adobe.com/user/<your-username>/configure`.

**Tabs:**

- **Status** — Shows the latest review and prod build results with error counts. Lists build errors from the review job with inline fix options (auto path-fix or de-link).
- **Build** — Pipeline view showing the full flow: Branch → Merge & Push → Review build → Promote → Prod build. Displays build progress and history.
- **Other Errors** — Future errors and broken external links from the Jenkins reporting jobs (`FutureErrorsCheckExl`, `LinkCheckExl`). Click any file path to open it at the relevant line.

**Build types:**

- **Review build** (`{repo}_review-exl`) — Triggered when a branch is pushed to the `review` branch. Validates internal links, structure, and EXL-specific rules.
- **Prod build** (`{repo}_exl`) — Triggered after a PR merges to the default branch. Publishes to Experience League.

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

### Markdown lint validation

Validates EXL Markdown on save using [markdownlint](https://github.com/DavidAnson/markdownlint) with Adobe-specific custom rules (AM001, AM009, AM011, etc.). Default rules are applied on first run; override them in **Preferences > Settings > markdownlint**.

## Installation

Install from the Visual Studio Code Marketplace, or install the `.vsix` directly via **Extensions > Install from VSIX**.

Requires VS Code 1.44.0 or higher.

## More information

- [Adobe Contributor Guide](https://experienceleague.adobe.com/en/docs/contributor/contributor-guide/introduction)
- [Adobe Markdown Syntax Style Guide](https://experienceleague.adobe.com/en/docs/contributor/contributor-guide/writing-essentials/markdown)
- [markdownlint](https://github.com/DavidAnson/markdownlint)
