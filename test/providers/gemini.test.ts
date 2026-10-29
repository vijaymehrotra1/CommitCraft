import { describe, expect, it, vi } from 'vitest';
import { CommitCraftError } from '../../src/core/errors';
import type { BuiltPrompt, GenerateOptions } from '../../src/core/types';
import { GEMINI_BASE_URL, createGeminiProvider } from '../../src/providers/gemini';

// Not a real key. Assembled so no key-shaped literal lives in the repository.
const KEY = ['AQ', '.', 'FAKE-gemini-key-for-tests-0123456789'].join('');
const prompt: BuiltPrompt = { system: 'SYSTEM-PROMPT-TEXT', user: 'USER-PROMPT-TEXT-with-diff' };
const options: GenerateOptions = { apiKey: KEY, model: 'gemini-3.5-flash-lite', maxTokens: 4096 };

type FetchFn = typeof fetch;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const completion = (content: string | null, finish = 'stop'): unknown => ({
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 66, completion_tokens: 8, total_tokens: 74 },
});

/** Google's OpenAI-compatible endpoint wraps errors in an ARRAY (observed live on 2026-10-28). */
const googleError = (code: number, status: string, message: string): unknown => [{ error: { code, message, status } }];

function providerWith(fetchImpl: FetchFn): ReturnType<typeof createGeminiProvider> {
  return createGeminiProvider(fetchImpl);
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

describe('GeminiProvider.generate: request', () => {
  it('posts to the pinned Google endpoint with the key only in the Authorization header', async () => {
    const fetchMock = vi.fn<FetchFn>().mockResolvedValue(json(200, completion('docs: fix typo in README')));
    const text = await providerWith(fetchMock).generate(prompt, options);

    expect(text).toBe('docs: fix typo in README');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(url).toBe(`${GEMINI_BASE_URL}/chat/completions`);
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${KEY}` });
  });

  it('sends the system and user prompts, the model and the token budget, and nothing Gemini rejects', async () => {
    const fetchMock = vi.fn<FetchFn>().mockResolvedValue(json(200, completion('fix: x')));
    await providerWith(fetchMock).generate(prompt, options);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'gemini-3.5-flash-lite',
      messages: [
        { role: 'system', content: 'SYSTEM-PROMPT-TEXT' },
        { role: 'user', content: 'USER-PROMPT-TEXT-with-diff' },
      ],
      max_tokens: 4096,
    });
    // gemini-3.8-flash answered 400 "Thinking level MINIMAL is not supported", so no reasoning_effort is ever sent.
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('temperature');
  });

  it('refuses to follow redirects (an Authorization header must never be forwarded to another host)', async () => {
    const fetchMock = vi.fn<FetchFn>().mockResolvedValue(json(200, completion('fix: x')));
    await providerWith(fetchMock).generate(prompt, options);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('error');
  });

  it('trims the answer', async () => {
    const fetchMock = vi.fn<FetchFn>().mockResolvedValue(json(200, completion('  fix: x \n')));
    expect(await providerWith(fetchMock).generate(prompt, options)).toBe('fix: x');
  });

  it('does not call the API when already cancelled', async () => {
    const fetchMock = vi.fn<FetchFn>();
    const controller = new AbortController();
    controller.abort();
    const error = await failureOf(providerWith(fetchMock).generate(prompt, { ...options, signal: controller.signal }));
    expect(error.code).toBe('CANCELLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GeminiProvider.generate: responses', () => {
  const cases: Array<[string, unknown, string]> = [
    ['an empty answer', completion(''), 'EMPTY_RESPONSE'],
    ['a null answer', completion(null), 'EMPTY_RESPONSE'],
    ['a whitespace-only answer', completion('  \n '), 'EMPTY_RESPONSE'],
    ['a cut-off answer (finish_reason length) with text', completion('docs', 'length'), 'MALFORMED_RESPONSE'],
    ['a cut-off answer with no text', completion('', 'length'), 'EMPTY_RESPONSE'],
    ['a safety block (content_filter)', completion(null, 'content_filter'), 'PROVIDER_REFUSED'],
    ['no choices', { choices: [] }, 'PROVIDER_ERROR'],
    ['no choices field', { usage: {} }, 'PROVIDER_ERROR'],
    ['a non-object body', 'just text', 'PROVIDER_ERROR'],
    ['content that is not a string', { choices: [{ finish_reason: 'stop', message: { content: { not: 'text' } } }] }, 'PROVIDER_ERROR'],
  ];

  it.each(cases)('maps %s to %s', async (_label, body, code) => {
    const fetchMock = vi.fn<FetchFn>().mockResolvedValue(json(200, body));
    expect((await failureOf(providerWith(fetchMock).generate(prompt, options))).code).toBe(code);
  });

  it('maps a 200 response that is not JSON to PROVIDER_ERROR', async () => {
    const fetchMock = vi.fn<FetchFn>().mockResolvedValue(new Response('<html>oops</html>', { status: 200 }));
    expect((await failureOf(providerWith(fetchMock).generate(prompt, options))).code).toBe('PROVIDER_ERROR');
  });
});

describe('GeminiProvider.generate: error mapping (bodies are the real ones Google returned)', () => {
  const cases: Array<[string, () => Response, string, RegExp]> = [
    [
      'a bad key (Google answers 400, not 401)',
      () => json(400, googleError(400, 'INVALID_ARGUMENT', 'Please pass a valid API key')),
      'INVALID_API_KEY',
      /Set API Key/,
    ],
    [
      'an expired key (also a 400)',
      () => json(400, googleError(400, 'INVALID_ARGUMENT', 'API key expired. Please renew the API key.')),
      'INVALID_API_KEY',
      /Set API Key/,
    ],
    ['401', () => json(401, googleError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.')), 'INVALID_API_KEY', /Set API Key/],
    ['403', () => json(403, googleError(403, 'PERMISSION_DENIED', 'Permission denied.')), 'INVALID_API_KEY', /not allowed|Set API Key/],
    [
      'an unknown model',
      () => json(404, googleError(404, 'NOT_FOUND', 'models/x is not found for API version v1main')),
      'MODEL_NOT_FOUND',
      /commitcraft\.model.*gemini-3\.5-flash-lite/,
    ],
    ['429 (free-tier quota)', () => json(429, googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded')), 'RATE_LIMITED', /free tier.*limit|rate limit/i],
    [
      '429 with retry-after',
      () => json(429, googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded'), { 'retry-after': '23' }),
      'RATE_LIMITED',
      /Wait 23 seconds/,
    ],
    [
      '503 high demand (gemini-3.8-flash did this)',
      () => json(503, googleError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.')),
      'PROVIDER_ERROR',
      /busy.*gemini-3\.5-flash-lite|HTTP 503/s,
    ],
    ['500', () => json(500, googleError(500, 'INTERNAL', 'Internal error')), 'PROVIDER_ERROR', /HTTP 500/],
    [
      'another 400 (reasoning level unsupported)',
      () => json(400, googleError(400, 'INVALID_ARGUMENT', 'Thinking level MINIMAL is not supported for this model.')),
      'PROVIDER_ERROR',
      /HTTP 400.*fewer staged changes/s,
    ],
    ['an error body that is an object, not an array', () => json(404, { error: { code: 404, message: 'x', status: 'NOT_FOUND' } }), 'MODEL_NOT_FOUND', /commitcraft\.model/],
    ['an HTML error page', () => new Response('<html>Bad gateway</html>', { status: 502 }), 'PROVIDER_ERROR', /HTTP 502/],
    ['an empty error body', () => new Response('', { status: 418 }), 'PROVIDER_ERROR', /HTTP 418/],
  ];

  it.each(cases)('maps %s', async (_label, makeResponse, code, message) => {
    const fetchMock = vi.fn<FetchFn>().mockImplementation(() => Promise.resolve(makeResponse()));
    const error = await failureOf(providerWith(fetchMock).generate(prompt, options));
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
  });

  it('records the HTTP status on the cause so the log can show it', async () => {
    const fetchMock = vi.fn<FetchFn>().mockResolvedValue(json(503, googleError(503, 'UNAVAILABLE', 'busy')));
    const error = await failureOf(providerWith(fetchMock).generate(prompt, options));
    expect((error.cause as { status?: number }).status).toBe(503);
  });

  it('never puts the key, the prompt or the provider message in an error message', async () => {
    const leaky = googleError(400, 'INVALID_ARGUMENT', `bad key ${KEY} for ${prompt.user} PROVIDER-SECRET-WORDING`);
    for (const response of [json(400, leaky), json(500, leaky), json(429, leaky), json(404, leaky), json(200, completion(null, 'content_filter'))]) {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(response);
      const error = await failureOf(providerWith(fetchMock).generate(prompt, options));
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain('USER-PROMPT-TEXT');
      expect(error.message).not.toContain('SYSTEM-PROMPT-TEXT');
      expect(error.message).not.toContain('PROVIDER-SECRET-WORDING');
    }
  });
});

describe('GeminiProvider.generate: network, timeout, cancellation', () => {
  /** A fetch that never answers and rejects with the signal's reason, like the real one. */
  const hanging: FetchFn = (_url, init) =>
    new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject((init?.signal as AbortSignal).reason as Error));
    });

  it('maps a network failure to NETWORK', async () => {
    const fetchMock = vi.fn<FetchFn>().mockRejectedValue(new TypeError('fetch failed'));
    const error = await failureOf(providerWith(fetchMock).generate(prompt, options));
    expect(error.code).toBe('NETWORK');
    expect(error.message).toMatch(/internet connection or proxy/);
  });

  it('maps a timeout to TIMEOUT', async () => {
    const error = await failureOf(providerWith(hanging).generate(prompt, { ...options, timeoutMs: 40 }));
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toMatch(/timed out/);
  });

  it('maps a user cancellation to CANCELLED, not TIMEOUT or NETWORK', async () => {
    const controller = new AbortController();
    const pending = failureOf(providerWith(hanging).generate(prompt, { ...options, signal: controller.signal, timeoutMs: 5_000 }));
    setTimeout(() => controller.abort(), 20);
    expect((await pending).code).toBe('CANCELLED');
  });

  it('reports CANCELLED when the signal aborted, whatever error fetch raised', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<FetchFn>().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new TypeError('fetch failed'));
    });
    expect((await failureOf(providerWith(fetchMock).generate(prompt, { ...options, signal: controller.signal }))).code).toBe('CANCELLED');
  });

  it('keeps the original error as the cause for the logger', async () => {
    const original = new TypeError('fetch failed');
    const fetchMock = vi.fn<FetchFn>().mockRejectedValue(original);
    expect((await failureOf(providerWith(fetchMock).generate(prompt, options))).cause).toBe(original);
  });
});
