# Secret patterns: what CommitCraft masks, and what it does not

Implementation: `src/core/redact.ts` (token formats and the public API), `src/core/redact-keys.ts` (private keys),
`src/core/redact-assignments.ts` (`name = value` forms), `src/core/sensitive-paths.ts` (files never sent).
Tests: `test/core/redact.test.ts` and `test/core/redact-review.test.ts`. Masked values become `[REDACTED]`.
This is **best effort, not a guarantee**.

## Principles

1. **Replace values, never lines.** Line count and each line's diff prefix survive, so hunk headers still match;
   a hunk header inside a key block is left untouched.
2. **Prefer a false positive to a leak**, but exempt obvious non-secrets so messages do not degrade.
3. **Idempotent.** Redacting already redacted text changes nothing and counts nothing.
4. **Linear time, always.** Redaction runs synchronously in the shared extension host, so a hostile file must not be
   able to freeze it. Every regex starts at a literal or a bounded prefix, and every quantifier that can fail
   after a long scan is bounded (JWT segments, key types, tag and flag names). Tests feed 1 MB of adversarial text.
   (An earlier version had two quadratic patterns: 41 seconds for 400 KB of `eyJ-eyJ-...`.)
5. **Redact before truncate.** See `security-model.md`, threat 3.
6. **Boundaries are "not preceded by a letter or digit", not `\b`.** `\b` treats `_` as a word character, so
   `key_AKIA...` and `deploy_ghp_....txt` slipped through.

## What is masked

### Provider tokens (`TOKEN_RULES`)

| Rule name (in `kinds`) | Matches |
| --- | --- |
| `anthropic-api-key` | `sk-ant-...` |
| `openai-api-key` | `sk-proj-` / `sk-svcacct-` / `sk-admin-`, and legacy `sk-` + 32 or more alphanumerics containing a digit and a letter |
| `github-token` | `ghp_` `gho_` `ghu_` `ghs_` `ghr_`, `github_pat_...` |
| `gitlab-token` | `glpat-...` |
| `aws-access-key-id` | `AKIA` `ASIA` `AGPA` `AIDA` `AROA` `ANPA` `ANVA` `AIPA` + 16 characters |
| `slack-token`, `slack-webhook` | `xoxa-` `xoxb-` `xoxp-` `xoxr-` `xoxs-`; `https://hooks.slack.com/services/...` (also workflows, triggers) |
| `discord-webhook` | `https://discord.com/api/webhooks/<id>/<token>` (also discordapp.com, ptb, canary) |
| `stripe-key` | `sk_live_` `sk_test_` `rk_live_` `rk_test_` |
| `google-api-key`, `google-oauth-token` | `AIza` + 35 characters; `ya29.` access tokens |
| `npm-token`, `pypi-token`, `dockerhub-token` | `npm_` + 36; `pypi-AgE...`; `dckr_pat_...` |
| `huggingface-token`, `sendgrid-key`, `vault-token` | `hf_...`; `SG.x.y`; `hvs....` |
| `digitalocean-token`, `shopify-token` | `dop_v1_` / `doo_v1_` / `dor_v1_` + 64 hex; `shpat_` / `shpca_` / `shppa_` / `shpss_` + 32 hex |
| `jwt` | `eyJ....eyJ....signature` (signature may be empty), with bounded segment lengths |
| `bearer-token` | `Authorization: Bearer / Basic / Token <value>` and any `Bearer <20+ chars>` |
| `url-password` | the password in `scheme://user:password@host` |

### Private keys (`redact-keys.ts`, kind `private-key`)

- `-----BEGIN ... PRIVATE KEY-----` blocks (RSA, EC, OpenSSH, encrypted, PGP block, plain): multi-line (body lines
  masked, markers and diff prefixes kept), mid-line (a key inside a template string), and one line with escaped
  `\n` (JSON service accounts).
- An unterminated `BEGIN` masks the rest of that file section (it ends at the next `diff --git`).
- **Key material without its `BEGIN` marker** (a hunk that starts inside a key): body lines directly above an
  `END` marker are masked, and any stray full-width PEM body line (60 to 80 base64 characters with mixed case and a
  digit, `+` or `/`) is masked.
- `PUBLIC KEY` and `CERTIFICATE` blocks are left readable (same shape, not secret).

### Assignments (`redact-assignments.ts`, kind `secret-assignment`)

Keywords: `password`, `passwd`, `passphrase`, `pwd`, `pass`, `secret`, `token`, `api_key`, `access_key`,
`private_key`, `secret_key`, `credential`, `_auth` (case-insensitive; the keyword must END the key name:
`passwordLabel`, `max_tokens` and `bypass` do not match).

| Form | Example |
| --- | --- |
| `key = value`, `key: value`, `key := value`, quoted or not | `password = "..."`, `client_secret: ...`, `token := "..."` |
| JSON / hash rocket | `"api_key": "..."`, `'DB_PASSWORD' => '...'` |
| Env file, value runs to whitespace | `DB_PASS=...`, `export API_TOKEN=...` |
| Value wrapped onto the next line (quoted values only) | `const dbPassword =` + newline + `'...'` |
| Non-breaking and other Unicode spaces | `password: ...` |
| XML element and .NET attribute pair | `<password>...</password>`, `<add key="ApiKey" value="..."/>` |
| SQL | `... WITH PASSWORD '...'`, `IDENTIFIED BY '...'` |
| Command-line flag | `--password value`, `--token value` (not `--token-file`, `--password-stdin`) |
| Query string and header | `?api_key=...`, `X-Api-Key: ...` |

