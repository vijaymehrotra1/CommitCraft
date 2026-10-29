# QA

How CommitCraft was tested, what the AI generated versus what was independently validated, what the
independent review found, and what has **not** been verified. Numbers are from 2026-10-25 and every one can
be re-run with the command beside it.

## 1. Summary

| Check | Result | Re-run with |
| --- | --- | --- |
| TypeScript strict type check | clean | `npm run typecheck` |
| ESLint (type-aware; architecture rule: no `vscode` in `src/core` or `src/providers`; no `any`; no `console`) | clean | `npm run lint` |
| Unit tests | **794 passing** in 16 files | `npm test` |
| Coverage of `src/**` | **98.9%** statements, **95.7%** branches, **100%** functions | `npm run test:coverage` |
| Integration tests in a real VS Code 1.143.1 with a real Git extension and a real `git` | **16 passing** | `npm run test:integration` |
| False positives of secret masking on 482,291 lines of third-party code | **18 lines changed** (9 are doc examples that really are credentials; 9 are one parser's labels) | `npm run scan:fp -- node_modules/@anthropic-ai ...` |
| `npm audit --omit=dev` (what ships) | 0 vulnerabilities | `npm audit --omit=dev` |
| `.vsix` | 8 files, about 120 KB, no source or tests inside | `npm run package` |
| GitHub Actions CI (2026-10-29): unit tests, lint, build on Ubuntu, Windows and macOS (Node 20 and 22) plus the integration suite on Ubuntu | **7 of 7 jobs passing** after one fix | the **Actions** tab of the repository |
| Real **Google Gemini** call (2026-10-28, free key, `gemini-3.5-flash-lite`) | **verified end to end**: Conventional Commit message in 1.6 s, 4-section PR description in 1.2 s, 8 fake secrets masked, `.env`/`.pem`/`id_rsa` never read | `COMMITCRAFT_PROVIDER=gemini GEMINI_API_KEY=... npm run check:live` |
| Real **Anthropic** call (2026-10-28) | **partly verified**: endpoint reached, key accepted, error handling works on a real response; the account had no credit, so a successful generation is still unseen | `ANTHROPIC_API_KEY=... npm run check:live` |

## 2. Testing approach

```
            ┌──────────────────────────┐
            │ manual checklist         │  docs/manual-test-checklist.md (needs a real key and a human)
            ├──────────────────────────┤
            │ integration (16)         │  real VS Code, real Git extension, real git, temp repository
            ├──────────────────────────┤
            │ unit, VS Code layer (172)│  fake `vscode` module (test/mocks/vscode.ts) via a Vitest alias
            ├──────────────────────────┤
            │ unit, core + provider    │  pure functions, fixtures captured from real `git diff` output
            │ (622, incl. manifest)    │
            └──────────────────────────┘
```

Principles:
- **Tests first** for the diff parser and the redactor (Prompts 2 and 3), then for everything else.
- **Real inputs.** Diff fixtures are captured from real `git diff --cached` (`scripts/make-fixtures.sh`), so
  git's actual output (rename headers, quoted paths, a trailing TAB after paths with spaces, binary markers) is
  what the parser is tested on.
- **No secret-shaped literals in the repository.** Fake secrets are assembled from fragments at run time
  (`test/helpers/fakeSecrets.ts`); fixtures hold `{{FAKE_...}}` placeholders.
- **Negative tests are as important as positive ones.** The redactor has a long list of look-alikes that must
  not be masked, plus the false-positive scan over real code.
- **Hostile input.** Redaction, parsing and prompt building are tested with a megabyte of adversarial text and
  with prompt-injection payloads.

### Test inventory

| File | Tests | What it covers |
| --- | ---: | --- |
| `test/core/diff.test.ts` | 71 | parsing every git quirk, lock-file rules, truncation, fair budgeting, listing caps, notices |
| `test/core/redact.test.ts` | 151 | token formats, assignments, private keys, 40+ look-alikes, structure preservation, idempotence |
| `test/core/redact-review.test.ts` | 138 | regression tests for the review findings: new syntaxes, exemptions, key bodies, new tokens, sensitive paths, linear time |
| `test/core/prompt.test.ts` | 14 | prompt content, injection resistance, commit list handling |
| `test/core/response.test.ts` | 44 | fences, preamble, quotes, subject length, Conventional Commits, PR sections, images |
| `test/core/pipeline.test.ts` | 29 | the whole flow with a spy provider: no secret reaches the provider; limits; errors; cancellation |
| `test/core/settings.test.ts` | 45 | settings normalisation, providers and per-provider default models, API-key input validation |
| `test/core/repository.test.ts` | 37 | branch-name safety, repository selection by path |
| `test/providers/anthropic.test.ts` | 42 | request shape, every error mapping (including the no-credit 400), response shapes, hardened client (env variables, telemetry) |
| `test/providers/gemini.test.ts` | 36 | request shape and pinned endpoint, no redirects, every error mapping (using the real array-shaped bodies Google returned), response shapes, timeout and cancellation, no key or prompt in messages |
| `test/vscode/commands.test.ts` | 57 | the three commands with a fake VS Code: happy paths, every edge case, retry, busy guard, cancel, choosing Anthropic or Gemini (provider, key, model, prompt text) |
| `test/vscode/ui.test.ts` | 46 | error severity, buttons, log content, progress |
| `test/vscode/git.test.ts` | 28 | repository selection, Git API access, the git runner against a real child process |
| `test/vscode/gitChanges.test.ts` | 35 | staged and branch diff logic with a fake git |
| `test/vscode/extension.test.ts` | 6 | activation, logger |
| `test/manifest.test.ts` | 15 | `package.json` matches the code and the requirements, including the provider and model settings |
| `test/integration/suite/index.ts` | 16 | extension loads; commands; settings; real Git extension API; real git; hostile git config |

### Where tests are weakest (stated honestly)

- `src/vscode/commands.ts` and `ui.ts` run against a **fake** `vscode` module. The fake is only as faithful as my
  understanding of the real API; the integration suite checks the Git parts for real, but not the notifications.
- The real Anthropic API is not called by any automated test (see "Not verified").
- A mutation check (swapping redact and truncate) showed the pipeline-level test alone would not have caught that
  regression, because the real redactor masks an unterminated key to the end of its section. The ordering is
  guarded by the strict `processDiff` test; the unterminated-block rule is a second layer.

## 3. Requirements traceability

| Requirement (`docs/requirements.md`) | Implemented in | Verified by |
| --- | --- | --- |
| Generate commit message from staged changes into the Source Control box | `commands.ts`, `gitChanges.ts`, `pipeline.ts` | `commands.test.ts`, integration suite (real staged diff, fake AI) |
| SCM title-bar button and Command Palette entry | `package.json` | `manifest.test.ts`; manual checklist B1, B6 |
| Generate PR description into a new Markdown tab (Summary, Changes, Testing, Risks) | `commands.ts`, `gitChanges.ts`, `prompt.ts`, `response.ts` | `commands.test.ts`, `response.test.ts`, integration suite |
| Set API key in SecretStorage; prompt when missing | `secrets.ts`, `commands.ts` | `commands.test.ts`; manual A1 to A6 |
| Settings: style, maxSubjectLength, baseBranch, model | `package.json`, `settings.ts` | `settings.test.ts`, `manifest.test.ts`, integration suite |
| Edge: no workspace or repository | `git.ts: selectRepository` | `git.test.ts`, `commands.test.ts` |
| Edge: no staged changes | `pipeline.ts: noStagedChangesError` | `pipeline.test.ts`, `commands.test.ts` (no progress UI shown, no network) |
| Edge: very large diff truncated per file, user told | `diff.ts: processDiff`, `diffNotices` | `diff.test.ts`, `pipeline.test.ts` |
| Edge: binary and lock files named only | `diff.ts`, `redact.ts` | `diff.test.ts`, `pipeline.test.ts` |
| Edge: missing or invalid key | `commands.ts: ensureApiKey`, `anthropic.ts` | `commands.test.ts`, `anthropic.test.ts` |
| Edge: network error, timeout, 429, provider error | `anthropic.ts: mapAnthropicError` | `anthropic.test.ts` (15 mappings) |
| Edge: empty or malformed AI response | `anthropic.ts: extractText`, `response.ts` | `anthropic.test.ts`, `response.test.ts`, `pipeline.test.ts` |
| Edge: multiple repositories | `core/repository.ts`, `git.ts` | `repository.test.ts`, `git.test.ts` |
| Key only in SecretStorage, never in settings, code or logs | `secrets.ts`, `ui.ts` | `manifest.test.ts`, `anthropic.test.ts`, `commands.test.ts` (log content) |
| Secrets masked; `.env` and key files never sent | `redact*.ts`, `sensitive-paths.ts`, `pipeline.ts` | `redact*.test.ts`, `pipeline.test.ts` (every FAKE secret absent from the prompt) |
| No telemetry; nothing stored except the key | whole project; SDK OpenTelemetry off | `manifest.test.ts` (no telemetry package), `anthropic.test.ts` (OTel off) |
| README states diffs go to the AI provider | `README.md` | review |
| Progress notification, cancellable | `ui.ts: runWithProgress` | `ui.test.ts`, `commands.test.ts` |
| Core is pure TypeScript with no VS Code dependency | `src/core/**` | ESLint `no-restricted-imports` |
| Works on Windows, macOS and Linux | platform-neutral code, `.gitattributes` | **Linux only run locally**; CI matrix configured for all three (see "Not verified") |

## 4. Security testing

| Threat | Test |
| --- | --- |
| Secret reaches the provider | `pipeline.test.ts` asserts every FAKE secret is absent from system and user prompts for the `secrets` fixture, for secrets in file names, commit subjects and branch names, and when truncation would have cut a key |
| Key or prompt in an error message or log | `anthropic.test.ts`, `commands.test.ts`, `ui.test.ts` |
| Endpoint, key source, logging, telemetry controlled by environment variables | `anthropic.test.ts` stubs `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_LOG` and the OpenTelemetry variables |
| Prompt injection | `prompt.test.ts` (tag break-out in diff, commits and branch names), `response.test.ts` (images neutralised) |
| Git argument injection | `repository.test.ts`, `gitChanges.test.ts` (no git command runs for a hostile branch name), integration suite, `git.test.ts` (no shell) |
| Hostile git config changes the diff | integration suite sets `diff.external`, `color.ui=always`, `diff.mnemonicPrefix`, `diff.submodule=log` for both flows |
| Hostile input freezes the extension host | `redact-review.test.ts` feeds 1 MB of repeated `eyJ-`, `BEGIN` markers, `password="`, `<password>`, `--password` (each finished in milliseconds after the fix; the first two took minutes before) |

## 5. Review findings (Prompt 7)

An independent, read-only agent was given the code and the brief but none of my conclusions, and was told to
reproduce every claim. It reported 5 HIGH, 11 MEDIUM and about 20 LOW findings. I re-verified each HIGH
finding by writing a failing test first (83 failed against the old code) before fixing it.

### HIGH (all fixed, one regression test group each)

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| H1 | Assignment rule missed `=>` (PHP/Ruby), XML elements and attributes, SQL `PASSWORD '...'`, `--password value`, `DB_PASS`, `credential`, `_auth`, wrapped assignments, non-breaking spaces | New keyword set, operator and structure rules in `redact-assignments.ts`; `pass` needs a word boundary and a credential-looking value | `redact-review.test.ts` "HIGH 1" (19 inputs + 23 look-alikes) |
| H2 | "Not a secret" exemptions let real values through (`my_` prefix, leading `$`, base64 starting with `/`, hyphenated passphrases) and env-style values leaked after `&,;)}]`; `\b` blocked tokens touching `_` | Exemptions apply to the whole value only; variable references must be real (`${..}`, `$(..)`, `$UPPER`); paths must not be high-entropy; labels need underscores; env values run to whitespace; lookarounds replace `\b` | "HIGH 2" |
| H3 | Key body lines leaked when the hunk did not contain the `BEGIN` marker | Walk back from an `END` marker; mask PEM-shaped lines (60 to 80 base64 characters, mixed case); public keys and certificates stay readable | "HIGH 3" |
| H4 | No rule for Hugging Face, Slack and Discord webhooks, Google OAuth, and others | 10 new token formats | "HIGH 4" |
| H5 | `isSensitivePath` missed `.env_backup`, `secrets.json`, `credentials.json`, `service-account.json`, `kubeconfig`, `.docker/config.json`, `*.ppk`, `*.p8`, `my_id_rsa`, `keys.pem.bak`, `wp-config.php`, and more | New module `sensitive-paths.ts` with name patterns, data-file rules and backup-suffix handling | "HIGH 5" (36 flagged, 19 not flagged) |

### MEDIUM

| Finding | Status |
| --- | --- |
| JWT and one-line key regexes were quadratic (41 s at 400 KB) | **Fixed**: bounded quantifiers and a linear scan; every other new pattern is bounded too; tests assert 1 MB inputs finish quickly |
| Many-file diffs ignored the size limit (500 files gave 97 KB for a 40 KB budget; 20,000 gave 3 MB) | **Fixed**: file listings and path lengths are capped; test at 500, 5,000 and 20,000 files |
| Staged diff used the user's git config (external diff or colour gave "no staged changes") | **Fixed**: the staged diff now uses the Git extension's own binary with the same fixed flags as the branch diff (a deliberate change from using `repo.diff(true)`); integration test with hostile config |
| Any git failure was reported as "base branch not found" | **Fixed**: only exit status 1 from the probes means "not found"; others become `GIT_ERROR` |
| Oldest commits silently dropped; "older commits not shown" never printed | **Fixed**: newest 100 kept, shown oldest first, true total reported |
| Text typed while generating was overwritten | **Fixed**: re-check before writing; Replace, Open in New Tab, or keep |
| Restricted Mode support claimed "limited" but the Git extension is unsupported there | **Fixed**: declared unsupported (verified in the bundled Git extension's manifest). Not tried by hand in Restricted Mode |
| Non-ASCII API key (curly quote from a paste) passed validation then crashed the header | **Fixed**: plain ASCII required, with a clear message |
| SDK OpenTelemetry on by default (prompt content can reach spans) | **Fixed**: tracing and propagation off; regression tests |
| Trailing code fence stripped from PR descriptions | **Fixed**: only an unbalanced trailing fence is removed |
| `GIT_ERROR` said "see the log" but the log had nothing | **Fixed**: exit code and the first redacted stderr line are logged |

### LOW

Fixed: non-BMP (emoji) paths; `style: "Plain"` case; stale busy flag after an error toast; `LC_ALL=C` for git;
hunk headers inside a key block; branch names neutralised in the prompt; markdown images neutralised in PR
descriptions; keychain failures get a specific message; dead code (`MISSING_API_KEY`, a redundant retry entry,
a duplicate constant); a vacuous test replaced by one that checks something; documentation that overstated
cancellation and git-config isolation.

Accepted or documented, not changed:
- The redaction notice can over-count (a secret in a file name is masked in the header lines, the overview and
  the content, and each is counted). It is cosmetic.
- Cancelling is possible only once the progress notification is showing (not during the Git extension wait or the
  key prompt).
- `parseSection`, `processDiff` and `redactPrivateKeys` are longer than the "keep functions small" guideline.
- `DiffFile.modeChangeOnly` and `BranchChanges.baseRef` are tested but unused by production code.
- A giant single *content* line (minified code) is dropped whole: the file shows its header and the truncation
  marker. The previous comment claimed otherwise; the comment is corrected.
- `auth` and `sig` were not added as keywords (too many harmless uses); see the documented gaps.

### The reviewer also confirmed (checked and found fine)

Git runs through `execFile` with argument arrays and no shell; `baseBranch` validation rejects option-like,
shell-like and reflog forms; redaction happens before truncation, and file names, commit subjects and branch
names are redacted; sensitive, binary and lock files send names only; real-git fixtures (renames with spaces,
symlinks, submodules, CRLF, latin1 content, empty files, mode changes, tab and emoji names, combined diffs)
parsed correctly and leaked nothing; provider response shapes map to clear errors; no path from the API key to a
log, notification or prompt.

## 6. What the AI generated, and what was validated

| Artifact | Generated by | Validated by |
| --- | --- | --- |
| All source code and tests | Claude Code | tests, strict type check, lint, coverage, the false-positive scan, mutation spot-checks, the integration suite in a real VS Code |
| Diff fixtures | `scripts/make-fixtures.sh` from real `git` output | inspected by eye; counts asserted in tests |
| Git extension API assumptions | recalled from memory | checked against VS Code 1.143.1 and its bundled Git extension; two assumptions were wrong or incomplete and were corrected |
| SDK behaviour | read from the installed SDK's type declarations | regression tests with stubbed environment variables |
| Security design | Claude Code | an independent review agent; its findings are in section 5 |
| Documentation | Claude Code | cross-checked against the code; the claims in `docs/knowledge-base/*` carry a verification status |
| `docs/ai-development.md` | Claude Code, at Vijay's request on 2026-10-28, from `docs/ai-log.md` and this file | to be read and corrected by Vijay; its figures match this file |
| **Not done by the AI:** the manual checklist, the demo video, the final Git history | Vijay | see `docs/submission-checklist.md` |

## 6b. Gemini provider: what the live calls found

The Gemini provider was built from live probes, not documentation alone, because the docs left the key details open.
The calls found four things that shaped the code and that no unit test written from assumptions would have caught:
a bad key is an HTTP **400**, not 401; errors arrive as a JSON **array**; `reasoning_effort: minimal` is rejected by
`gemini-3.8-flash`; and that model was overloaded (503) or hung when tested, so the default is `gemini-3.5-flash-lite`.
Details and the full error table: `docs/knowledge-base/gemini-api-notes.md`. Not verified live: a 429 (free-tier quota),
which is covered by a unit test only.

**Privacy consequence:** on the free tier Google may use prompts for product improvement and humans may review them.
The README, the setting description and the key prompt say so; use the free tier for demos and non-confidential code.

## 7. Not verified (read this before relying on the project)

1. **A successful real Anthropic generation has not been seen.** On 2026-10-28 `npm run check:live` reached the live
   Anthropic API with a valid key, but the account's credit balance was zero, so every request was refused with HTTP 400
   "credit balance is too low" before any text was generated. That confirmed the endpoint, the authentication and the error
   path (and exposed a real bug: the API reports this as a 400, not a 402, so the message was misleading; now fixed and
   tested). It does not prove the live Anthropic API accepts the exact request (model name, `output_config.effort`) or that
   its response is parsed correctly. **Gemini, by contrast, was verified end to end** with a free key (see section 1), so
   the pipeline, the prompts and the response cleaning are proven against a real model; only the Anthropic-specific request
   remains unseen. Add credit and re-run `npm run check:live` to close it.
2. **Windows and macOS: only the automated checks have run, in CI.** On 2026-10-29 GitHub Actions ran typecheck, lint,
   all unit tests and the build on Ubuntu, Windows and macOS with Node 20 and 22, and all passed. The integration
   suite (a real VS Code) runs on Ubuntu only, and the manual checklist has been run on no platform but Linux, so
   the real extension has not been seen working on Windows or macOS. The first CI run also caught a real bug (the
   integration script never built `dist/`; see `docs/knowledge-base/dev-gotchas.md`), now fixed.
3. **The interactive flows with real notifications and input boxes** (progress, Cancel, the key prompt, modal
   confirmations) are covered by unit tests with a fake `vscode` module and by the manual checklist, not by an
   automated test in a real window.
4. **Restricted Mode** behaviour is declared (and the Git extension's own declaration was verified) but not tried by
   hand.
5. **Proxies:** requests use Node's `fetch`; corporate proxies work only as far as VS Code's proxy support does.
6. **Secret masking is best effort.** The known gaps are listed in `docs/knowledge-base/secret-patterns.md`.
7. **Package size:** vsce prints an advisory that `dist/extension.js` is about 420 KB (the minified bundle
   including the SDK). Reviewed and accepted.
8. **Dev-tool advisories:** `npm audit` reports issues in dev-only tooling (the Vitest runner and vsce's Azure
   authentication libraries). None of it is bundled into the `.vsix`.
