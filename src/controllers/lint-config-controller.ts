/* eslint-disable @typescript-eslint/naming-convention */
'use strict';

import { ConfigurationTarget, workspace } from 'vscode';
import { showStatusMessage, output, generateTimestamp } from '../lib/common';

// store users markdownlint settings on activation
const markdownlintProperty = 'markdownlint.config';

export function removeBlankLineInsideBlockQuote() {
	const markdownlintData: any = workspace.getConfiguration().inspect(markdownlintProperty);
	// preserve existing markdownlint.config settings if they exist
	if (markdownlintData.globalValue) {
		const existingUserSettings = markdownlintData.globalValue;
		Object.assign(existingUserSettings, { MD028: false });
		workspace
			.getConfiguration()
			.update(markdownlintProperty, existingUserSettings, ConfigurationTarget.Global);
		showStatusMessage(`disabled MD028 rule in Markdownlint config setting.`);
	}
	// add md028 property and front_matter_title property directly (no existing settings)
	if (!markdownlintData.globalValue) {
		const blankLineInsideBlockQuoterParameter = { MD028: false };
		workspace
			.getConfiguration()
			.update(
				markdownlintProperty,
				blankLineInsideBlockQuoterParameter,
				ConfigurationTarget.Global
			);
		showStatusMessage(`disabled MD028 rule in Markdownlint config setting.`);
	}
}

export function addFrontMatterTitle() {
	const markdownlintData: any = workspace.getConfiguration().inspect(markdownlintProperty);
	const addFrontMatterTitleSetting = workspace.getConfiguration('markdown').addFrontMatterTitle;
	// preserve existing markdownlint.config settings if they exist
	if (markdownlintData.globalValue && addFrontMatterTitleSetting) {
		const existingUserSettings = markdownlintData.globalValue;
		Object.assign(existingUserSettings, { MD025: { front_matter_title: '' } });
		workspace
			.getConfiguration()
			.update(markdownlintProperty, existingUserSettings, ConfigurationTarget.Global);
		showStatusMessage(`Added front_matter_title property to Markdownlint config setting.`);
	}
	// add md025 property and front_matter_title property directly (no existing settings)
	if (!markdownlintData.globalValue && addFrontMatterTitleSetting) {
		const frontMatterParameter = { MD025: { front_matter_title: '' } };
		workspace
			.getConfiguration()
			.update(markdownlintProperty, frontMatterParameter, ConfigurationTarget.Global);
		showStatusMessage(`Added front_matter_title property to Markdownlint config setting.`);
	}
	// let user know that markdownlint.config file will not be updated
	if (!addFrontMatterTitleSetting) {
		showStatusMessage(
			`The addFrontMatterTitleSetting value is set to false.  MD025 rule will not be updated.`
		);
	}
}


const DEFAULT_MARKDOWNLINT_CONFIG = {
    "line-length": false,
    "AM001": false,
    "AM009": false,
    "AM011": false,
    "MD003": {
      "style": "atx"
    },
    "MD004": {
      "style": "consistent"
    },
    "MD007": {
      "indent": 4
    },
    "MD009": false,
    "MD012": false,
    "MD014": false,
    "MD024": false,
    "MD025": {
      "front_matter_title": ""
    },
    "MD026": false,
    "MD027": false,
    "MD028": false,
    "MD030": {
      "ul_multi": 3,
      "ol_multi": 2
    },
    "MD033": {
      "allowed_elements": [
        "a",
        "b",
        "br",
        "caption",
        "code",
        "col",
        "colgroup",
        "div",
        "em",
        "I",
        "img",
        "li",
        "ol",
        "p",
        "pre",
        "s",
        "span",
        "strong",
        "sub",
        "sup",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "u",
        "ul"
      ]
    },
    "MD036": false,
    "MD038": false,
    "MD039": false,
    "MD040": false,
    "MD045": false
};

/**
 * Method to check for the markdownlint.config property and add workspace settings if they do not exist.
 * Writes to workspace scope only — never touches the user's global settings.
 */
export function checkMarkdownlintConfigSettings() {
	const {msTimeValue} = generateTimestamp();
	const configProperty = 'markdownlint.config';
	const configPropertyData: any = workspace.getConfiguration().inspect(configProperty);
	const customLintConfig = DEFAULT_MARKDOWNLINT_CONFIG;

	if (!configPropertyData) {
		return;
	}

	// If workspace-level settings already exist, leave them alone.
	if (configPropertyData.workspaceValue) {
		output.appendLine(
			`[${msTimeValue}] - Workspace has existing markdownlint.config settings. No changes made.`
		);
		return;
	}

	// Only write if there is an open workspace folder to write into.
	if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
		output.appendLine(
			`[${msTimeValue}] - No workspace folder open. Skipping markdownlint.config setup.`
		);
		return;
	}

	workspace
		.getConfiguration()
		.update(configProperty, customLintConfig, ConfigurationTarget.Workspace);
	output.appendLine(
		`[${msTimeValue}] - Adobe default markdownlint config settings added to workspace settings.`
	);
}


/**
 * Method to check for the docs custom markdownlint value.
 * Checks for markdownlint.customRules property. Writes to workspace scope only —
 * never touches the user's global settings.
 */
export function checkMarkdownlintCustomProperty() {
	const { msTimeValue } = generateTimestamp();
	const customProperty = 'markdownlint.customRules';
	const customRuleset = '{adobeexl.adobe-markdown-authoring}/markdownlint-custom-rules/rules.js';
	const customPropertyData: any = workspace.getConfiguration().inspect(customProperty);

	if (!customPropertyData) {
		return;
	}

	// Only write if there is an open workspace folder to write into.
	if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
		output.appendLine(
			`[${msTimeValue}] - No workspace folder open. Skipping markdownlint.customRules setup.`
		);
		return;
	}

	// Collect existing workspace-level custom rules (not global).
	const existingWorkspaceRules: string[] = [];
	if (customPropertyData.workspaceValue) {
		const workspaceValues: string[] = Array.isArray(customPropertyData.workspaceValue)
			? customPropertyData.workspaceValue
			: String(customPropertyData.workspaceValue).split(',');
		workspaceValues.forEach((setting: string) => {
			existingWorkspaceRules.push(setting.trim());
		});
	}

	if (existingWorkspaceRules.indexOf(customRuleset) > -1) {
		output.appendLine(
			`[${msTimeValue}] - Adobe custom markdownlint ruleset already present in workspace settings.`
		);
		return;
	}

	// Add our ruleset to workspace settings.
	existingWorkspaceRules.push(customRuleset);
	workspace
		.getConfiguration()
		.update(customProperty, existingWorkspaceRules, ConfigurationTarget.Workspace);
	output.appendLine(
		`[${msTimeValue}] - Adobe custom markdownlint ruleset added to workspace settings.`
	);
}
