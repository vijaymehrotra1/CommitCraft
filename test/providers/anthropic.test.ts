import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitCraftError } from '../../src/core/errors';
import type { BuiltPrompt, GenerateOptions } from '../../src/core/types';
import {
  ANTHROPIC_BASE_URL,
  createAnthropicClient,
  createAnthropicProvider,
  mapAnthropicError,
  type AnthropicClientLike,
} from '../../src/providers/anthropic';

const KEY = ['sk-ant-', 'api03-', 'FAKE-FAKE-FAKE-FAKE-FAKE-FAKE'].join('');
const prompt: BuiltPrompt = { system: 'SYSTEM-PROMPT-TEXT', user: 'USER-PROMPT-TEXT-with-diff' };
const options: GenerateOptions = { apiKey: KEY, model: 'claude-opus-5-5', maxTokens: 4096 };

type CreateFn = AnthropicClientLike['messages']['create'];

function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'feat: add thing', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...overrides,
  } as Anthropic.Message;
}

function providerWith(create: CreateFn): { provider: ReturnType<typeof createAnthropicProvider>; factory: ReturnType<typeof vi.fn> } {
  const factory = vi.fn((_apiKey: string): AnthropicClientLike => ({ messages: { create } }));
  return { provider: createAnthropicProvider(factory), factory };
}

type SdkApiError = InstanceType<typeof Anthropic.APIError>;

function apiError(status: number, type: string, headers: Record<string, string> = {}): SdkApiError {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message: `server said ${type}` } },
    `server said ${type}`,
    new Headers(headers),
  );
}

