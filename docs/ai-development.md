# How AI was used to build CommitCraft

> Drafted by Claude Code at Vijay Mehrotra's request, from `docs/ai-log.md` and `docs/qa.md`, then to be reviewed
> by Vijay. Every figure here can be re-run; the command is beside it in `docs/qa.md`.

## 1. Summary

CommitCraft was built with Claude Code as the main author of the code, tests and documentation. I set the
requirements (`docs/requirements.md`) and the standing rules (`CLAUDE.md`), made the product decisions, and
treated everything the AI produced as something to check, not to trust.

| Who | Did what |
| --- | --- |
| Claude Code | Wrote all source code, tests, fixtures, scripts and documentation |
| A second, separate Claude agent | Reviewed the finished code independently and read-only (the brief's Prompt 7) |
| Me | Wrote the brief and requirements, chose the scope, asked for the review and the fixes, chose the Gemini free tier, ran the live checks, and own the submission |
| Tests, type checker, linter, a real VS Code, real `git`, two real APIs | Decided what was actually correct |

The result: 794 unit tests, 16 integration tests in a real VS Code, strict TypeScript and ESLint clean, 98.9%
statement coverage. Those numbers measure the tests, not the AI. What matters more is what the checks caught,
described below.

## 2. How the work was organised

1. **Requirements first.** `docs/requirements.md` states the problem, the three user journeys, the edge cases and
   the security rules. The AI was told to read it before any feature.
2. **`CLAUDE.md` as standing memory.** It holds the stack, the architecture rule (`src/core` never imports
   `vscode`), the security guardrails (key only in SecretStorage, always redact, never send `.env`/`.pem`/`id_rsa`) and
   the testing rules (tests for every core function, fix the code and not the test). A "Lessons learned" section grew
   during the project (section 6).
3. **Tests against real inputs.** Diff fixtures came from real `git diff --cached` output
   (`scripts/make-fixtures.sh`), not hand-written diffs. The diff parser and redactor had tests written first.
4. **Independent review.** After the build, a separate agent with no access to my conclusions was told to reproduce
   every claim it made. I treated its report as untrusted input and wrote a failing test for each high-priority
   finding before fixing it.
5. **Real API calls.** Two providers were exercised live (`npm run check:live`). This found problems nothing else could.

## 3. What worked well

- **Real fixtures exposed real quirks early:** a trailing TAB after paths containing spaces, and octal-quoted
  unicode paths. A hand-written diff would have hidden both.
- **Reading the installed code rather than recalling it.** The AI read the Anthropic SDK's type declarations and the
  bundled Git extension's source instead of trusting memory. Several of its later corrections came from this.
- **Measuring instead of guessing.** Redaction false positives were measured on 482,291 lines of third-party code
  (`npm run scan:fp`): 18 changed lines, 9 of which are documentation examples that really are credentials.
- **Probing before building.** For Gemini the AI called the live API first and wrote the provider from the real
  responses.
- **A reviewer that started cold.** It found five HIGH-severity redaction gaps and other issues that the build
  session's own tests could not, because they came from outside that session's assumptions.

## 4. Where the AI was wrong, and how each mistake was caught

The AI's log lists 18 numbered mistakes from the build and fix rounds, plus two found only by live API calls.
The most instructive ones:

| Mistake | How it was caught | What changed |
| --- | --- | --- |
| Planned the newest TypeScript, Vitest and vsce because npm offered them | Reading peer-dependency ranges before installing (typescript-eslint rejects TS 6.1 and above; Vitest 5 and vsce 5 need Node 22, the project targets Node 20) | Pinned TS 5.9, Vitest 3, vsce 3 |
| Private-key redaction counted an already-masked block again on a second pass | Idempotency test (`redact(redact(x))`) | Count a block only if a body line was not already masked |
| Planned a final redaction pass over the whole prompt as a safety net, which would have treated the rest of the prompt as key body | Reasoning about the idempotency result before writing the pipeline | Redact each single-line field individually |
| Fence-stripping destroyed a legitimate code fence in a commit body | A response-cleaning test with such a body | Only a short lead-in such as "Here is the commit message:" counts as a preamble |
| First `CLAUDE.md` lesson said to pass `authToken: null` to the SDK | Reading `ClientOptions`: `authToken` and `apiKey` are mutually exclusive | Corrected the lesson; tests stub the SDK's environment variables |
| Believed the Git API's `diffBetween` returns diff text | Recalled the typings: without a path it returns a change list | Run the extension's own git binary with fixed flags; covered by an integration test |
| Test helper default parameters swallowed an explicit `undefined`, twice (also a `replace()` that matched nothing) | Tests failing for the wrong reason | Rule added to `CLAUDE.md` |
| Widening the redactor masked public keys and certificates, and `pass: "passed"` in Vitest's own source | An existing test; re-running the false-positive scan | Public keys stay readable; `pass` needs a credential-looking value |
| Read an integration run piped through `head` as a failure | Re-running without the pipe: all 16 passed (SIGPIPE) | Noted in `docs/knowledge-base/dev-gotchas.md` |

A mutation check was also useful for what it showed about my own tests. Swapping redact and truncate was caught by
the `processDiff` test but not by the pipeline test, so the ordering rule is guarded by one strict test and a
second, weaker layer. `docs/qa.md` says so.

## 5. What the independent review and the live calls found

**The review (Prompt 7).** 5 HIGH, 11 MEDIUM and about 20 LOW findings. Examples:
- redaction missed secrets in PHP `=>`, XML, SQL and command-line flag forms, and key bodies without a `BEGIN` line;
- two regular expressions were quadratic: **41 seconds on 400 KB** of hostile input, which would freeze the shared
  extension host;
- the Git API's `repo.diff(true)` is a plain `git diff --cached`, so a user's `diff.external` or `color.ui=always`
  produced "no staged changes";
- the Anthropic SDK's OpenTelemetry is on by default and can put prompt content into spans another extension could read.

I re-verified each HIGH finding with a failing test first (83 tests failed against the old code), then fixed one
group at a time. I also checked three of its claims in the installed software myself before documenting them.
The reviewer's process was imperfect: it ran about 12 hours before delivering (the session had stalled and I had to
ask it to wrap up), and it did not audit three VS Code-layer test files beyond seeing them pass.

