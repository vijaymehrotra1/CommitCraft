# CLAUDE.md – CommitCraft

## What this project is
A VS Code extension that drafts commit messages and PR descriptions from staged Git
changes using an AI model. Full requirements: docs/requirements.md. Read it before
starting any feature.

## Tech stack
- TypeScript (strict mode), Node 20, VS Code Extension API (engine ^1.90.0)
- Bundler: esbuild
- Unit tests: Vitest (for pure logic in src/core)
- Integration tests: @vscode/test-electron (a few smoke tests only)
- AI provider: Anthropic Messages API via official @anthropic-ai/sdk
- Packaging: @vscode/vsce

## Architecture rules
- src/core/      Pure logic. NO imports from 'vscode'. Fully unit tested.
    diff.ts        parse and filter diffs, skip binary/lock files, truncate
    redact.ts      mask secrets before sending to AI (public API + provider token formats)
    redact-keys.ts, redact-assignments.ts, redact-shared.ts   the private-key and `name = value` parts of redaction
    sensitive-paths.ts   files that are never sent (env files, keys, credentials)
    prompt.ts      build prompts from diff + settings
    response.ts    clean and validate AI output
    pipeline.ts    diff -> redact -> truncate -> prompt -> provider -> response (one shared flow)
    errors.ts      CommitCraftError + error codes
    types.ts       shared types incl. the `AiProvider` interface
    format.ts      constants shared by prompts and response cleaning (commit types, PR sections)
    settings.ts    normalize/validate raw settings values and the API-key input (pure)
    repository.ts  pure helpers: pick a repo root for a path, validate branch names
- src/providers/ AI providers behind one interface `AiProvider { generate(prompt, opts) }`
    anthropic.ts  Anthropic Messages API via the official SDK
    gemini.ts     Google Gemini via its OpenAI-compatible endpoint, plain `fetch` (no SDK)
- src/vscode/    Thin layer: commands, Git API access, SecretStorage, settings, UI
    commands.ts    the three commands, guard against double runs, error + retry flow
    git.ts         Git extension API, repository selection, `createRunGit` (no shell)
    gitChanges.ts  staged diff + branch diff via an injected `runGit` (no 'vscode' import: unit tested)
    gitTypes.ts    the structural subset of the Git extension API we use
    secrets.ts, settings.ts, ui.ts, logger.ts
- src/extension.ts  activate/deactivate, registers commands only

## Where to look
- docs/architecture.md (diagrams, decisions), docs/knowledge-base/ (security model, secret patterns,
  diff format, Git API, Anthropic API notes, dev gotchas), docs/qa.md, docs/manual-test-checklist.md.