async function failureOf(promise: Promise<unknown>): Promise<CommitCraftError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CommitCraftError);
    return error as CommitCraftError;
  }
  throw new Error('expected the promise to reject');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AnthropicProvider.generate: request', () => {
  it('sends the prompt, model, token budget and low effort, and nothing the new models reject', async () => {
    const create = vi.fn<CreateFn>().mockResolvedValue(message());
    const { provider, factory } = providerWith(create);
    const controller = new AbortController();

    const text = await provider.generate(prompt, { ...options, signal: controller.signal, timeoutMs: 1234 });

    expect(text).toBe('feat: add thing');
    expect(factory).toHaveBeenCalledWith(KEY);
    expect(create).toHaveBeenCalledTimes(1);
    const [params, requestOptions] = create.mock.calls[0] as Parameters<CreateFn>;
    expect(params).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 4096,
      system: 'SYSTEM-PROMPT-TEXT',
      messages: [{ role: 'user', content: 'USER-PROMPT-TEXT-with-diff' }],
      output_config: { effort: 'low' },
    });
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
    expect(params).not.toHaveProperty('thinking');
    expect(requestOptions).toEqual({ signal: controller.signal, timeout: 1234 });
  });

  it('uses a default timeout', async () => {
    const create = vi.fn<CreateFn>().mockResolvedValue(message());
    await providerWith(create).provider.generate(prompt, options);
    expect((create.mock.calls[0] as Parameters<CreateFn>)[1]?.timeout).toBe(60_000);
  });

  it('joins text blocks and ignores thinking blocks', async () => {
    const create = vi.fn<CreateFn>().mockResolvedValue(
      message({
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'fix: part one', citations: null },
          { type: 'text', text: ' and two', citations: null },
        ] as Anthropic.ContentBlock[],
      }),
    );
    expect(await providerWith(create).provider.generate(prompt, options)).toBe('fix: part one and two');
  });

  it('does not call the API when already cancelled', async () => {
    const create = vi.fn<CreateFn>();
    const controller = new AbortController();
    controller.abort();
    const error = await failureOf(providerWith(create).provider.generate(prompt, { ...options, signal: controller.signal }));
    expect(error.code).toBe('CANCELLED');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('AnthropicProvider.generate: bad responses', () => {
  const cases: Array<[string, Partial<Anthropic.Message>, string]> = [
    ['empty content', { content: [] }, 'EMPTY_RESPONSE'],
    ['whitespace-only text', { content: [{ type: 'text', text: '  \n ', citations: null }] }, 'EMPTY_RESPONSE'],
    ['only a thinking block', { content: [{ type: 'thinking', thinking: 'x', signature: 's' }] as Anthropic.ContentBlock[] }, 'EMPTY_RESPONSE'],
    ['refusal', { stop_reason: 'refusal', content: [] }, 'PROVIDER_REFUSED'],
    ['out of tokens before any text', { stop_reason: 'max_tokens', content: [] }, 'EMPTY_RESPONSE'],
    ['cut off mid-answer', { stop_reason: 'max_tokens' }, 'MALFORMED_RESPONSE'],
    ['context window exceeded', { stop_reason: 'model_context_window_exceeded', content: [] }, 'PROVIDER_ERROR'],
  ];

  it.each(cases)('maps %s to %s', async (_label, overrides, code) => {
    const create = vi.fn<CreateFn>().mockResolvedValue(message(overrides));
    const error = await failureOf(providerWith(create).provider.generate(prompt, options));
    expect(error.code).toBe(code);
  });
});

describe('AnthropicProvider.generate: error mapping', () => {
  const cases: Array<[string, () => unknown, string, RegExp]> = [
    ['401', () => apiError(401, 'authentication_error'), 'INVALID_API_KEY', /Set API Key/],
    ['403', () => apiError(403, 'permission_error'), 'INVALID_API_KEY', /not allowed/],
    ['404', () => apiError(404, 'not_found_error'), 'MODEL_NOT_FOUND', /commitcraft\.model/],
    ['429', () => apiError(429, 'rate_limit_error'), 'RATE_LIMITED', /rate limiting.*a minute/],
    ['429 with retry-after', () => apiError(429, 'rate_limit_error', { 'retry-after': '17' }), 'RATE_LIMITED', /Wait 17 seconds/],
    ['400', () => apiError(400, 'invalid_request_error'), 'PROVIDER_ERROR', /HTTP 400.*fewer staged changes.*older model/],
    ['402', () => apiError(402, 'billing_error'), 'PROVIDER_ERROR', /no credit left/],
    ['413', () => apiError(413, 'request_too_large'), 'PROVIDER_ERROR', /too large/],
    ['500', () => apiError(500, 'api_error'), 'PROVIDER_ERROR', /HTTP 500/],
    ['529', () => apiError(529, 'overloaded_error'), 'PROVIDER_ERROR', /HTTP 529/],
    ['418 (anything else)', () => apiError(418, 'teapot'), 'PROVIDER_ERROR', /HTTP 418/],
    ['network failure', () => new Anthropic.APIConnectionError({ message: 'getaddrinfo ENOTFOUND api.anthropic.com' }), 'NETWORK', /internet connection or proxy/],
    ['timeout', () => new Anthropic.APIConnectionTimeoutError(), 'TIMEOUT', /timed out/],
    ['SDK abort', () => new Anthropic.APIUserAbortError(), 'CANCELLED', /cancelled/],
    ['a non-SDK error', () => new TypeError('boom'), 'PROVIDER_ERROR', /unexpected/],
  ];

  it.each(cases)('maps %s to %s with a helpful message', async (_label, makeError, code, message) => {
    const create = vi.fn<CreateFn>().mockRejectedValue(makeError());
    const error = await failureOf(providerWith(create).provider.generate(prompt, options));
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
  });

  describe('an account with no credit (the live API reports this as HTTP 400, not 402)', () => {
    // The exact wording the live API returned during the first real call (2026-10-28).
    const NO_CREDIT = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
    const noCredit = (): SdkApiError =>
      Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: NO_CREDIT } }, NO_CREDIT, new Headers());

    it('says the account needs credit, instead of blaming the staged changes or the model', async () => {
      const create = vi.fn<CreateFn>().mockRejectedValue(noCredit());
      const error = await failureOf(providerWith(create).provider.generate(prompt, options));
      expect(error.code).toBe('PROVIDER_ERROR');
      expect(error.message).toMatch(/no credit/i);
      expect(error.message).toMatch(/Plans & Billing/);
      expect(error.message).not.toMatch(/fewer staged changes/);
      expect(error.message).not.toMatch(/older model/);
    });

    it('recognises the problem when only the response body, not the message, carries the text', async () => {
      const bodyOnly = Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: NO_CREDIT } }, '400 Bad Request', new Headers());
      const create = vi.fn<CreateFn>().mockRejectedValue(bodyOnly);
      expect((await failureOf(providerWith(create).provider.generate(prompt, options))).message).toMatch(/no credit/i);
    });

    it('does not echo the provider message verbatim (it is fixed, user-safe text)', async () => {
      const create = vi.fn<CreateFn>().mockRejectedValue(noCredit());
      expect((await failureOf(providerWith(create).provider.generate(prompt, options))).message).not.toContain('credit balance is too low');
    });

    it('a different 400 keeps the generic message', async () => {
      const create = vi.fn<CreateFn>().mockRejectedValue(apiError(400, 'invalid_request_error'));
      expect((await failureOf(providerWith(create).provider.generate(prompt, options))).message).toMatch(/fewer staged changes/);
    });

    it('a 402 billing_error gets the same credit advice', async () => {
      const create = vi.fn<CreateFn>().mockRejectedValue(apiError(402, 'billing_error'));
      expect((await failureOf(providerWith(create).provider.generate(prompt, options))).message).toMatch(/no credit|billing/i);
    });
  });

  it('reports CANCELLED when the signal was aborted, whatever error the SDK raised', async () => {
    const controller = new AbortController();
    const create = vi.fn<CreateFn>().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Anthropic.APIConnectionError({ message: 'fetch failed' }));
    });
    const error = await failureOf(providerWith(create).provider.generate(prompt, { ...options, signal: controller.signal }));
    expect(error.code).toBe('CANCELLED');
  });

  it('keeps the original error as the cause for the logger', async () => {
    const original = apiError(500, 'api_error');
    const create = vi.fn<CreateFn>().mockRejectedValue(original);
    const error = await failureOf(providerWith(create).provider.generate(prompt, options));
    expect(error.cause).toBe(original);
  });

  it('never puts the API key or any prompt text in an error message', async () => {
    const leaky = apiError(400, 'invalid_request_error');
    leaky.message = `bad request for key ${KEY}: ${prompt.user}`;
    for (const failure of [leaky, apiError(401, 'authentication_error'), apiError(500, 'api_error'), new Error(KEY)]) {
      const create = vi.fn<CreateFn>().mockRejectedValue(failure);
      const error = await failureOf(providerWith(create).provider.generate(prompt, options));
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain('USER-PROMPT-TEXT');
      expect(error.message).not.toContain('SYSTEM-PROMPT-TEXT');
    }
  });

  it('passes an existing CommitCraftError through untouched', () => {
    const existing = new CommitCraftError('NO_STAGED_CHANGES', 'x');
    expect(mapAnthropicError(existing)).toBe(existing);
  });
});