Decisions: a **quoted** value is masked if it has at least 4 characters, no whitespace, and is not a non-secret;
an **unquoted** value is masked if it has 6 or more characters with a digit or symbol (so `password: string` in a
type annotation is left alone), except in env-file form where any value is masked. `pass` is a common word, so it
additionally needs a credential-looking value (`pass: "passed"` stays).

Non-secrets (never masked, and these exemptions apply to the **whole** value only):
placeholders (`your-api-key-here`, `xxxxxxxx`, `changeme`, `<...>`, `{{...}}`, `true`, `null`), real variable
references (`${VAR}`, `$(cmd)`, `$UPPER_CASE`, `%VAR%`), code that fetches a value (`process.env.X`, `getPassword(`,
`this.token`), paths to key files (`/etc/ssl/private/server.key`, `~/.ssh/id`, as long as they do not look like a
high-entropy base64 string, since a real secret can start with `/`), and lowercase snake_case labels
(`refresh_token`, `ghp_exampletoken`; a hyphenated value is NOT a label, it could be a passphrase).
`=>` followed by an unquoted value is an arrow function, not an assignment.

### Sensitive files, never sent (`isSensitivePath`)

Only their names are mentioned. Checked on the lower-cased base name (Windows separators normalised), also after
removing a backup suffix (`.bak`, `.old`, `.orig`, `.backup`, `.save`, `.tmp`, `.swp`, `.copy`, `~`):

- Env files: `.env` and `.env` followed by `.`, `_`, `-` or `~` (so `.env.local`, `.env_backup`, `.env-prod`,
  `.env~`), `*.env`, `.envrc`, `env.production` and similar (`env.local`, `env.staging`, ...). Not `.environment.ts`,
  `.envoy.yaml`, `src/env.ts`.
- Keys and certificates: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`, `*.p8`, `*.kdbx`,
  `*.kdb`, `*.pkcs12`; any name containing `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` (not `.pub`).
- Infrastructure state: `*.tfstate`, `*.tfstate.backup`, `*.tfvars`, `*.tfvars.json`, `kubeconfig`,
  `.kube/config`, `.docker/config.json`, `.dockercfg`.
- Tool credentials: `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.htpasswd`, `.git-credentials`, `.yarnrc`,
  `.yarnrc.yml`, `.s3cfg`, `.boto`, `.my.cnf`, `.vault-token`, `credentials` (for example `.aws/credentials`).
- Data files whose name contains `secret` or `credential` (`secrets.json`, `client_secret_123.json`,
  `credentials.yml`, `my-secrets.toml`) and `service-account*.json`. Source files with the same words in their name
  (`secrets.ts`, `credentials.ts`, `service-account.ts`) are NOT flagged.
- Framework secrets: `wp-config.php`, `local.settings.json`.

## Measured false positives

`npm run scan:fp` runs `redact()` over real third-party code. On 2,031 files (482,291 lines: the Anthropic SDK,
Vitest, vsce, ESLint, `@types`) it changes **18 lines**: 9 are doc examples that really are credentials in URLs
(`https://abc:xyz@example.com`, correct to mask) and 9 are one parser's `lastSignificantToken = "?JSX"` style
constants (a known false positive). History: 31 lines before the first round of exemptions, 18 after, and still 18
after the review fixes widened detection considerably (a new `pass: "passed"` false positive was caught by this
scan and fixed with the credential-looking-value rule).

## Known gaps: NOT detected

Please read this before trusting redaction with anything you cannot share.

**Provider formats with no dedicated rule** (caught only when they sit next to a keyword such as `api_key=`):
Twilio (`SK...`, `AC...`), Mailgun (`key-`), Azure storage keys, connection strings and SAS signatures
(`AccountKey=`, `sig=`), Heroku keys (bare UUIDs), Telegram and Discord bot tokens, Terraform Cloud, Cloudflare,
Datadog, Sentry DSNs, Firebase service files other than their private key, and many others.

**Structural gaps:**
- High-entropy strings with no keyword and no known prefix (a random 40-character base64 string).
- Secrets written in prose or comments ("the password is hunter2").
- Secrets passed positionally (`login("user", "hunter2")`, `setPassword('abc')`).
- Plain-word unquoted passwords with spaces around `=` (`password = letmein`; env-file style `PASSWORD=letmein` IS
  masked), and quoted passphrases that contain spaces (the prose guard skips them).
- Secrets split by string concatenation (`"sk-" + "ant-..."`) or built at run time.
- Encoded secrets (hex, base64 of a secret) and secrets inside binary or base64 blobs shorter or longer than a PEM
  line.
- The last body line of a key when the hunk has no `BEGIN`, is shorter than 40 characters and has no `=` padding.
- A secret on the line after its key for YAML multi-line scalars (`password: |`); only quoted wrapped values are
  followed onto the next line.
- A password containing an unescaped `@` or `/` inside a URL.
- Unicode look-alike characters or zero-width characters inside a token.
- Short Bearer tokens (under 8 characters after `Authorization: Bearer`; under 20 elsewhere).
- Keys named `auth`, `sig` or `credentials` (too many harmless uses: `credentials: 'include'`).
- Secret files with names that do not match the patterns above (`database.yml`, `appsettings.json`,
  `config/secrets` without an extension, a key file named `deploy`).
- Secrets in file **names** that are not token-shaped.

**Adding a rule:** add the format to `TOKEN_RULES` (anchor with `START` and a literal prefix, bound every
quantifier), add a FAKE secret built from fragments in `test/helpers/fakeSecrets.ts` (never a secret-shaped literal
in the repo), add it to the provider `it.each` in `redact-review.test.ts`, add a look-alike that must NOT be masked,
and re-run `npm run scan:fp` to check the false-positive count did not rise.
