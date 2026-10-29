// AiProvider backed by the Anthropic Messages API. The API key is passed in, never read here.

import Anthropic from '@anthropic-ai/sdk';
import { CommitCraftError } from '../core/errors';
import type { AiProvider, BuiltPrompt, GenerateOptions } from '../core/types';

/**
 * Pinned on purpose. The SDK would otherwise honour ANTHROPIC_BASE_URL from the environment and
 * could send the user's key and diffs to an endpoint they never chose.
 */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

const DEFAULT_TIMEOUT_MS = 60_000;
/** Commit messages need little thinking; "low" keeps the call fast and cheap. */
const EFFORT = 'low';

/** The slice of the SDK client this provider uses. Tests supply a fake. */
export interface AnthropicClientLike {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<Anthropic.Message>;
  };
}

export type ClientFactory = (apiKey: string) => AnthropicClientLike;

/**
 * Builds the real client. An explicit apiKey stops the SDK reading ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
 * or an `ant auth login` profile; the base URL is pinned; SDK logging is off so ANTHROPIC_LOG=debug in the
 * user's environment cannot write request details (our diffs) to a log; OpenTelemetry is off so a tracer
 * that another extension registered in the shared extension host cannot capture the prompt (the SDK can put
 * message content in spans) and no trace context is attached to the request.
 */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: ANTHROPIC_BASE_URL,
    logLevel: 'off',
    maxRetries: 1,
    openTelemetry: { traces: false, propagation: false },
  });
}

/** Seconds from a `retry-after` header, if the provider sent a usable one. */
function retryAfterSeconds(error: { headers?: Headers }): number | undefined {
  const seconds = Number(error.headers?.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

/**
 * The live API reports an account with no credit as HTTP 400 `invalid_request_error`, not as a 402, and gives
 * no distinct error type, so the wording is the only discriminator (observed 2026-10-28). Checked loosely (the
 * message or the response body) and never echoed back: the user sees our own fixed text.
 */
function isOutOfCredit(error: { message?: string; error?: unknown }): boolean {
  const body = typeof error.error === 'object' && error.error !== null ? JSON.stringify(error.error) : '';
  return /credit balance|insufficient credit|out of credit/i.test(`${error.message ?? ''} ${body}`);
}

function outOfCredit(cause: unknown): CommitCraftError {
  return new CommitCraftError(
    'PROVIDER_ERROR',
    'Your Anthropic account has no credit left, so the API refused the request. Add credits under Plans & Billing at console.anthropic.com, then try again.',
    { cause },
  );
}

/** Maps SDK failures to CommitCraftError. Messages say what happened and what to do; they never echo prompts or keys. */
export function mapAnthropicError(error: unknown, signal?: AbortSignal): CommitCraftError {
  if (error instanceof CommitCraftError) {
    return error;
  }
  if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) {
    return new CommitCraftError('CANCELLED', 'Generation was cancelled.', { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new CommitCraftError(
      'TIMEOUT',
      'The request to the AI provider timed out. Check your connection and try again.',
      { cause: error },
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new CommitCraftError(
      'NETWORK',
      'Could not reach the AI provider. Check your internet connection or proxy settings and try again.',
      { cause: error },
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new CommitCraftError(
      'INVALID_API_KEY',
      'The API key was rejected. Run "CommitCraft: Set API Key" and enter a valid Anthropic API key.',
      { cause: error },
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new CommitCraftError(
      'INVALID_API_KEY',
      'This API key is not allowed to use that model. Use a different key with "CommitCraft: Set API Key", or change commitcraft.model.',
      { cause: error },
    );
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new CommitCraftError(
      'MODEL_NOT_FOUND',
      'The model set in commitcraft.model was not found or is not available to your key. Open Settings and choose a valid model, such as claude-opus-5-5.',
      { cause: error },
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    const wait = retryAfterSeconds(error);
    return new CommitCraftError(
      'RATE_LIMITED',
      `The AI provider is rate limiting requests (HTTP 429). Wait ${wait ? `${wait} seconds` : 'a minute'} and try again.`,
      { cause: error },
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    if (isOutOfCredit(error)) {
      return outOfCredit(error);
    }
    return new CommitCraftError(
      'PROVIDER_ERROR',
      'The AI provider rejected the request (HTTP 400). Try again with fewer staged changes. If you changed commitcraft.model to an older model, switch back to claude-opus-5-5, claude-sonnet-5-5 or claude-haiku-5-5.',
      { cause: error },
    );
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status as number | undefined;
    if (status === 402) {
      return outOfCredit(error);
    }
    if (status === 413) {
      return new CommitCraftError(
        'PROVIDER_ERROR',
        'The request was too large for the AI provider (HTTP 413). Stage fewer changes and try again.',
        { cause: error },
      );
    }
    if (status !== undefined && status >= 500) {
      return new CommitCraftError(
        'PROVIDER_ERROR',
        `The AI provider is having problems (HTTP ${status}). Try again in a moment.`,
        { cause: error },
      );
    }
    return new CommitCraftError(
      'PROVIDER_ERROR',
      `The AI provider returned an error${status ? ` (HTTP ${status})` : ''}. Try again; if it keeps happening, check status.anthropic.com.`,
      { cause: error },
    );
  }
  return new CommitCraftError('PROVIDER_ERROR', 'Something unexpected went wrong while calling the AI provider. Try again.', {
    cause: error,
  });
}

/** Extracts the answer text from a response, turning refusals and cut-off answers into errors. */
export function extractText(response: Anthropic.Message): string {
  if (response.stop_reason === 'refusal') {
    throw new CommitCraftError(
      'PROVIDER_REFUSED',
      'The AI declined to write a message for these changes. Try staging a smaller set of changes, or write the message yourself.',
    );
  }
  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();

  if (response.stop_reason === 'max_tokens') {
    if (text === '') {
      throw new CommitCraftError(
        'EMPTY_RESPONSE',
        'The AI ran out of output space before writing anything. Try again, or choose a faster model in commitcraft.model.',
      );
    }
    throw new CommitCraftError(
      'MALFORMED_RESPONSE',
      'The AI answer was cut off before it finished. Try again, or stage fewer changes.',
    );
  }
  if (response.stop_reason === 'model_context_window_exceeded') {
    throw new CommitCraftError('PROVIDER_ERROR', 'The changes are too large for the model to read. Stage fewer changes and try again.');
  }
  if (text === '') {
    throw new CommitCraftError('EMPTY_RESPONSE', 'The AI returned an empty answer. Try again; if it keeps happening, check commitcraft.model.');
  }
  return text;
}

export function createAnthropicProvider(createClient: ClientFactory = createAnthropicClient): AiProvider {
  return {
    async generate(prompt: BuiltPrompt, options: GenerateOptions): Promise<string> {
      if (options.signal?.aborted) {
        throw mapAnthropicError(undefined, options.signal);
      }
      const client = createClient(options.apiKey);
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model: options.model,
            max_tokens: options.maxTokens,
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
            output_config: { effort: EFFORT },
          },
          { signal: options.signal, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        );
      } catch (error) {
        throw mapAnthropicError(error, options.signal);
      }
      return extractText(response);
    },
  };
}
