# CommitCraft

Draft clear commit messages and pull request descriptions from your Git changes, using Claude or Gemini (you choose).
You review and edit the result. **Nothing is ever committed automatically.**

Vague commit messages ("fix", "wip", "changes") make history hard to read, slow down code review and
make changelogs painful. CommitCraft reads what you actually changed and writes the first draft for you.

## What it does

| Command | What happens |
| --- | --- |
| **CommitCraft: Generate Commit Message** | Reads your staged changes and fills the Source Control message box. Also available as a sparkle button in the Source Control title bar. |
| **CommitCraft: Generate PR Description** | Compares the current branch with the base branch (default `main`) and opens a Markdown description with **Summary, Changes, Testing and Risks** in a new tab. |
| **CommitCraft: Set API Key** | Stores the API key for the AI service you chose (Anthropic or Google Gemini) in VS Code's secure storage. |

> Screenshot placeholder: the sparkle button in the Source Control title bar and a generated commit message in the box.
>
> Screenshot placeholder: a generated PR description open in a Markdown tab.
>
> Screenshot placeholder: the progress notification with its Cancel button.

## Install

1. Get the `commitcraft-0.1.0.vsix` file.
2. In VS Code open the Extensions view, click the `...` menu and choose **Install from VSIX...**,
   or run `code --install-extension commitcraft-0.1.0.vsix`.
3. Reload the window if VS Code asks.

Requires VS Code 1.90 or newer and the built-in Git extension (enabled by default).

## Set up

Pick the AI service in Settings (`commitcraft.provider`) and get a key for it. Each service needs its own key.

