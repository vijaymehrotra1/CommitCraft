# Demo script (under 5 minutes)

Target length 4:30. The brief asks for: problem, live demo, architecture, how AI helped, QA approach.

## Prepare (before recording)

- [ ] `npm run package`, install the `.vsix` in a clean VS Code window (so you demo what ships).
- [ ] `scripts/make-demo-repo.sh ~/commitcraft-demo`, then `code ~/commitcraft-demo`.
- [ ] Set `commitcraft.provider` to `gemini` (free key, about a second per message) and run **CommitCraft: Set API Key** beforehand,
      so the demo does not show a key being typed. Mention the free-tier privacy note (it is shown in the key prompt):
      fine for a demo repo, not for confidential code.
- [ ] Optional: show that switching `commitcraft.provider` to `anthropic` works the same way, with its own stored key.
- [ ] Close other notifications; increase the editor font size; have `docs/architecture.md` open in a Markdown preview, and the test results ready in a terminal.
- [ ] Do one dry run end to end. Generated text varies; do not script exact words.

## 0:00 to 0:30 · The problem

Say: "Developers write commit messages like `fix`, `wip` and `changes`, and skip PR descriptions because they are
tedious. History becomes unreadable, reviews slow down, changelogs hurt." Show `git log --oneline` of a messy
repo, or just the empty Source Control message box.

## 0:30 to 2:30 · Live demo

1. **Commit message (45 s).** Demo repo: staged `src/config.ts` and `.env`. Click the sparkle button. Point at the
   progress notification (cancellable). Read the generated message aloud. Say: "I review and edit; nothing is
   committed automatically."
2. **Privacy (45 s).** Point at the information message: "2 possible secrets were masked… `.env` was not sent."
   Open `src/config.ts` to show the fake AWS key and token that were in the diff. Say: "Those never left my
   machine. `.env` and key files are never read at all. Diffs do go to the Anthropic API, and the README says so."
3. **Settings (15 s).** Switch `commitcraft.style` to `plain` or lower `maxSubjectLength`, generate again.
4. **PR description (30 s).** Commit the staged work, run **Generate PR Description**. A Markdown tab opens with
   Summary, Changes, Testing, Risks. Say: "Compared against `main`, using the commits on the branch."
5. **Errors (15 s, optional).** Run it with nothing staged: a clear message that says what to do.

## 2:30 to 3:15 · Architecture

Show the mermaid diagram from `docs/architecture.md`. Say: "A pure TypeScript core that never imports VS Code,
a thin VS Code layer, and one provider interface. Both commands share one pipeline: parse the diff, drop
sensitive, binary and lock files, redact secrets, then truncate, build the prompt, call the model, clean the
answer. Redaction happens before truncation on purpose: truncating first could cut a private key in half."

## 3:15 to 4:00 · How AI helped

Say what actually happened (keep it honest; use your `docs/ai-development.md`):
- Claude Code built each module from the brief using `CLAUDE.md` for standing rules. Tests were written first
  against diffs captured from real `git`.
- What it got wrong and how it was caught: a redactor that double counted on a second pass (idempotency test);
  an over-eager fence stripper (a test with a code fence in a commit body); wrong assumptions about the SDK's
  environment variables (reading the SDK's types); test helper mistakes.
- Show one line you added to `CLAUDE.md` because of a mistake (the Lessons learned section).

## 4:00 to 4:30 · QA approach

Show the terminal: `npm test` (hundreds of tests), `npm run lint`, then mention the integration run against a real
VS Code and real git, a false-positive scan over 480,000 lines of third-party code, an independent AI review whose
findings were fixed with tests (for example a redaction pattern that took 41 seconds on a hostile file, and a git
configuration that made the staged diff unreadable), and the known gaps (`docs/knowledge-base/secret-patterns.md`). Close with the
roadmap: Marketplace, more providers, direct PR creation.

## Backup plan

If the API is slow or down during recording: run `npm run check:live` ahead of time and show its output, or
record the live part in two takes. If the sparkle button is missing, you are not in a Git repository window.
