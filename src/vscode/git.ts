// Access to the built-in `vscode.git` extension: finding the right repository and running git safely.

import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { CommitCraftError } from '../core/errors';
import { pickRepositoryRoot } from '../core/repository';
import type { GitApi, GitCommandFailure, GitExtensionExports, GitRepository, RunGit } from './gitTypes';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const REPOSITORY_DISCOVERY_WAIT_MS = 5_000;

function waitForInitialized(api: GitApi, timeoutMs: number): Promise<void> {
  if (api.state === 'initialized') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve();
    }, timeoutMs);
    const subscription = api.onDidChangeState((state) => {
      if (state === 'initialized') {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  });
}

export async function getGitApi(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!extension) {
    throw new CommitCraftError(
      'GIT_EXTENSION_UNAVAILABLE',
      'The built-in Git extension is not available. Enable "Git" in the Extensions view (search @builtin git), then reload the window.',
    );
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (!exports.enabled) {
    throw new CommitCraftError(
      'GIT_EXTENSION_UNAVAILABLE',
      'Git is turned off in VS Code. Set "git.enabled" to true in Settings, then try again.',
    );
  }
  return exports.getAPI(1);
}

/** The folder a command was invoked for: the SCM title button passes a SourceControl, Explorer menus a Uri. */
function rootFromArgument(arg: unknown): string | undefined {
  if (arg instanceof vscode.Uri) {
    return arg.fsPath;
  }
  if (typeof arg === 'object' && arg !== null && 'rootUri' in arg) {
    const rootUri = (arg as { rootUri?: unknown }).rootUri;
    if (rootUri instanceof vscode.Uri) {
      return rootUri.fsPath;
    }
  }
  return undefined;
}

/**
 * Picks the repository to work on: the only one; else the one the command was invoked for; else the
 * one containing the active file; else asks. Returns undefined if the user dismisses the question.
 * @throws CommitCraftError NO_WORKSPACE, NO_REPOSITORY, GIT_EXTENSION_UNAVAILABLE
 */
export async function selectRepository(api: GitApi, arg?: unknown): Promise<GitRepository | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) {
    throw new CommitCraftError(
      'NO_WORKSPACE',
      'No folder is open. Open a folder that contains a Git repository (File > Open Folder) and try again.',
    );
  }
  await waitForInitialized(api, REPOSITORY_DISCOVERY_WAIT_MS);

  const repositories = api.repositories;
  if (repositories.length === 0) {
    throw new CommitCraftError(
      'NO_REPOSITORY',
      'No Git repository was found in this workspace. Open a folder that is a Git repository, or run "Git: Initialize Repository".',
    );
  }
  if (repositories.length === 1) {
    return repositories[0];
  }

  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const roots = repositories.map((repository) => repository.rootUri.fsPath);

  const fromArgument = pickRepositoryRoot(roots, rootFromArgument(arg), { caseInsensitive });
  if (fromArgument !== undefined) {
    return repositories[fromArgument];
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const fromActiveFile = pickRepositoryRoot(roots, activeUri?.scheme === 'file' ? activeUri.fsPath : undefined, {
    caseInsensitive,
  });
  if (fromActiveFile !== undefined) {
    return repositories[fromActiveFile];
  }

  const picked = await vscode.window.showQuickPick(
    repositories.map((repository) => ({
      label: basename(repository.rootUri.fsPath),
      description: repository.rootUri.fsPath,
      repository,
    })),
    { title: 'CommitCraft', placeHolder: 'Which repository do you want to use?' },
  );
  return picked?.repository;
}

/** The first non-empty line of git's stderr, shortened: enough for the log, never a diff. */
function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  return line.trim().slice(0, 200);
}

/**
 * Runs the Git extension's own git binary in `cwd`. No shell: arguments are passed as an array, so
 * nothing in them can be interpreted as shell syntax.
 */
export function createRunGit(gitPath: string, cwd: string, signal?: AbortSignal): RunGit {
  const cancelled = (): CommitCraftError => new CommitCraftError('CANCELLED', 'Generation was cancelled.');
  return (args) =>
    new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancelled());
        return;
      }
      execFile(
        gitPath,
        [...args],
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: GIT_MAX_OUTPUT_BYTES,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
          signal,
          // LC_ALL=C keeps git's messages in English whatever the user's locale; no credential prompts.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
          } else if (signal?.aborted) {
            reject(cancelled());
          } else if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(
              new CommitCraftError(
                'GIT_ERROR',
                'The branch changes are too large to read. Compare a smaller branch, or write the description by hand.',
                { cause: error },
              ),
            );
          } else {
            const failure: GitCommandFailure = {
              exitCode: (error as { code?: number | string | null }).code ?? null,
              stderrSummary: firstLine(stderr),
            };
            reject(Object.assign(new Error(error.message, { cause: error }), failure));
          }
        },
      );
    });
}
