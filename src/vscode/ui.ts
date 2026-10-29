// User-facing behaviour: progress, and turning errors into clear messages with a next step.

import * as vscode from 'vscode';
import { isCommitCraftError, type CommitCraftErrorCode } from '../core/errors';
import { redact } from '../core/redact';
import type { Logger } from './logger';

/** Situations where nothing is wrong, there is just nothing to do yet: shown as a warning, not an error. */
const NOTHING_TO_DO: ReadonlySet<CommitCraftErrorCode> = new Set([
  'NO_STAGED_CHANGES',
  'NO_BRANCH_CHANGES',
  'ON_BASE_BRANCH',
  'DETACHED_HEAD',
  'NO_REPOSITORY',
  'NO_WORKSPACE',
]);

const RETRYABLE: ReadonlySet<CommitCraftErrorCode> = new Set([
  'RATE_LIMITED',
  'NETWORK',
  'TIMEOUT',
  'EMPTY_RESPONSE',
  'MALFORMED_RESPONSE',
]);

export interface ErrorActions {
  logger: Logger;
  /** Starts the key prompt (used by the "Set API Key" button). */
  setApiKey: () => Promise<unknown>;
  /** Re-runs the command that failed (used by the "Try Again" button). */
  retry?: () => Promise<void>;
}

type Action = { label: string; run: () => Thenable<unknown> | Promise<unknown> | void };

/** What to log about a failure: codes and class names only, never prompts, diffs or keys. */
function logLine(error: unknown): string {
  if (isCommitCraftError(error)) {
    const cause = error.cause;
    const causeName = cause instanceof Error ? cause.name : undefined;
    const { status, exitCode, stderrSummary } = (cause ?? {}) as { status?: unknown; exitCode?: unknown; stderrSummary?: unknown };
    const gitDetail =
      typeof exitCode === 'number' || typeof exitCode === 'string'
        ? `exit ${exitCode}${typeof stderrSummary === 'string' && stderrSummary ? `: ${redact(stderrSummary).text}` : ''}`
        : undefined;
    const detail = [causeName, typeof status === 'number' ? `HTTP ${status}` : undefined, gitDetail].filter(Boolean).join(' ');
    return `${error.code}${detail ? ` (${detail})` : ''}`;
  }
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `UNEXPECTED ${redact(text).text.slice(0, 300)}`;
}

function actionsFor(code: CommitCraftErrorCode, ctx: ErrorActions): Action[] {
  const openSettings = (query: string): Action => ({
    label: 'Open Settings',
    run: () => vscode.commands.executeCommand('workbench.action.openSettings', query),
  });
  const showLog: Action = { label: 'Show Log', run: () => ctx.logger.show() };
  const tryAgain: Action[] = ctx.retry ? [{ label: 'Try Again', run: ctx.retry }] : [];

  switch (code) {
    case 'INVALID_API_KEY':
      return [{ label: 'Set API Key', run: ctx.setApiKey }];
    case 'INVALID_SETTING':
    case 'BASE_BRANCH_NOT_FOUND':
      return [openSettings('commitcraft.baseBranch')];
    case 'MODEL_NOT_FOUND':
      return [openSettings('commitcraft.model')];
    case 'GIT_ERROR':
      return [showLog];
    case 'PROVIDER_ERROR':
      return [...tryAgain, showLog];
    default:
      return RETRYABLE.has(code) ? tryAgain : [];
  }
}

/** Shows a failure to the user: what happened, what to do, and a button for the obvious next step. */
export async function presentError(error: unknown, ctx: ErrorActions): Promise<void> {
  if (isCommitCraftError(error) && error.code === 'CANCELLED') {
    vscode.window.setStatusBarMessage('CommitCraft: cancelled', 2000);
    return;
  }
  ctx.logger.error(logLine(error));

  if (!isCommitCraftError(error)) {
    const choice = await vscode.window.showErrorMessage(
      'CommitCraft: Something unexpected went wrong. Try again; if it keeps happening, open the log for details.',
      'Show Log',
    );
    if (choice === 'Show Log') {
      ctx.logger.show();
    }
    return;
  }

  const actions = actionsFor(error.code, ctx);
  const show = NOTHING_TO_DO.has(error.code) ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;
  const choice = await show(`CommitCraft: ${error.message}`, ...actions.map((a) => a.label));
  await actions.find((a) => a.label === choice)?.run();
}

export type ProgressReporter = (message: string) => void;

/**
 * Runs `task` under a cancellable notification. Resolves undefined if the user cancelled; other
 * failures propagate. The task gets an AbortSignal that fires on cancel.
 */
export async function runWithProgress<T>(
  title: string,
  task: (signal: AbortSignal, report: ProgressReporter) => Promise<T>,
): Promise<T | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try {
        return await task(controller.signal, (message) => progress.report({ message }));
      } catch (error) {
        if (isCommitCraftError(error) && error.code === 'CANCELLED') {
          return undefined;
        }
        throw error;
      } finally {
        subscription.dispose();
      }
    },
  );
}