- Commands: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run package`,
  `npm run test:integration` (real VS Code), `npm run check:live` (real API, needs your key).
- Keep functions small. Prefer pure functions. No classes unless they hold state.

## Coding conventions
- No `any`. Use explicit return types on exported functions.
- Errors: use a typed `CommitCraftError` with a `code` and a user-friendly message.
  Every error shown to the user must say what happened and what to do next.
- No console.log in committed code; use the extension's OutputChannel logger.
- Never log diffs, prompts or API keys.
- Commit messages in this repo follow Conventional Commits.

## Security guardrails (never violate)
- API keys only via context.secrets (SecretStorage). Never in settings, code, tests or logs.
- Always run redact() on diff content before it leaves the machine.
- Never send .env, *.pem, *.key, id_rsa or similar files, even redacted.
- Do not add dependencies without telling me why and checking their license.
- Test fixtures must use fake secrets clearly marked FAKE.

## Testing rules
- Every function in src/core gets unit tests, including edge and negative cases.
- Use realistic diff fixtures in test/fixtures/.
- Run `npm test` and `npm run lint` before saying a task is done.
- If a test fails, fix the code, not the test, unless the test is wrong; explain which.

## How to work with me
- Before writing code for a new feature, give a short plan and wait for my OK.
- Make small, focused changes. One feature per task.
- After a task, list: files changed, how to test it manually, any open risks.
- If something in the requirements is unclear, ask instead of guessing.
- Suggest a Conventional Commit message for each completed task.

## Lessons learned (update as we go)
- Redact BEFORE truncating. Truncating first can cut a private-key block in half so the
  BEGIN/END pattern no longer matches and the key body leaks. `processDiff` enforces the order.
- Redaction must keep every line and its `+`/`-`/space prefix, or hunk headers (`@@ -a,b +c,d @@`)
  stop matching the body. Replace values, never delete lines.
- Anthropic SDK client (`createAnthropicClient`): pass an explicit `apiKey` (that alone stops the SDK
  reading ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profiles; do NOT also pass
  `authToken`, they are mutually exclusive), pin `baseURL` (it otherwise defaults to ANTHROPIC_BASE_URL
  and could send the key and diffs to an endpoint the user never chose) and set `logLevel: 'off'`
  (ANTHROPIC_LOG=debug would otherwise log request details). Regression tests cover all three.
- In the SDK's types, `Anthropic.RateLimitError` etc. in a TYPE position is an unrelated shared
  interface, not the error class. Use `instanceof Anthropic.X` for narrowing and structural types
  (`{ headers?: Headers }`) or `InstanceType<typeof Anthropic.APIError>` for annotations.
- Current Claude models always think and thinking tokens count against `max_tokens`. Keep
  `max_tokens` generous (4096+) and set `output_config.effort` to "low" so a small commit message
  is fast. Do not send `temperature`/`top_p`/`top_k` or a `thinking` budget; newer models reject them.
- Settings that reach a git command (`commitcraft.baseBranch`) can come from a workspace's
  `.vscode/settings.json`. Validate the value (no leading `-`) before passing it to git. The extension is declared
  unsupported in Restricted Mode (the built-in Git extension is too); keep the validation anyway.
- Read BOTH diffs (staged and branch) with `createRunGit` and the fixed flags in `gitChanges.ts`. The Git extension
  API's `repo.diff(true)` is a plain `git diff --cached`, which `diff.external`, `color.ui=always`,
  `diff.mnemonicPrefix` or `diff.submodule=log` turn into text the parser cannot read ("no staged changes").
- `git log --reverse --max-count=N` returns the wrong window (the oldest commits of the newest N). Read newest first
  and reverse in code. Only exit status 1 of `rev-parse --verify --quiet` / `merge-base` means "not found"; every
  other git failure is a `GIT_ERROR`.
- Code that runs on untrusted text (redaction, diff parsing) must be linear. Bound every quantifier that can fail
  after a long scan, anchor on a literal, never use a lazy `.*?` across a long line, and add a 1 MB adversarial
  test with a time budget. Use `(?<![A-Za-z0-9])`, not `\b` (an underscore is a word character).
- "Not a secret" exemptions in redaction apply to the WHOLE value only, and a looks-like-a-path or looks-like-a-label
  shortcut must not exempt a high-entropy or hyphenated value. After widening any rule run `npm run scan:fp` and
  compare the changed-line count (18 on the reference corpus).
- The SDK's OpenTelemetry is on by default and can put prompt content into spans a tracer from ANOTHER extension could
  read. The client is built with `openTelemetry: { traces: false, propagation: false }`; keep the regression tests.
- Model output is untrusted too: PR descriptions have markdown and HTML images neutralised, because an injected diff
  comment could otherwise make the preview fetch an attacker's URL.
- Provider endpoints are constants, never settings (a workspace could redirect the key and the diffs). One SecretStorage
  key per provider; read only the selected provider's key. `commitcraft.model` is empty by default = the provider's default.
- Gemini facts that came only from live calls (docs/knowledge-base/gemini-api-notes.md): a bad key is HTTP 400 (not
  401); errors are a JSON ARRAY; `reasoning_effort: minimal` is rejected by some models, so none is sent;
  `gemini-3.5-flash-lite` is the reliable default and `gemini-3.8-flash` was overloaded. The free tier may be read by humans
  and used for training: keep the warnings in the setting description, the key prompt and the README.
- Billing problems come back from Anthropic as HTTP 400 "credit balance is too low" (not 402). Documentation-derived
  assumptions about error codes are exactly what a fake client cannot catch: run `npm run check:live` after any
  provider change.
- Test factories must not give defaults to values a test sets to `undefined`; a silent `replace()` in a test helper
  can make a test pass or fail for the wrong reason (assert that the substitution happened).
- Do not put secret-shaped literals in the repo, even fake ones: GitHub push protection and secret
  scanners match on format. Tests build fakes at runtime from fragments (test/helpers/fakeSecrets.ts).
