// AiProvider backed by Google's Gemini API, through its OpenAI-compatible chat completions endpoint.
// The API key is passed in, never read here. No SDK and no dependency: one `fetch` call.
//
// Behaviour was observed against the live API on 2026-10-28 (docs/knowledge-base/gemini-api-notes.md):
//  - errors arrive as a JSON ARRAY, `[{"error":{"code","message","status"}}]`;
//  - a bad or expired key is HTTP 400 INVALID_ARGUMENT "Please pass a valid API key", not 401;
//  - `max_tokens` is accepted, but `reasoning_effort: "minimal"` is rejected by some models, so it is never sent.

import { CommitCraftError } from '../core/errors';
import type { AiProvider, BuiltPrompt, GenerateOptions } from '../core/types';

/** Pinned on purpose: not configurable, so a setting from a workspace can never redirect the key and the diffs. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

const DEFAULT_TIMEOUT_MS = 60_000;
const SUGGESTED_MODEL = 'gemini-3.5-flash-lite';

interface GoogleError {
  code?: number;
  status?: string;
  message?: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The error object, whether Google wrapped it in an array (this endpoint) or not. */
function errorDetails(body: unknown): GoogleError {
  const first: unknown = Array.isArray(body) ? body[0] : body;
  const error = (first as { error?: unknown } | undefined)?.error;
  return typeof error === 'object' && error !== null ? error : {};
}

/** The cause kept for the log: the HTTP status only. Never the response body, which can echo request text. */
function statusCause(status: number): Error {
  return Object.assign(new Error(`Gemini HTTP ${status}`), { status });
}

function invalidKey(cause: Error): CommitCraftError {
  return new CommitCraftError(
    'INVALID_API_KEY',
    'The Gemini API key was rejected. Run "CommitCraft: Set API Key" and enter a valid key from Google AI Studio.',
    { cause },
  );
}

/** Maps an HTTP error to a CommitCraftError. The text is ours: the provider's wording is never echoed. */
function mapHttpError(status: number, details: GoogleError, headers: Headers): CommitCraftError {
  const cause = statusCause(status);
  if (status === 401 || (status === 400 && details.status === 'INVALID_ARGUMENT' && /api key/i.test(details.message ?? ''))) {
    return invalidKey(cause);
  }
  if (status === 403) {
    return new CommitCraftError(
      'INVALID_API_KEY',
      'This Gemini API key is not allowed to do that. Create a key in Google AI Studio and run "CommitCraft: Set API Key", or choose another model in commitcraft.model.',
      { cause },
    );
  }
  if (status === 404) {
    return new CommitCraftError(
      'MODEL_NOT_FOUND',
      `The model set in commitcraft.model was not found or is not available to your key. Open Settings and choose a valid Gemini model, such as ${SUGGESTED_MODEL}.`,
      { cause },
    );
  }
  if (status === 429) {
    const seconds = Number(headers.get('retry-after'));
    const wait = Number.isFinite(seconds) && seconds > 0 ? `${Math.ceil(seconds)} seconds` : 'a minute';
    return new CommitCraftError(
      'RATE_LIMITED',
      `Gemini is rate limiting requests (HTTP 429). The free tier has per-minute and per-day limits (the daily one resets at midnight Pacific time). Wait ${wait}, then try again.`,
      { cause },
    );
  }
  if (status >= 500) {
    return new CommitCraftError(
      'PROVIDER_ERROR',
      `Gemini is busy or having problems (HTTP ${status}). This is often temporary on popular models: try again, or set commitcraft.model to ${SUGGESTED_MODEL}.`,
      { cause },
    );
  }
  if (status === 400) {
    return new CommitCraftError(
      'PROVIDER_ERROR',
      `Gemini rejected the request (HTTP 400). Try again with fewer staged changes, or check commitcraft.model (${SUGGESTED_MODEL} is a safe choice).`,
      { cause },
    );
  }
  return new CommitCraftError(
    'PROVIDER_ERROR',
    `Gemini returned an error (HTTP ${status}). Try again; if it keeps happening, check commitcraft.model.`,
    { cause },
  );
}

function mapNetworkError(error: unknown, signal: AbortSignal | undefined): CommitCraftError {
  if (signal?.aborted) {
    return new CommitCraftError('CANCELLED', 'Generation was cancelled.', { cause: error });
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new CommitCraftError('TIMEOUT', 'The request to Gemini timed out. Check your connection and try again.', { cause: error });
  }
  return new CommitCraftError(
    'NETWORK',
    'Could not reach Gemini. Check your internet connection or proxy settings and try again.',
    { cause: error },
  );
}

function unexpected(): CommitCraftError {
  return new CommitCraftError(
    'PROVIDER_ERROR',
    'Gemini returned a response CommitCraft could not read. Try again; if it keeps happening, check commitcraft.model.',
  );
}

/** Pulls the answer out of a chat completion, turning safety blocks, cut-off and empty answers into errors. */
function extractAnswer(body: unknown): string {
  const choices = (body as { choices?: unknown } | undefined)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw unexpected();
  }
  const choice = choices[0] as { finish_reason?: unknown; message?: { content?: unknown } } | undefined;
  const content = choice?.message?.content;
  if (choice?.finish_reason === 'content_filter') {
    throw new CommitCraftError(
      'PROVIDER_REFUSED',
      'Gemini declined to write a message for these changes. Try staging a smaller set of changes, or write the message yourself.',
    );
  }
  if (content !== null && content !== undefined && typeof content !== 'string') {
    throw unexpected();
  }
  const text = (content ?? '').trim();
  if (choice?.finish_reason === 'length') {
    throw text === ''
      ? new CommitCraftError('EMPTY_RESPONSE', 'Gemini ran out of output space before writing anything. Try again, or choose another model in commitcraft.model.')
      : new CommitCraftError('MALFORMED_RESPONSE', 'The Gemini answer was cut off before it finished. Try again, or stage fewer changes.');
  }
  if (text === '') {
    throw new CommitCraftError('EMPTY_RESPONSE', 'Gemini returned an empty answer. Try again; if it keeps happening, check commitcraft.model.');
  }
  return text;
}

export function createGeminiProvider(fetchImpl: typeof fetch = fetch): AiProvider {
  return {
    async generate(prompt: BuiltPrompt, options: GenerateOptions): Promise<string> {
      if (options.signal?.aborted) {
        throw mapNetworkError(undefined, options.signal);
      }
      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

      let status: number;
      let ok: boolean;
      let headers: Headers;
      let text: string;
      try {
        const response = await fetchImpl(`${GEMINI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({
            model: options.model,
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
            max_tokens: options.maxTokens,
          }),
          signal,
          redirect: 'error', // never forward the Authorization header to another host
        });
        ({ status, ok, headers } = response);
        text = await response.text();
      } catch (error) {
        throw mapNetworkError(error, options.signal);
      }

      const body = parseJson(text);
      if (!ok) {
        throw mapHttpError(status, errorDetails(body), headers);
      }
      return extractAnswer(body);
    },
  };
}
