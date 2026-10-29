import * as vscode from 'vscode';
import { CommitCraftError } from '../core/errors';
import { PROVIDER_LABELS, validateApiKeyInput } from '../core/settings';
import type { ProviderName } from '../core/types';

/**
 * The only place API keys live: VS Code SecretStorage (the OS keychain). Never settings, files or logs.
 * One entry per provider, so a key is never sent to the wrong vendor.
 */
const API_KEY_SECRETS: Record<ProviderName, string> = {
  anthropic: 'commitcraft.anthropicApiKey',
  gemini: 'commitcraft.geminiApiKey',
};

interface KeyPrompt {
  /** "an Anthropic API key": goes into "CommitCraft needs ___ before it can write messages". */
  needs: string;
  title: string;
  prompt: string;
  placeHolder: string;
}

const KEY_PROMPTS: Record<ProviderName, KeyPrompt> = {
  anthropic: {
    needs: 'an Anthropic API key',
    title: 'CommitCraft: Set API Key (Anthropic Claude)',
    prompt: 'Enter your Anthropic API key. It is stored in VS Code SecretStorage and only sent to api.anthropic.com.',
    placeHolder: 'sk-ant-...',
  },
  gemini: {
    needs: 'a Google Gemini API key',
    title: 'CommitCraft: Set API Key (Google Gemini)',
    prompt:
      'Enter your Gemini API key from Google AI Studio. It is stored in VS Code SecretStorage and only sent to generativelanguage.googleapis.com. ' +
      'On the free tier, Google may use your prompts to improve its products and human reviewers may read them, so do not use it with confidential code.',
    placeHolder: 'Paste your Gemini API key',
  },
};

/** What to say in "CommitCraft needs ___ before it can write messages". */
export function keyNeeded(provider: ProviderName): string {
  return KEY_PROMPTS[provider].needs;
}

/** SecretStorage needs an OS keychain; on Linux and WSL it is often missing or locked. Never mention the key or the raw error. */
function secretStorageError(cause: unknown): CommitCraftError {
  return new CommitCraftError(
    'SECRET_STORAGE_ERROR',
    'VS Code could not access its secure storage (the operating system keychain), so CommitCraft cannot read or save the API key. On Linux, install and unlock a keyring such as gnome-keyring, then try again.',
    { cause },
  );
}

export async function getApiKey(context: vscode.ExtensionContext, provider: ProviderName): Promise<string | undefined> {
  let key: string | undefined;
  try {
    key = await context.secrets.get(API_KEY_SECRETS[provider]);
  } catch (error) {
    throw secretStorageError(error);
  }
  return key && key.trim() !== '' ? key.trim() : undefined;
}

/** Asks for a key (masked input) and stores it for `provider`. Returns the key, or undefined if the user cancelled. */
export async function promptForApiKey(context: vscode.ExtensionContext, provider: ProviderName): Promise<string | undefined> {
  const { title, prompt, placeHolder } = KEY_PROMPTS[provider];
  const value = await vscode.window.showInputBox({
    title,
    prompt,
    placeHolder,
    password: true,
    ignoreFocusOut: true,
    validateInput: validateApiKeyInput,
  });
  if (value === undefined) {
    return undefined;
  }
  const key = value.trim();
  try {
    await context.secrets.store(API_KEY_SECRETS[provider], key);
  } catch (error) {
    throw secretStorageError(error);
  }
  void vscode.window.showInformationMessage(`CommitCraft: ${PROVIDER_LABELS[provider]} API key saved.`);
  return key;
}