| Service | Cost | Get a key | Setting |
| --- | --- | --- | --- |
| **Google Gemini** | Free tier available | [Google AI Studio](https://aistudio.google.com/apikey) | `commitcraft.provider` = `gemini` |
| **Anthropic Claude** (default) | Paid (a message costs about a cent) | [Anthropic Console](https://console.anthropic.com/) | `commitcraft.provider` = `anthropic` |

> **Free-tier privacy:** on Gemini's free tier, Google may use your prompts to improve its products and human reviewers
> may read them (see "Privacy and security"). Use it for demos, open-source and personal code, not confidential code.

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **CommitCraft: Set API Key**. It asks for the key of
   the service currently selected in `commitcraft.provider`.
2. Paste the key. It is stored in VS Code SecretStorage (your operating system's keychain), never in
   settings files, and is only ever sent to that service (`api.anthropic.com` or `generativelanguage.googleapis.com`).
3. If you switch `commitcraft.provider` later, run **Set API Key** again for the new service.

If you skip this step, CommitCraft asks for the key the first time you generate something.

## Use

### Commit message

1. Stage the changes you want to commit.
2. Click the sparkle button in the Source Control title bar, or run **CommitCraft: Generate Commit Message**.
3. Read the draft in the message box, edit it, then commit as usual. If you type in the box while CommitCraft is
   working, it asks before replacing your text (or can show the draft in a new tab instead).

With several repositories open, CommitCraft uses the one the button belongs to, otherwise the one that
contains the file you are editing, otherwise it asks you.

### PR description

1. Check out your feature branch and commit your work.
2. Run **CommitCraft: Generate PR Description**.
3. Copy the result from the new tab into your pull request.

The description covers the commits on your branch that are not on the base branch (the newest 100 are listed
if there are more). Uncommitted and unstaged changes are not included. If your base branch is not `main`, set `commitcraft.baseBranch`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `commitcraft.provider` | `anthropic` | Which AI service writes the messages: `anthropic` or `gemini`. Your diffs are sent to the one you choose. |
| `commitcraft.style` | `conventional` | `conventional` writes `type(scope): subject` (feat, fix, docs, ...). `plain` writes a short plain-English subject. |
| `commitcraft.maxSubjectLength` | `72` | Longest allowed first line (20 to 120). Longer subjects are shortened. |
| `commitcraft.baseBranch` | `main` | Branch that PR descriptions compare against. Falls back to `origin/<branch>` if there is no local branch. |
| `commitcraft.model` | empty | Model to use. **Empty means the default of the chosen service**: `claude-opus-5-5` for Anthropic (`claude-haiku-5-5` is fastest and cheapest, `claude-sonnet-5-5` a balance) and `gemini-3.5-flash-lite` for Gemini (`gemini-3.8-flash` is larger but was often busy when tested). |

CommitCraft does not run in Restricted Mode (untrusted workspaces), because the built-in Git extension it relies on
is not available there. Trust the workspace to use it.

## Privacy and security

**Your code diffs are sent to the AI service you choose.** When you run a command, CommitCraft sends the relevant diff
(after the safeguards below) to Anthropic (`https://api.anthropic.com`) or Google Gemini
(`https://generativelanguage.googleapis.com`), depending on `commitcraft.provider`, to generate the text. The
confirmation after each run names the service. Do not use CommitCraft on code you are not allowed to share with that
provider, and see its own privacy and data-retention terms.

**Gemini free tier:** Google's terms say that on the free (unpaid) tier it may use prompts and responses to improve its
products and that human reviewers may read, annotate and process them. On the paid tier it says it does not use them to
improve its products. Terms change, so check Google's current page. Use the free tier for demos, open-source and personal
code, not confidential or proprietary code.

Safeguards, applied before anything leaves your machine:

- **Secrets are masked.** API keys and tokens (Anthropic, OpenAI, GitHub, GitLab, AWS, Slack and Discord webhooks,
  Stripe, Google, npm, PyPI, Hugging Face, SendGrid and more), JWTs, private key blocks (including key bodies in
  a hunk that does not show the `BEGIN` line), passwords inside URLs, `Authorization` headers and
  `password=` / `token=` / `api_key=` style assignments in code, JSON, YAML, env files, XML, SQL and command lines
  are replaced with `[REDACTED]`. You are told when something was masked. Masking is best effort: always check what
  you commit.
- **Sensitive files are never sent**, even redacted: `.env` files and their backups, `*.pem`, `*.key`, `*.p12`,
  `*.pfx`, `*.jks`, `*.ppk`, `id_rsa` and friends, `.npmrc`, `.netrc`, Terraform state and variables,
  `secrets.json`, `credentials.json`, `service-account.json`, `kubeconfig` and similar. Only their names are mentioned.
- **Binary files and lock files** (`package-lock.json`, `yarn.lock`, ...) are listed by name only.
- **Large diffs** are shortened per file, and you are told. Even a diff that touches thousands of files produces a
  bounded request.
- **No telemetry.** CommitCraft collects and stores nothing except your API key, in SecretStorage. Anthropic's
  client library adds its standard request headers (library version, operating system, architecture and runtime
  version); its OpenTelemetry tracing is switched off.
- **The endpoint is fixed** for each service and cannot be changed by a setting. For Anthropic, environment variables such
  as `ANTHROPIC_BASE_URL` and `ANTHROPIC_LOG` are ignored; for Gemini, redirects are refused. So your key and diffs cannot be
  redirected or logged by accident.
- **Git is run safely.** The staged and branch diffs are read with the Git extension's own git binary, with fixed
  options so your git configuration (external diff tools, colours, prefixes) cannot change them, and without a shell.
- **Logs contain no code.** The CommitCraft output channel records error codes and counts only.

## Limitations

- Two AI services are supported (Anthropic Claude and Google Gemini). Adding another is one new file behind the
  provider interface.
- Needs an internet connection and an API key with available credit.
- The AI can be wrong or vague. Treat every draft as a draft.
- Very large diffs are truncated, so the message may not mention everything in them.
- Secret masking is pattern based. It cannot recognise every kind of secret (see the project docs for the known gaps).
- There is no command to delete the stored key. Remove it through your OS keychain, or overwrite it with **Set API Key**.
- Corporate proxies work only as far as VS Code's own proxy support does.
- The API key needs VS Code's secure storage (your operating system's keychain). On Linux and WSL that means a
  keyring such as gnome-keyring must be installed and unlocked.
- Git submodules, unusual `diff.*` configuration and very exotic file names are handled on a best-effort basis.

## Troubleshooting

| You see | What to do |
| --- | --- |
| "There are no staged changes" | Stage files with the **+** button in Source Control, then try again. |
| "The API key was rejected" | Run **CommitCraft: Set API Key** and paste a valid key for the service selected in `commitcraft.provider`. |
| "Gemini is rate limiting requests" or "busy" | The free tier has per-minute and per-day limits (the daily one resets at midnight Pacific time) and popular models can be overloaded. Wait, use **Try Again**, or set `commitcraft.model` to `gemini-3.5-flash-lite`. |
| "Your Anthropic account has no credit left" | Add credits under Plans & Billing at console.anthropic.com, or switch `commitcraft.provider` to `gemini`. |
| "The base branch ... does not exist here" | Set `commitcraft.baseBranch` to your base branch, or run `git fetch`. |
| "rate limiting requests (HTTP 429)" | Wait a minute, then use **Try Again**. |
| "could not access its secure storage" | Install and unlock a keyring (for example gnome-keyring on Linux), then try again. |
| "was not in Conventional Commit format" | Run the command again, or set `commitcraft.style` to `plain`. |
| Anything else | Open **View > Output**, choose **CommitCraft** in the drop-down, and check the error code. |

## Development

```bash
npm install
npm run build          # bundle to dist/extension.js
npm test               # unit tests (Vitest)
npm run lint
npm run package        # produces commitcraft-<version>.vsix
```

Press `F5` in VS Code to launch an Extension Development Host. `npm run test:integration` runs a few
smoke tests inside a real VS Code (it downloads VS Code the first time; on a headless Linux machine run
it under `xvfb-run`).

The project documentation is in the `docs/` folder of the source repository: `requirements.md`,
`architecture.md`, `qa.md` and a knowledge base. `CLAUDE.md` holds the standing instructions used
when building this project with Claude Code.

## License

MIT. See `LICENSE`.
