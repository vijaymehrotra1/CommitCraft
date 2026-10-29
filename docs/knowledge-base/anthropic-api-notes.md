# Anthropic API notes

Implementation: `src/providers/anthropic.ts`. Prompts: `src/core/prompt.ts`. The SDK is
`@anthropic-ai/sdk` (1.3.0 at the time of writing). Model facts below come from the Claude API reference
available while building (model table cached 2026-10-06); re-check them before changing defaults.

## The request we send

```ts
client.messages.create(
  {
    model,                                  // commitcraft.model, default "claude-opus-5-5"
    max_tokens,                             // 4096 (commit) / 8192 (PR): includes thinking tokens
    system,                                 // fixed instructions (stable across requests)
    messages: [{ role: 'user', content }],  // overview + redacted diff in <diff> tags
    output_config: { effort: 'low' },
  },
  { signal, timeout: 60_000 },
);
```

Deliberately **absent**: `temperature`, `top_p`, `top_k` (rejected with a 400 on current models), `thinking`
(Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 think by default; a thinking budget or `{type: "disabled"}` is
rejected), `tool_choice`, prefill (rejected). Streaming is not used: the answer is short.

## Why these defaults

- **`claude-opus-5-5`**: the reference default for current work. It is a setting, so users can pick
  `claude-sonnet-5-5` (balance) or `claude-haiku-5-5` (fastest and cheapest). All three accept the request
  above unchanged.
- **`effort: "low"`**: commit messages need little deliberation, and effort controls thinking depth and
  total tokens. Opus 5.5 would otherwise default to `medium`.
- **`max_tokens` is generous because thinking tokens count against it.** A tiny limit (say 512) can be
  exhausted by thinking and yield no text. `extractText` turns that case into an `EMPTY_RESPONSE` with advice.
- **Older models** (for example Haiku 4.5) reject `output_config.effort`. The 400 message says to switch back
  to a current model.
- **Cost.** Input is the diff (capped at 40,000 characters for commits, 60,000 for PRs, roughly 10k to 15k
  tokens at most). A typical commit is a few thousand tokens. At the cached table's Opus 5.5 rates
  ($4 / $20 per million input/output tokens) that is around a cent or two; Haiku 5.5 is far cheaper.

## Client construction (security-relevant)

```ts
new Anthropic({
  apiKey,
  baseURL: 'https://api.anthropic.com',
  logLevel: 'off',
  maxRetries: 1,
  openTelemetry: { traces: false, propagation: false },
})
```

- An **explicit `apiKey`** stops the SDK reading `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an
  `ant auth login` profile. Do not also pass `authToken`; they are mutually exclusive.
- **`baseURL` is pinned.** It otherwise defaults to `ANTHROPIC_BASE_URL`, which could silently send the user's
  key and diffs elsewhere (for example a gateway configured for another tool).
- **`logLevel: 'off'`**: `ANTHROPIC_LOG=debug` would otherwise log request details.
- **OpenTelemetry off.** The SDK creates spans by default and, with `ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE=content`
  in the environment, puts the full prompt into them. The extension host is shared, so another extension's tracer could
  read it. Without an explicit option the SDK reads those variables; with one it does not. Propagation is also off so no
  trace context rides on the request.
- **Standard headers still sent.** The SDK adds `X-Stainless-*` headers (library version, OS, architecture, runtime and
  runtime version) and honours `ANTHROPIC_CUSTOM_HEADERS`; both go only to the pinned endpoint.
- **`maxRetries: 1`** (SDK default is 2) with a 60 s timeout. Timeouts are retried, so the worst case is about
  two minutes, and the user can cancel any time.
- `new Anthropic(...)` is created per call from the key just read from SecretStorage; the key is never cached
  outside it.
- A type quirk: in a *type* position `Anthropic.RateLimitError` (and the other error names) refers to an
  unrelated shared interface, not the error class. Use `instanceof Anthropic.X` for narrowing and structural
  types for annotations.

## Response handling

| `stop_reason` / content | Result |
| --- | --- |
| `end_turn` with text | Joined text blocks (thinking blocks are ignored) |
| `refusal` | `PROVIDER_REFUSED` ("declined to write a message...") |
| `max_tokens`, no text | `EMPTY_RESPONSE` |
| `max_tokens`, partial text | `MALFORMED_RESPONSE` (cut off) |
| `model_context_window_exceeded` | `PROVIDER_ERROR` |
| No text at all | `EMPTY_RESPONSE` |

Then `core/response.ts` cleans and validates (fences, preamble, subject length, Conventional Commits, PR sections).

## Error mapping

| SDK error | `CommitCraftError.code` | User sees (summary) |
| --- | --- | --- |
| `APIUserAbortError` or aborted signal | `CANCELLED` | silent |
| `APIConnectionTimeoutError` | `TIMEOUT` | request timed out; check connection |
| `APIConnectionError` | `NETWORK` | could not reach the provider; check internet/proxy |
| `AuthenticationError` (401) | `INVALID_API_KEY` | key rejected; **Set API Key** button |
| `PermissionDeniedError` (403) | `INVALID_API_KEY` | key not allowed for that model |
| `NotFoundError` (404) | `MODEL_NOT_FOUND` | check `commitcraft.model`; **Open Settings** button |
| `RateLimitError` (429) | `RATE_LIMITED` | wait N seconds (from `retry-after`) |
| `BadRequestError` (400) | `PROVIDER_ERROR` | rejected (HTTP 400): try fewer staged changes; older-model hint |
| 400 whose text says the credit balance is too low (observed live, not a 402), and 402 | `PROVIDER_ERROR` | "account has no credit left ... Plans & Billing" |
| 413 | `PROVIDER_ERROR` | request too large |
| 5xx / 529 | `PROVIDER_ERROR` | provider problems; try again |
| anything else | `PROVIDER_ERROR` | unexpected |

Messages never include the key, the prompt or the provider's raw message. The original error is kept as
`cause` (the logger records only its class name and HTTP status).

## Refusal fallbacks

The API has a server-side fallback for safety refusals (a beta, enabled with a beta header and a `fallbacks`
parameter). It is not enabled: it is model-specific, and with a user-configurable model it could turn a rare
refusal into a frequent 400. A refusal is reported clearly instead. Revisit if refusals show up in practice.

## Trying it for real

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run check:live
COMMITCRAFT_MODEL=claude-haiku-5-5 ANTHROPIC_API_KEY=sk-ant-... npm run check:live
```

`scripts/live-check.ts` runs the real pipeline and provider on the fixture diffs (including FAKE secrets, to
show masking) and prints the results. It is the only place `ANTHROPIC_API_KEY` is read, and it never prints it.
