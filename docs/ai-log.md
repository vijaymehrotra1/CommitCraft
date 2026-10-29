# AI Log

> **Status: DRAFT written by Claude Code from the build session. Vijay: review every entry, correct what is
> wrong, and add your own (what you asked, what you decided, what you changed by hand).
> `docs/ai-development.md` was first left for you to write in your own words, as the brief asks. On 2026-10-28 you
> asked Claude Code to write it, and it did, from this log and `docs/qa.md`. Read it, correct it, and make sure it
> says what you would say.**
>
> Entry template (from the brief):
>
> ```
> ## [Date] – [Prompt / task]
> - What I asked:
> - What the AI did well:
> - What it got wrong:
> - How I caught it (test, review, manual run):
> - What I changed (code, CLAUDE.md rule, prompt):
> ```

## 2026-10-24 – Prompts 1 to 6 and 8, built in one session
- **What I asked:** "Create the VS Code extension project from the brief, everything completed with the flow, all the
  docs and a knowledge base, and CLAUDE.md." (The brief's one-prompt-at-a-time review gates were collapsed into
  one session at the user's request; CLAUDE.md's "wait for my OK" rule was therefore not followed for this build.)
- **What the AI did well:** Generated test fixtures from *real* `git diff --cached` output instead of
  hand-writing diffs, which exposed git quirks early (a trailing TAB after paths containing spaces, octal-quoted
  unicode paths). Wrote tests before implementation for the diff parser. Read the installed SDK's type
  declarations instead of trusting memory. Verified the Git extension API assumptions by running the code
  against a real VS Code and a real git binary. Measured redaction false positives on 482k lines of
  third-party code instead of guessing.
- **What it got wrong, how it was caught, what changed** (each was fixed in the same session):

| # | Mistake | How it was caught | Fix / rule |
| --- | --- | --- | --- |
| 1 | Planned to use TypeScript 7 / Vitest 5 / vsce 5 because npm offered them | Reading peer-dependency ranges before installing: typescript-eslint rejects TS ≥ 6.1; Vitest 5 and vsce 5 need Node 22 but the project targets Node 20 | Pinned TS 5.9, Vitest 3, vsce 3 (`docs/knowledge-base/dev-gotchas.md`) |
| 2 | A Python heredoc inside a bash command collided with the `EOF` markers of the script it was editing, so bash ran stray lines | The command failed loudly; checked for stray files (none) | Used the Edit tool for multi-line file changes |
| 3 | Private-key redaction counted an already-masked block again on a second pass | The idempotency test (`redact(redact(x))` must change and count nothing) | Count a block only if some body line was not already masked |
| 4 | First CLAUDE.md lesson said to pass `authToken: null` to the SDK | Reading the SDK's `ClientOptions`: `authToken` and `apiKey` are mutually exclusive, and an explicit `apiKey` already stops env lookup | Corrected the lesson; added tests that stub `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_LOG` |
| 5 | Planned a final redaction pass over the whole prompt as a safety net, but redaction keeps `BEGIN`/`END` markers so a second pass would treat the rest of the prompt as key body | Reasoning about the idempotence test result before writing the pipeline | Redact each single-line field (paths, subjects, branch) individually; unterminated key blocks now end at the next `diff --git` |
| 6 | The fence-stripping logic treated any line ending in `:` before a code fence as a preamble, so a body containing `Example:` followed by a code block was destroyed | A response-cleaning test with a legitimate fence in a commit body | Only a short lead-in ("Here is the commit message:") counts |
| 7 | `Anthropic.RateLimitError` used as a type annotation resolved to an unrelated interface, causing wrong types and unsafe-any lint errors | `tsc` and ESLint | Structural types and `InstanceType<typeof Anthropic.APIError>`; recorded in CLAUDE.md |
| 8 | Believed the PR flow could use the Git API's `diffBetween` for the full text | Recalled the typings: without a path it returns a change list, not text | Run the extension's own git binary with an argument array and fixed flags; verified in the integration suite |
| 9 | A test helper default parameter swallowed an explicit `undefined`, so a "repo with no commits" test passed the wrong input | The test failed with an unexpected error code | Removed the default; noted in dev-gotchas |
| 10 | The integration runner failed with `Cannot find module '<workspace>'` | The error text, then checking the environment: the shell was started by VS Code and inherits `ELECTRON_RUN_AS_NODE=1` | The runner clears that variable; documented |
| 11 | A mutation check (swap redact and truncate) was caught by the `processDiff` test but NOT by the pipeline test, because the real redactor masks an unterminated key to the end | Deliberately breaking the ordering and re-running the suite | Documented that the ordering is guarded by the `processDiff` test and the unterminated-block rule is a second layer (`docs/qa.md`) |

