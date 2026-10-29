// The three commands. Thin on purpose: gather inputs from VS Code, call the pure pipeline, show the result.

import * as vscode from 'vscode';
import { noStagedChangesError, generateCommitMessage, generatePrDescription, type PipelineResult, type PipelineStage } from '../core/pipeline';
import { PROVIDER_LABELS } from '../core/settings';
import type { AiProvider, ProviderName } from '../core/types';
import { createRunGit, getGitApi, selectRepository } from './git';
import { getBranchChanges, getStagedDiff } from './gitChanges';
import type { Logger } from './logger';
import { getApiKey, keyNeeded, promptForApiKey } from './secrets';
import { readSettings } from './settings';
import { presentError, runWithProgress, type ProgressReporter } from './ui';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  /** One implementation per vendor; `commitcraft.provider` picks which one receives the diff. */
  providers: Record<ProviderName, AiProvider>;
}

const STAGE_MESSAGES: Record<PipelineStage, string> = {
  preparing: 'Reading and checking your changes…',
  generating: 'Asking Claude…',
};

/** Asks for a key if none is stored. Returns undefined if the user declines or cancels. */
async function ensureApiKey(context: vscode.ExtensionContext, provider: ProviderName): Promise<string | undefined> {
  const existing = await getApiKey(context, provider);
  if (existing) {
    return existing;
  }
  const choice = await vscode.window.showInformationMessage(
    `CommitCraft needs ${keyNeeded(provider)} before it can write messages. It is stored in VS Code SecretStorage.`,
    'Set API Key',
  );
  return choice === 'Set API Key' ? promptForApiKey(context, provider) : undefined;
}

/**
 * The user typed in the message box while the AI was working. Asks before overwriting it. Returns true to
 * replace; "Open in New Tab" keeps their text and shows the generated message in an editor instead.
 */
async function confirmReplaceChangedText(generated: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'The commit message box changed while CommitCraft was working. Replace it with the generated message?',
    { modal: true },
    'Replace',
    'Open in New Tab',
  );
  if (choice === 'Open in New Tab') {
    const document = await vscode.workspace.openTextDocument({ content: generated });
    await vscode.window.showTextDocument(document, { preview: false });
  }
  return choice === 'Replace';
}

/** Shows what was not sent in full, if anything, otherwise a brief confirmation. */
function announce(done: string, result: PipelineResult): void {
  if (result.notices.length > 0) {
    void vscode.window.showInformationMessage(`CommitCraft: ${done} ${result.notices.join(' ')}`);
  } else {
    vscode.window.setStatusBarMessage(`CommitCraft: ${done}`, 4000);
  }
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, logger, providers } = deps;
  let busy = false;

  /** Asks for the key of whichever provider is currently selected. */
  const setApiKey = (): Promise<string | undefined> => promptForApiKey(context, readSettings().provider);

  /** Runs one command body with the shared guard, error presentation and retry button. */
  async function guarded(body: () => Promise<void>): Promise<void> {
    if (busy) {
      void vscode.window.showInformationMessage('CommitCraft is already working on a request. Wait for it to finish or cancel it.');
      return;
    }
    busy = true;
    let failure: { error: unknown } | undefined;
    try {
      await body();
    } catch (error) {
      failure = { error };
    } finally {
      busy = false; // before any message is shown: a toast that stays open must not keep, or later reset, the flag
    }
    if (failure) {
      await presentError(failure.error, { logger, setApiKey, retry: () => guarded(body) });
    }
  }

  async function commitMessageFlow(arg: unknown): Promise<void> {
    const api = await getGitApi();
    const repository = await selectRepository(api, arg);
    if (!repository) {
      return;
    }
    const settings = readSettings(vscode.Uri.file(repository.rootUri.fsPath));
    const apiKey = await ensureApiKey(context, settings.provider);
    if (!apiKey) {
      return;
    }

    const rawDiff = await getStagedDiff(createRunGit(api.git.path, repository.rootUri.fsPath));
    if (rawDiff.trim() === '') {
      throw noStagedChangesError();
    }
    const textAtStart = repository.inputBox.value;
    if (textAtStart.trim() !== '') {
      const choice = await vscode.window.showWarningMessage(
        'The commit message box already has text. Replace it with a generated message?',
        { modal: true },
        'Replace',
      );
      if (choice !== 'Replace') {
        return;
      }
    }

    const result = await runWithProgress('CommitCraft: Generating commit message…', (signal, report: ProgressReporter) =>
      generateCommitMessage({
        rawDiff,
        apiKey,
        provider: providers[settings.provider],
        settings,
        signal,
        onStage: (stage) => report(STAGE_MESSAGES[stage]),
      }),
    );
    if (!result) {
      return;
    }

    if (repository.inputBox.value !== textAtStart && !(await confirmReplaceChangedText(result.text))) {
      return; // the user kept what they typed meanwhile (the message may have been opened in a tab instead)
    }
    repository.inputBox.value = result.text;
    await vscode.commands.executeCommand('workbench.view.scm');
    logger.info(
      `commit message generated: provider=${settings.provider} files=${result.stats.files} redactions=${result.redactions} truncated=${result.stats.truncated}`,
    );
    announce(`Commit message ready (${PROVIDER_LABELS[settings.provider]}). Review and edit it before committing.`, result);
  }

  async function prDescriptionFlow(arg: unknown): Promise<void> {
    const api = await getGitApi();
    const repository = await selectRepository(api, arg);
    if (!repository) {
      return;
    }
    const settings = readSettings(vscode.Uri.file(repository.rootUri.fsPath));
    const apiKey = await ensureApiKey(context, settings.provider);
    if (!apiKey) {
      return;
    }

    const result = await runWithProgress('CommitCraft: Generating PR description…', async (signal, report) => {
      report('Reading branch changes…');
      const changes = await getBranchChanges(
        repository,
        settings.baseBranch,
        createRunGit(api.git.path, repository.rootUri.fsPath, signal),
      );
      return generatePrDescription({
        rawDiff: changes.rawDiff,
        branchName: changes.branchName,
        commitSubjects: changes.commitSubjects,
        totalCommits: changes.totalCommits,
        apiKey,
        provider: providers[settings.provider],
        settings,
        signal,
        onStage: (stage) => report(STAGE_MESSAGES[stage]),
      });
    });
    if (!result) {
      return;
    }

    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: result.text });
    await vscode.window.showTextDocument(document, { preview: false });
    logger.info(
      `PR description generated: provider=${settings.provider} files=${result.stats.files} redactions=${result.redactions} truncated=${result.stats.truncated}`,
    );
    announce(`PR description ready (${PROVIDER_LABELS[settings.provider]}). Review and edit it before using it.`, result);
  }

  return [
    vscode.commands.registerCommand('commitcraft.generateCommitMessage', (arg?: unknown) =>
      guarded(() => commitMessageFlow(arg)),
    ),
    vscode.commands.registerCommand('commitcraft.generatePrDescription', (arg?: unknown) =>
      guarded(() => prDescriptionFlow(arg)),
    ),
    vscode.commands.registerCommand('commitcraft.setApiKey', async () => {
      try {
        await setApiKey();
      } catch (error) {
        await presentError(error, { logger, setApiKey });
      }
    }),
  ];
}
