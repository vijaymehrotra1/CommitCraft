# Security model

CommitCraft handles two sensitive things: the user's **source code** (it is sent to a third party) and
the user's **API key**. This note states the threats, the mitigations, and what is left over.

## Trust boundaries

```
 developer's machine                                          third party
 ┌──────────────────────────────────────────────────────┐   ┌────────────────────┐
 │ repo files ──git──► raw diff ──► CommitCraft core ───┼──►│ api.anthropic.com  │
 │                         ▲            (redact, drop,   │   │ (sees the redacted │
 │ SecretStorage ── key ───┘             truncate)       │   │  diff + the key)   │
 │ VS Code settings ──► model, branch, style            │   └────────────────────┘
 └──────────────────────────────────────────────────────┘
```

The only network destination is the one provider selected in `commitcraft.provider`: `https://api.anthropic.com` or
`https://generativelanguage.googleapis.com`. Both URLs are constants, not settings. Everything the provider sees is the
system prompt (fixed text), the user prompt (overview, redacted diff, commit subjects) and that provider's key as the auth
header. A key is stored per provider and is never sent to the other one.

## Threats and mitigations

| # | Threat | Mitigation | Where | Tested by |
| --- | --- | --- | --- | --- |
| 1 | A secret in the diff reaches the provider | Mask known token formats, private keys, URL credentials and `key=value` assignments before sending; redact file names, commit subjects and branch names too | `core/redact.ts`, `core/pipeline.ts` | `redact.test.ts`, `pipeline.test.ts` (every FAKE secret absent from the prompt) |
| 2 | A whole secret file (`.env`, key, cert) is sent | Never read into the prompt; only the name is mentioned | `core/redact.ts: isSensitivePath`, `core/diff.ts` | `redact.test.ts`, `diff.test.ts`, `pipeline.test.ts` |
| 3 | Truncation splits a multi-line secret so it is no longer recognised | Redact first, truncate after; unterminated `BEGIN PRIVATE KEY` masks to the end of its file section | `core/diff.ts: processDiff` | `diff.test.ts` (checked by mutation, see `docs/qa.md`) |
| 4 | Redaction breaks the diff so the model is confused | Replace values only; keep every line and its `+`/`-`/space prefix | `core/redact.ts` | `redact.test.ts` (structure tests) |
| 5 | The API key is stored somewhere readable | SecretStorage only; no setting holds a key (manifest test) | `vscode/secrets.ts`, `test/manifest.test.ts` | manifest test |
| 6 | The API key appears in a log, error or notification | Errors carry only codes and fixed text; the logger records codes, counts and class names; unexpected error text is passed through `redact()` before logging | `core/errors.ts`, `vscode/ui.ts` | `anthropic.test.ts` ("never puts the key in an error message") |
| 7 | The key and diffs are redirected by an environment variable | Explicit `apiKey`, pinned `baseURL`, `logLevel: 'off'` | `providers/anthropic.ts: createAnthropicClient` | `anthropic.test.ts` (stubs `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_LOG`) |
| 8 | Prompt injection through diff content ("ignore previous instructions...") | The diff is wrapped in `<diff>` tags and declared untrusted data; `</diff>` inside content is neutralised; the model has no tools, so the worst outcome is a misleading draft that the developer reads before committing | `core/prompt.ts` | `prompt.test.ts` |
| 9 | A malicious repo sets `commitcraft.baseBranch` to `--output=/x` (git argument injection) | Branch names are validated (no leading `-`, restricted charset) before any git call; git runs with an argument array and no shell; the extension is disabled in Restricted Mode (untrusted workspaces), as the Git extension it depends on is | `core/repository.ts`, `vscode/gitChanges.ts`, `package.json` | `repository.test.ts`, `gitChanges.test.ts`, integration suite, `manifest.test.ts` |
| 10 | A user's git config changes the diff text (external diff tool, textconv, colours, prefixes, submodule log) | Both the staged diff and the branch diff run the Git extension's git binary with fixed flags: `--no-color --no-ext-diff --no-textconv --submodule=short -M` and explicit prefixes (a plain `git diff --cached`, which is what the extension API's `repo.diff(true)` does, returned unreadable text and "no staged changes" with `diff.external` or `color.ui=always`) | `vscode/gitChanges.ts` | integration suite (sets hostile config for both flows) |
| 11 | Supply chain | One runtime dependency (the official SDK, bundled); lockfile committed; `npm audit --omit=dev` clean; no install scripts of our own | `package.json` | manifest test; audit result in `docs/qa.md` |
| 12 | Telemetry or tracking | None of ours, and a test fails if a telemetry package is added. The SDK's OpenTelemetry tracing and trace-context propagation are switched off (otherwise the SDK can put prompt content into spans that a tracer registered by another extension in the shared host could read) | `test/manifest.test.ts`, `providers/anthropic.ts` | manifest test, `anthropic.test.ts` (stubs the OpenTelemetry variables) |
| 13 | A message is committed without review | Nothing is committed automatically; replacing existing box text needs confirmation | `vscode/commands.ts` | manual checklist |
| 14 | A hostile file, branch name or commit message freezes the shared extension host (regex backtracking on `eyJ-eyJ-...` or repeated `BEGIN` markers) | Every pattern starts at a literal or a bounded prefix and every risky quantifier is bounded; the one-line key scan never rescans | `core/redact*.ts` | `redact-review.test.ts` (1 MB adversarial inputs finish in milliseconds; before the fix two of them took minutes) |
| 15 | Prompt injection makes the PR description contain a markdown image whose URL is fetched when the preview opens (an exfiltration channel) | Markdown and HTML images outside code blocks are replaced by their alt text | `core/response.ts` | `response.test.ts` |
| 16 | A diff that touches thousands of files makes the request huge (cost, HTTP 413) | The file listings and path lengths are capped; the diff body is limited to the budget | `core/diff.ts` | `diff.test.ts` (500, 5,000 and 20,000 files) |
| 17 | A pasted key containing a curly quote or zero-width character crashes the request header (and could be mistaken for an auth problem) | Input validation requires plain printable ASCII | `core/settings.ts` | `settings.test.ts` |
| 18 | A workspace setting redirects the key and diffs to another endpoint | Provider URLs are constants. For Gemini, `redirect: "error"` so an `Authorization` header is never forwarded to another host; for Anthropic, the SDK client pins `baseURL` | `providers/gemini.ts`, `providers/anthropic.ts` | `gemini.test.ts`, `anthropic.test.ts` |
| 19 | A key for one vendor is sent to the other | One SecretStorage entry per provider; each command reads only the selected provider's key | `vscode/secrets.ts` | `commands.test.ts` ("never sends one provider the other provider's key") |
| 20 | The user sends confidential code to a free tier that may be reviewed by humans | Warning in the setting description, in the "Set API Key" prompt and in the README; the confirmation after each run names the provider | `package.json`, `vscode/secrets.ts`, `vscode/commands.ts` | `commands.test.ts`, `manifest.test.ts` |

## Residual risks (be honest about these)

- **Redaction is best effort.** It is pattern based. See `secret-patterns.md` for the secret types and
  formats it does not catch. The README tells users to review what they commit and not to use the tool on
  code they may not share.
- **The provider sees your code.** Anthropic's or Google's data handling applies from the moment the request is sent.
  CommitCraft cannot change that and says so in the README. On Gemini's **free tier** Google says it may use prompts to
  improve its products and that human reviewers may read them (see `gemini-api-notes.md`).
- **The SDK sends standard client headers** to api.anthropic.com (SDK version, operating system, architecture,
  language runtime), and it honours `ANTHROPIC_CUSTOM_HEADERS` from the environment. This is Anthropic's SDK
  metadata, not CommitCraft telemetry; it goes only to the pinned endpoint.
- **Heuristic false positives** mask harmless values (for example `lastToken = "?JSX"`). This costs context,
  not safety.
- **The key sits in the OS keychain**, so malware running as the user can read it like any other secret
  there. There is no "Clear API Key" command yet. If the keychain is unavailable (common on Linux and WSL) CommitCraft says so and does not fall back to any other storage.
- **A compromised Git extension or VS Code** is out of scope.
- **Notices about what was sent are advisory**: they are shown after generation, not before.

## Rules for future changes

1. Anything new that goes into a prompt must pass through `redact()` (or be a fixed string).
2. Anything new that is logged or shown must be a code, a count, a class name or a fixed string.
3. New settings that reach git or the network must be validated and considered for `restrictedConfigurations`.
4. Add a FAKE-secret test for every new place data can enter the prompt.
