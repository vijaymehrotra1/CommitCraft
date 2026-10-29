import type { CommitCraftSettings, ProviderName } from './types';

export const PROVIDER_NAMES: readonly ProviderName[] = ['anthropic', 'gemini'];

/** What the user sees when we say where their diff went. */
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
};

/** The model used when `commitcraft.model` is empty. Gemini's is the one that answered fastest and most reliably in live tests. */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-opus-5-5',
  gemini: 'gemini-3.5-flash-lite',
};

export const DEFAULT_SETTINGS: CommitCraftSettings = {
  provider: 'anthropic',
  style: 'conventional',
  maxSubjectLength: 72,
  baseBranch: 'main',
  model: DEFAULT_MODELS.anthropic,
};

export const MIN_SUBJECT_LENGTH = 20;
export const MAX_SUBJECT_LENGTH = 120;

/** Raw values as read from VS Code configuration: anything a user could have typed into settings.json. */
export interface RawSettings {
  provider?: unknown;
  style?: unknown;
  maxSubjectLength?: unknown;
  baseBranch?: unknown;
  model?: unknown;
}

const MIN_API_KEY_LENGTH = 20;

/** Input-box validation for the API key: an error message to show, or undefined if it looks acceptable. */
export function validateApiKeyInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return 'Paste your Anthropic API key.';
  }
  if (/\s/.test(trimmed)) {
    return 'An API key has no spaces or line breaks. Check what you pasted.';
  }
  if (!/^[\x21-\x7e]+$/.test(trimmed)) {
    // A curly quote, en dash or zero-width space from a copy and paste would crash the HTTP header later.
    return 'An API key uses only plain letters, digits and symbols (no curly quotes, accents or hidden characters). Check what you pasted.';
  }
  if (trimmed.length < MIN_API_KEY_LENGTH) {
    return 'That looks too short to be an API key.';
  }
  return undefined;
}

function parseProvider(value: unknown): ProviderName {
  const wanted = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PROVIDER_NAMES.find((name) => name === wanted) ?? DEFAULT_SETTINGS.provider;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Turns raw configuration values into valid settings. Never throws: anything unusable falls back to
 * the default. (Branch-name safety is checked separately, where the branch is used: see repository.ts.)
 */
export function normalizeSettings(raw: RawSettings): CommitCraftSettings {
  const length = typeof raw.maxSubjectLength === 'number' ? raw.maxSubjectLength : Number.NaN;
  const provider = parseProvider(raw.provider);
  return {
    provider,
    style: typeof raw.style === 'string' && raw.style.trim().toLowerCase() === 'plain' ? 'plain' : 'conventional',
    maxSubjectLength: Number.isFinite(length)
      ? Math.min(MAX_SUBJECT_LENGTH, Math.max(MIN_SUBJECT_LENGTH, Math.round(length)))
      : DEFAULT_SETTINGS.maxSubjectLength,
    baseBranch: nonEmptyString(raw.baseBranch, DEFAULT_SETTINGS.baseBranch),
    model: nonEmptyString(raw.model, DEFAULT_MODELS[provider]),
  };
}
