# Changelog

All notable changes to CommitCraft are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-10-24

First release.

### Added
- **CommitCraft: Generate Commit Message**: drafts a commit message from the staged changes and
  writes it into the Source Control message box. Available from a button in the Source Control title
  bar and from the Command Palette.
- **CommitCraft: Generate PR Description**: compares the current branch with the base branch and
  opens a Markdown description with Summary, Changes, Testing and Risks sections in a new tab.
- **CommitCraft: Set API Key**: stores the API key for the selected AI service in VS Code SecretStorage (one key per service).
- **Two AI services**: Anthropic Claude (default) and Google Gemini, chosen with `commitcraft.provider`. Gemini works with a
  free Google AI Studio key. `commitcraft.model` is empty by default, meaning the default of the chosen service
  (`claude-opus-5-5` / `gemini-3.5-flash-lite`).
- Settings: `commitcraft.provider`, `commitcraft.style` (`conventional` or `plain`), `commitcraft.maxSubjectLength`,
  `commitcraft.baseBranch`, `commitcraft.model`.
- Secret redaction before anything leaves the machine: provider tokens (including Slack and Discord webhooks,
  Hugging Face, PyPI, SendGrid and more), JWTs, private keys (also key bodies whose `BEGIN` line is not in the diff),
  URL credentials, `Authorization` headers and assignments in code, JSON, YAML, env files, XML, SQL and command
  lines. `.env` files and their backups, key and certificate files, `secrets.json`, `credentials.json`,
  `service-account.json`, `kubeconfig` and similar are never sent.
- Binary files and lock files are listed by name only. Large diffs are truncated fairly per file, and
  the user is told. The file listings are capped so a diff touching thousands of files still gives a bounded request.
- If you type in the commit box while the draft is being generated, CommitCraft asks before replacing your text.
- Cancellable progress notification, and a clear message with a next step for every failure case.

### Security
- No telemetry. Nothing is stored except the API keys.
- **Gemini free tier:** Google may use prompts to improve its products and human reviewers may read them. The setting
  description, the key prompt and the README say so; use it for demos and non-confidential code. The confirmation after
  each run names the service that received the diff.
- Each service's endpoint is a constant, not a setting. Gemini requests refuse redirects so the key is never forwarded to
  another host.
- The API endpoint is pinned to `https://api.anthropic.com` and SDK logging is off, so environment
  variables such as `ANTHROPIC_BASE_URL` or `ANTHROPIC_LOG` cannot redirect or log requests.
- The extension is disabled in Restricted Mode (untrusted workspaces), as the Git extension it depends on is, and
  the base branch name is validated before it is passed to git.
- The staged and branch diffs are read with the Git extension's git binary and fixed options (no external diff
  tool, colour or textconv), without a shell, so a user's git configuration cannot change what is parsed.
- SDK OpenTelemetry (tracing and context propagation) is switched off, so no other extension's tracer can read the
  prompt. The SDK still adds its standard client headers (library version, OS, architecture, runtime).
- Redaction runs in linear time on hostile input (verified with 1 MB adversarial files), and PR descriptions have
  markdown and HTML images neutralised.
