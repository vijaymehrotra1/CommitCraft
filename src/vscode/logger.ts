import * as vscode from 'vscode';

/**
 * The extension's only log. Never pass diffs, prompts, file contents or API keys to it: log error
 * codes, counts and sizes only.
 */
export interface Logger extends vscode.Disposable {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show(): void;
}

export function createLogger(): Logger {
  const channel = vscode.window.createOutputChannel('CommitCraft', { log: true });
  return {
    info: (message) => channel.info(message),
    warn: (message) => channel.warn(message),
    error: (message) => channel.error(message),
    show: () => channel.show(true),
    dispose: () => channel.dispose(),
  };
}