- **What I changed in CLAUDE.md:** Lessons learned now holds the redact-before-truncate rule, value-only
  masking, the SDK client hardening rule, the SDK type quirk, the branch-name validation rule and the
  no-secret-shaped-literals rule. The architecture list now matches the code.

## 2026-10-24 and 25 – Prompt 7: independent AI QA and review, then the fixes
- **What I asked:** Prompt 7 from the brief, run as a *separate* read-only agent that got the code and the brief but
  none of my conclusions, with instructions to reproduce every claim, and then "fix the high-priority findings one at
  a time, adding a test for each".
- **What the reviewer did well:** It found things my own tests could not, because they came from outside my
  assumptions: five HIGH redaction gaps (PHP `=>`, XML, SQL, CLI flags, a `my_` prefix treated as a placeholder, key
  bodies without a `BEGIN` line, missing token formats and sensitive file names), two quadratic regexes (41 seconds on
  400 KB), the SDK putting prompt content into OpenTelemetry spans, and that `repo.diff(true)` is a plain
  `git diff --cached` (it read the bundled Git extension's source to show it) so `diff.external` or `color.ui=always`
  gave "no staged changes". Every claim came with an input and the actual output.
- **What it got wrong or left open:** It ran for about 12 hours of wall-clock time before delivering (the session
  had stalled; I had to ask it to wrap up) and its report arrived twice. It did not audit three of the VS Code-layer
  test files beyond seeing them pass. A few LOW items are judgement calls (function length, an over-counting notice).
- **How I handled it:** I treated the report as untrusted input, not instructions. I wrote a failing test for every
  HIGH item first (83 tests failed against the old code, which independently confirmed the report), then fixed one
  group at a time. I checked three claims myself in the installed software before putting them in docs: the Git
  extension declares `untrustedWorkspaces.supported: false`, the SDK has an `openTelemetry` option that defaults to on,
  and the SDK sends `X-Stainless-*` headers and honours `ANTHROPIC_CUSTOM_HEADERS`.
- **What it cost me, and what the checks caught while fixing:**

| # | My mistake during the fix round | How it was caught | Fix / rule |
| --- | --- | --- | --- |
| 12 | The broader `pass` keyword created a new false positive (`pass: "passed"` in Vitest's own source) | Re-running the 482k-line false-positive scan after the change | `pass` needs a credential-looking value; the scan became `npm run scan:fp` |
| 13 | Widening the redactor made it mask public keys and certificates (same shape as private key bodies), breaking an existing test | The existing "does not mask a PUBLIC key block" test | Track explicit PUBLIC KEY / CERTIFICATE blocks and leave them readable |
| 14 | A new test put an added line *between* a key body and its END marker, which is not what real hunks look like | Reasoning about the walk-back rule before running it | Fixed the test, not the code |
| 15 | I used `--ignore-submodules=none` where `--submodule=short` was needed to override `diff.submodule=log` | Re-reading what the reviewer's reproduction actually needed, before implementing | Corrected the flag in tests and code |
| 16 | The same default-parameter trap as before (`makeContext(key = API_KEY)`) and a `replace('A.', body)` helper that silently matched nothing | Tests failing for the wrong reason | Rules added to CLAUDE.md and dev-gotchas |
| 17 | A mock reset helper did not clear call history of every mock, so assertions saw calls from earlier tests | Failing `not.toHaveBeenCalled` assertions | `mockClear` for mocks that keep their implementation |
| 18 | I read an integration run piped through `head -40` as a failure (exit code 1) | Re-running without `head`: all 16 passed. `head` had closed the pipe (SIGPIPE) | Noted in dev-gotchas |

- **What I changed:** the redaction code (split into focused modules), the git layer (both diffs through the fixed-flag
  runner, correct failure classification, correct commit ordering and total), the commands (re-check before
  overwriting, busy flag), the SDK client (OpenTelemetry off), the manifest (unsupported in Restricted Mode), plus
  docs and `CLAUDE.md` lessons. Dispositions for every finding are in `docs/qa.md` section 5.
- **One decision for Vijay:** the brief's Prompt 5 says to read the staged diff through the `vscode.git` API. I now read
  it with the Git extension's own git binary instead, because the API call cannot be protected from the user's git
  configuration. If you prefer the API call for the demo narrative, `getStagedDiff` is the one place to change, but
  you would give up the protection and the integration test for it. This is recorded in `docs/architecture.md`
  (decision 5).

## 2026-10-28 – First real API call (`npm run check:live`)
- **What I asked:** run the live check with a real key.
- **What happened:** all three requests failed with HTTP 400. A small diagnostic script (same request through the SDK,
  printing only the error body) showed the reason: "Your credit balance is too low". The key worked; the account had no
  credit.
- **What it got wrong:** I had assumed billing problems arrive as HTTP 402 (the API documentation I was working from says
  so). The live API sends a 400 `invalid_request_error`, so users with no credit would have been told to "try again with
  fewer staged changes" and to check their model setting. No unit test could have caught this, because the fake client
  only returned what I imagined.
- **How I caught it:** only by calling the real API.
- **What I changed:** the provider recognises the credit message (by wording, since the API gives no distinct error type)
  and shows fixed, accurate advice; a test uses the exact text the API returned; the outdated 402 test was updated; the
  QA doc now says what the live call did and did not prove.

## 2026-10-28 – Adding Google Gemini (a free key) as a second provider
- **What I asked:** "we will go with the Gemini free tier API key", after I explained the plan and the free-tier privacy terms.
- **What the AI did well:** it read Google's docs, then did not trust them: it probed the live API (with the key as an
  environment variable only) before writing code, and built the provider and its tests from the real responses. The probes
  found: a bad key is HTTP **400** (the docs imply 401); errors are a JSON **array**; `gemini-3.8-flash` was overloaded (503),
  hung once and rejected `reasoning_effort: minimal`; `gemini-3.5-flash-lite` answered in about a second.
- **What it got wrong:** my first model recommendation (before probing) leaned on Google's "recommended for new projects" list,
  which includes `gemini-3.8-flash`; real calls showed that is not a reliable default. The docs page also could not confirm
  `max_tokens` or the error format at all.
- **How I caught it:** only by calling the real API. Unit tests built from assumptions would have passed and shipped a
  wrong error mapping.
- **What I changed:** a second provider behind the same interface (plain `fetch`, no dependency, pinned URL, no redirects),
  a `commitcraft.provider` setting, one stored key per provider, an empty `commitcraft.model` meaning "the provider's
  default", free-tier warnings in three places, a Gemini mode for `npm run check:live`, 69 new tests, and docs. The live run
  produced a correct commit message and PR description.
- **Scope note for Vijay:** the brief lists multiple providers in the UI as out of scope. This is a deliberate, small
  extension so the project can be tested without paying; say so in the demo.

## 2026-10-29 – First CI run on GitHub (found a bug the local runs hid)
- **What I asked:** push the repository to GitHub. CI ran on Ubuntu, Windows and macOS (Node 20 and 22) plus the
  integration suite.
- **What happened:** the six unit/lint/build jobs passed on all three systems. The integration job failed: two tests
  that activate the extension reported `Cannot find module '.../dist/extension.js'`.
- **What it got wrong:** `npm run test:integration` bundled only the test files, never the extension (`dist/` is
  gitignored). It passed locally for days because an old `dist/` was lying around, so the suite may have been testing a
  stale bundle. The AI had written the script and described the suite as proving the packaged extension loads.
- **How I caught it:** only on a fresh checkout in CI. The job log showed which tests failed; reading `esbuild.mjs`
  gave the cause; hiding `dist/` locally reproduced the same two failures; the fix was checked the same way.
- **What I changed:** `test:integration` now builds the extension first (`fix(test)` commit), a note in
  `docs/knowledge-base/dev-gotchas.md`, and the CI result in `docs/qa.md`. All 7 CI jobs then passed.

