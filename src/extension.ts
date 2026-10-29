import type * as vscode from 'vscode';
import { createAnthropicProvider } from './providers/anthropic';
import { createGeminiProvider } from './providers/gemini';
import { registerCommands } from './vscode/commands';
import { createLogger } from './vscode/logger';

export function activate(context: vscode.ExtensionContext): void {
  const logger = createLogger();
  context.subscriptions.push(logger, ...registerCommands({ context, logger, providers: { anthropic: createAnthropicProvider(), gemini: createGeminiProvider() } }));
}

export function deactivate(): void {
  // Nothing to clean up: all resources are disposed through context.subscriptions.
}
