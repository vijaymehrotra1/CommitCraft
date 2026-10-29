# Submission checklist (deadline: 30 October, end of day)

Status as of 2026-10-24. **Done** means verified by a command you can re-run. **You** means it needs you.

| Item from the brief | Status | How to verify / what to do |
| --- | --- | --- |
| All tests and lint pass | **Done** | `npm run typecheck && npm run lint && npm test` (794 unit tests); `npm run test:integration` (16 tests in a real VS Code) |
| `.vsix` installs cleanly in a fresh VS Code window | **You** (build verified) | `npm run package`, then follow manual checklist section F. The integration run already loads the extension in a clean VS Code with an isolated profile |
| No API keys or secrets in the repo or Git history | **You** (current files checked) | See "Secret search" below. Run it again after your last commit |
| README, architecture.md, qa.md and ai-development.md complete | **Drafted: you must read it** | All four are written. `docs/ai-development.md` was drafted by Claude Code at your request from `docs/ai-log.md` and `docs/qa.md`; the brief asks for your own words, so read it, correct it and make it yours before submitting |
| Demo video under 5 minutes | **You** | `docs/demo-script.md`; use `scripts/make-demo-repo.sh` |
| ZIP includes the full project with the `.git` folder | **You** | See "Making the ZIP" below |
| Any pre-existing work disclosed | **Done** | None: the project started from the brief. The brief's own text (requirements, CLAUDE.md, prompts) is the starting point |

## Before you record or submit

- [ ] **Revoke the API keys you pasted into the chat** (Google AI Studio and the Anthropic Console), then create fresh
      ones for your own testing and enter them only through **CommitCraft: Set API Key**.
- [ ] Re-run the live check with your own key: `COMMITCRAFT_PROVIDER=gemini GEMINI_API_KEY=… npm run check:live`
      (Gemini was verified end to end during the build; Anthropic could not be, because that account had no credit).
- [ ] Walk through `docs/manual-test-checklist.md` (at least sections A to D) and note the result.
- [ ] Replace `publisher` in `package.json` (`vijay-mehrotra` is a placeholder) if you want your own publisher id.
- [ ] Add screenshots if you want them (the README has text placeholders; images must be absolute URLs for vsce).
- [ ] Read `docs/ai-log.md` and `docs/ai-development.md`, correct them, add your own entries, and make sure every
      "I" in them is something you actually did (sections 1, 5, 7 and 9 of `ai-development.md` especially).
- [ ] Read `docs/qa.md` section 7 ("Not verified") so you can say exactly what was and was not tested.
- [ ] Commit in logical steps (suggested Conventional Commit messages below).

## Secret search (current files and history)

```bash
# Current files, excluding dependencies and build output
git grep -nIE 'sk-ant-|sk-proj-|ghp_|github_pat_|glpat-|AKIA[0-9A-Z]{16}|xox[abprs]-|AIza[0-9A-Za-z_-]{35}|BEGIN [A-Z ]*PRIVATE KEY' -- . ':!package-lock.json'

# Whole history (run after you have committed)
git log -p --all | grep -nE 'sk-ant-|sk-proj-|ghp_|github_pat_|glpat-|AKIA[0-9A-Z]{16}|xox[abprs]-|AIza[0-9A-Za-z_-]{35}|BEGIN [A-Z ]*PRIVATE KEY'
```

Expected: matches only inside `src/core/redact.ts`, the tests' pattern lists, the docs that describe the
patterns, and this file. Those are regular expressions and format descriptions, not secrets. Test secrets are
assembled from fragments at run time and fixtures use `{{FAKE_...}}` placeholders, so no secret-shaped
literal exists in the repository. If you want stronger assurance, also run a dedicated scanner such as
`gitleaks detect` or `trufflehog git file://.`.

## Making the ZIP

```bash
npm run build:prod && npm run package        # produces commitcraft-0.1.0.vsix
cd .. && zip -r commitcraft-submission.zip CommitCraft \
  -x 'CommitCraft/node_modules/*' 'CommitCraft/.vscode-test/*' 'CommitCraft/coverage/*' 'CommitCraft/out/*'
```

This keeps `.git`, the sources, docs and the `.vsix`, and leaves out `node_modules` and caches (a reviewer runs
`npm install`). Check the ZIP contains `CommitCraft/.git`.

## Suggested Conventional Commit messages (CLAUDE.md: one per completed task)

```
chore: set up extension skeleton, tooling and CLAUDE.md
feat(core): parse, filter and truncate unified diffs
feat(core): mask secrets and flag sensitive files before sending
feat(core): build prompts and clean model responses
feat(providers): add Anthropic provider with error mapping
feat(vscode): add commit message command, API key storage and git access
feat(vscode): add PR description command
test: add integration smoke suite against a real VS Code and git
fix: address review findings (see docs/qa.md)
docs: add README, architecture, QA notes, knowledge base and demo script
chore: package 0.1.0
```