**The live calls.** These found two things a fake client cannot:
- **Anthropic:** an account with no credit gets HTTP **400** "credit balance is too low", not 402 as the
  documentation implied. Users would have been told to shorten their diff. The provider now recognises it.
- **Gemini:** a bad key is HTTP **400**, not 401; errors arrive as a JSON **array**; `reasoning_effort: minimal` is
  rejected by some models; the model the docs recommended (`gemini-3.8-flash`) was overloaded or hung, so the default
  is `gemini-3.5-flash-lite`.

Both are the same lesson: tests built from assumptions pass and ship the wrong behaviour.

**The first CI run.** Pushing to GitHub found one more: the integration script bundled the tests but never the
extension, so it only passed locally because an old `dist/` was lying around. On a fresh checkout two tests failed with
`Cannot find module 'dist/extension.js'`. I reproduced it by deleting `dist/`, fixed the script, and all 7 CI jobs then
passed. Same lesson again: a suite can look green because of state it never created.

## 6. What I changed in the process because of the mistakes

`CLAUDE.md` "Lessons learned" is the durable output. Each rule traces to a real failure above:
redact before truncating; redaction keeps every line and its prefix; harden the SDK client (explicit `apiKey`, pinned
`baseURL`, logging off, OpenTelemetry off); validate settings that reach git; read both diffs through the fixed-flag
runner; classify git failures by exit status; keep untrusted-text code linear with a 1 MB adversarial test; run the
false-positive scan after widening a rule; treat model output as untrusted; no secret-shaped literals in the repo; run
`npm run check:live` after any provider change.

## 7. Where I departed from the brief, and why

- **One session instead of eight gated prompts.** At my request the brief's one-prompt-at-a-time review gates were
  collapsed into a single build session. As a result `CLAUDE.md`'s rule "give a short plan and wait for my OK" was not
  followed for that build. The independent review (Prompt 7) was then run separately.
- **The staged diff is read with the Git extension's own git binary, not `repo.diff(true)`.** The API call cannot be
  protected from the user's git configuration. Recorded in `docs/architecture.md` (decision 5). If the Git API call
  is preferred for the demo story, `getStagedDiff` is the one place to change, at the cost of the protection.
- **A second provider (Google Gemini) was added.** The brief lists multiple providers in the UI as out of scope. I
  chose this so the project could be tested end to end without paying for an API; the free tier's privacy terms were
  explained first, and the README, the setting description and the key prompt all carry the warning.

## 8. What was and was not verified

Full detail is in `docs/qa.md`, section 7. In short:

- **Verified end to end:** the pipeline, prompts and response cleaning against a real model (Gemini, 2026-10-28).
- **Partly verified:** Anthropic. The endpoint, key and error path work, but the account had no credit, so a
  successful generation has not been seen and the exact request (model name, `output_config.effort`) is unproven.
- **Verified in CI (2026-10-29):** typecheck, lint, unit tests and build pass on Ubuntu, Windows and macOS with Node
  20 and 22, and the integration suite passes on Ubuntu.
- **Not run:** the real extension on Windows or macOS (the integration suite and the manual checklist were Linux
  only), Restricted Mode by hand, and the interactive flows in a real window apart from the manual checklist.
- **Known limit:** secret masking is best effort; the gaps are listed in `docs/knowledge-base/secret-patterns.md`.

## 9. What I would do differently

- Run `npm run check:live` as soon as a provider exists, not at the end. Two of the most user-visible bugs were found
  only that way.
- Keep the review gates. Collapsing them saved time but removed the points where a wrong assumption (the TypeScript
  version, the SDK options, the Git API) would have been challenged earlier.
- Start the independent review earlier and give it a time limit.
- Add a test-helper rule on day one: no default values for parameters a test may set to `undefined`.

## 10. Disclosure

No pre-existing work was used. The project started from the brief; the brief's own text (requirements, `CLAUDE.md`,
prompts) is the starting point. All code, tests and documentation in this repository were generated by Claude Code
and reviewed, directed and accepted by me, as described above. `docs/ai-log.md` is the dated record this summary is
built from.