describe('createAnthropicClient (what actually leaves the machine)', () => {
  it('uses exactly the key it was given', () => {
    const client = createAnthropicClient(KEY);
    expect(client.apiKey).toBe(KEY);
    expect(client.authToken).toBeNull();
  });

  it('pins the base URL even if ANTHROPIC_BASE_URL is set in the environment', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://attacker.example.invalid');
    expect(createAnthropicClient(KEY).baseURL).toBe(ANTHROPIC_BASE_URL);
  });

  it('ignores ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the environment', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key-must-not-be-used');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-token-must-not-be-used');
    const client = createAnthropicClient(KEY);
    expect(client.apiKey).toBe(KEY);
    expect(client.authToken).toBeNull();
  });

  it('keeps SDK logging off even if ANTHROPIC_LOG=debug is set', () => {
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    expect(createAnthropicClient(KEY).logLevel).toBe('off');
  });

  it('turns SDK OpenTelemetry off, so no tracer another extension registered can capture the prompt', () => {
    const { traces, propagation } = createAnthropicClient(KEY).openTelemetry;
    expect(traces.enabled).toBe(false);
    expect(propagation).toBe(false);
  });

  it('keeps OpenTelemetry off even if the environment asks for prompt content in traces', () => {
    vi.stubEnv('ANTHROPIC_OPEN_TELEMETRY', 'true');
    vi.stubEnv('ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE', 'content');
    vi.stubEnv('ANTHROPIC_OPEN_TELEMETRY_PROPAGATION', 'true');
    const { traces, propagation } = createAnthropicClient(KEY).openTelemetry;
    expect(traces.enabled).toBe(false);
    expect(traces.contentMode).not.toBe('content');
    expect(propagation).toBe(false);
  });

  it('retries at most once so a failing call does not hang for minutes', () => {
    expect(createAnthropicClient(KEY).maxRetries).toBe(1);
  });
});
