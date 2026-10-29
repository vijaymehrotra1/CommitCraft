# Google Gemini API notes

Implementation: `src/providers/gemini.ts`. Tests: `test/providers/gemini.test.ts`. Selected with
`commitcraft.provider = "gemini"`. **Everything marked *observed* was seen in real calls on 2026-10-28 with a free
Google AI Studio key**; Google changes models and limits often, so re-check with
`COMMITCRAFT_PROVIDER=gemini GEMINI_API_KEY=... npm run check:live` before relying on a detail.

## How it is called

| | |
| --- | --- |
| Endpoint | `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` (Google's OpenAI-compatible endpoint) |
| Auth | `Authorization: Bearer <key>` (works with the new `AQ.`-style keys; never put the key in the URL) |
| Body | `{ model, messages: [{role: "system"}, {role: "user"}], max_tokens }` |
| Answer | `choices[0].message.content`, `choices[0].finish_reason` |
| Client | plain `fetch` (Node 20), no SDK, no dependency |
| Pinned | the URL is a constant, not a setting, so a workspace cannot redirect the key and the diffs |
| Redirects | `redirect: "error"`: an `Authorization` header is never forwarded to another host |
| Timeout | 60 s (`AbortSignal.timeout`), combined with the user's Cancel via `AbortSignal.any` |
| Retries | none: the user gets a clear message and a **Try Again** button |

Deliberately **not sent**: `reasoning_effort` (see below), `temperature`.

## Models

Google's models page (read 2026-10-28) recommends `gemini-3.5-flash-lite` and `gemini-3.8-flash` for new projects.

| Model | Observed |
| --- | --- |
| `gemini-3.5-flash-lite` (**default**) | about 1 s per call; accepts `max_tokens`, `max_completion_tokens`, `reasoning_effort` `minimal` and `low`; gave a correct commit message every time, a correct 4-section PR description, and correct output with a tiny `max_tokens` (`finish_reason: "length"`) |
| `gemini-3.8-flash` | **unreliable when tested**: HTTP 503 "This model is currently experiencing high demand", one call that hung past 30 s, and HTTP 400 "Thinking level MINIMAL is not supported for this model". Usable by setting `commitcraft.model`, but not a safe default |

`GET /v1beta/openai/models` lists about 60 models for the key; being listed does not prove a free key can generate with
a model or what its quota is. The free-tier limits are shown only in AI Studio (aistudio.google.com/rate-limit);
Google's rate-limit page gives no per-model numbers.

## What the API returns (observed)

Errors arrive as a JSON **array**, not an object:

```json
[{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}]
```

| Situation | HTTP | `status` | CommitCraft code |
| --- | --- | --- | --- |
| Bad or expired key | **400** (not 401) | `INVALID_ARGUMENT`, message contains "API key" | `INVALID_API_KEY` |
| Unauthenticated / forbidden | 401 / 403 | `UNAUTHENTICATED` / `PERMISSION_DENIED` | `INVALID_API_KEY` |
| Unknown model | 404 | `NOT_FOUND` | `MODEL_NOT_FOUND` |
| Free-tier quota or rate limit | 429 | `RESOURCE_EXHAUSTED` | `RATE_LIMITED` (reads `retry-after` if present) |
| Model overloaded | 503 | `UNAVAILABLE` ("high demand") | `PROVIDER_ERROR` ("busy ... try again, or use gemini-3.5-flash-lite") |
| Other 5xx | 5xx | | `PROVIDER_ERROR` |
| Unsupported parameter | 400 | `INVALID_ARGUMENT` | `PROVIDER_ERROR` |
| Malformed request | 400 | `INVALID_ARGUMENT` | `PROVIDER_ERROR` |
| Network failure / timeout / Cancel | | | `NETWORK` / `TIMEOUT` / `CANCELLED` |

A bad key being a **400** is why the mapper looks at the message (`/api key/i` with `INVALID_ARGUMENT`) and not only at
the status. The 429 case could not be forced in testing; it follows Google's documented status and is covered by a
unit test, not by a live call.

Answer handling: `finish_reason: "length"` with text is a cut-off answer (`MALFORMED_RESPONSE`), without text
`EMPTY_RESPONSE`; `content_filter` is `PROVIDER_REFUSED`; a null or empty answer is `EMPTY_RESPONSE`; anything that is
not the expected shape is a `PROVIDER_ERROR`. Messages shown to the user are our own fixed text: the provider's wording,
the key and the prompt are never echoed, and the log gets only the HTTP status.

## Privacy: the free tier is different (read before using real code)

From Google's Gemini API terms (read 2026-10-28):

- **Free (unpaid) tier:** Google may use submitted prompts and responses to improve its products, and "human reviewers
  may read, annotate, and process your API input and output" (Google says the data is disconnected from your account,
  key and project first).
- **Paid tier:** Google says it does not use prompts or responses to improve its products; data is logged for a limited
  time to detect and prevent abuse. The page does not say whether human reviewers can see paid-tier data.

CommitCraft masks secrets and never sends `.env`, key or certificate files, but it still sends the rest of your diff.
So the free tier is fine for demos, open-source and personal code, and **not for confidential or proprietary code**.
The warning is shown in the setting's description, in the "Set API Key" prompt and in the README. Terms change: check
the current page.

## Re-verifying

```bash
COMMITCRAFT_PROVIDER=gemini GEMINI_API_KEY=... npm run check:live
COMMITCRAFT_PROVIDER=gemini COMMITCRAFT_MODEL=gemini-3.8-flash GEMINI_API_KEY=... npm run check:live
```

The first live run (2026-10-28, `gemini-3.5-flash-lite`) produced a Conventional Commit message in 1.6 s, a complete
PR description in 1.2 s, masked 8 fake secrets, and never read the `.env`, `.pem` or `id_rsa` fixtures.
