# CommitCraft knowledge base

Reference notes for anyone (human or AI) working on this project. Start with `CLAUDE.md` for the rules
and `docs/requirements.md` for what the product must do. These notes record *why* things are the way
they are and the facts that were expensive to learn.

| Note | Read it when you are... |
| --- | --- |
| `security-model.md` | changing anything that touches the diff, the API key, git commands, logs or settings |
| `secret-patterns.md` | editing `src/core/redact.ts`, or asking "does CommitCraft mask X?" |
| `diff-format.md` | editing `src/core/diff.ts` or regenerating fixtures |
| `vscode-git-api.md` | editing `src/vscode/git*.ts` or the PR flow |
| `anthropic-api-notes.md` | editing `src/providers/anthropic.ts`, prompts, or changing the default Anthropic model |
| `gemini-api-notes.md` | editing `src/providers/gemini.ts` or choosing the Gemini model; what the live API returned, and the free-tier privacy terms |
| `dev-gotchas.md` | setting up the project, running tests, packaging, or fighting tooling |

## Glossary

| Term | Meaning here |
| --- | --- |
| **Staged diff** | `git diff --cached`: what the next commit would contain. Input of Generate Commit Message. |
| **Branch diff** | Changes between the merge base of `HEAD` and the base branch, and `HEAD`. Input of Generate PR Description. |
| **Merge base** | The latest commit both branches share; what a PR diff is measured from. |
| **Redaction / masking** | Replacing a secret value with `[REDACTED]` while keeping the line and its diff prefix. |
| **Sensitive path** | A file whose content is never sent, even redacted (`.env`, `*.pem`, `id_rsa`, ...). Only its name is mentioned. |
| **Skipped file** | A binary, lock or sensitive file: listed by name, content not sent. |
| **Omitted file** | A file left out entirely because the diff had too many files for the size budget. |
| **Truncation** | Shortening each file's diff fairly so the total fits the character budget. Always after redaction. |
| **Provider** | An implementation of `AiProvider` (`src/core/types.ts`). Today: Anthropic Claude and Google Gemini, chosen with `commitcraft.provider`. |
| **Pipeline** | `src/core/pipeline.ts`: the single flow both commands share. |
| **Conventional Commits** | `type(scope): description`, with type one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. |
| **SecretStorage** | VS Code's encrypted store backed by the OS keychain. The only place the API keys live (one per provider). |
| **Restricted Mode** | VS Code's mode for untrusted workspaces. CommitCraft is disabled there (the built-in Git extension is too). |
