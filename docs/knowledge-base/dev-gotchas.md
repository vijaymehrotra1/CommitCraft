# Developer gotchas

Things that cost time while building CommitCraft. Add to this list when something bites you.

## Tooling versions

- **TypeScript is pinned to ~5.9.** `typescript-eslint` 8.x supports TypeScript below 6.1; `npm` offers
  TypeScript 7 as `latest`, which would break linting.
- **Vitest 3 and `@vscode/vsce` 3**, because Vitest 5 and vsce 5 require Node 22+, and the project targets Node
  20 (the extension host in VS Code 1.90 runs Node 20). CI tests both 20 and 22.
- **`@types/vscode` is pinned to exactly `1.90.0`**, the same as `engines.vscode`. `vsce package` refuses a
  types version newer than the minimum engine. A manifest test guards this.
- ESLint is 9 with a flat config (`eslint.config.mjs`) and type-aware rules, so every linted file must be in
  `tsconfig.json`'s `include` (that is why `scripts/**/*.ts` is listed).

## Running the integration tests

- `npm run test:integration` downloads VS Code (about 335 MB) into `.vscode-test/` the first time (gitignored).
- **`ELECTRON_RUN_AS_NODE=1` is inherited when you run it from a terminal inside VS Code**, which makes the
  downloaded VS Code behave like plain Node and fail with `Cannot find module '<workspace path>'`.
  `test/integration/runTest.ts` deletes the variable for the child. If you write another launcher, do the same.
- The suite uses a temporary user-data dir and extensions dir, so it never touches your VS Code profile. A
  VS Code window does open briefly. On a headless Linux box use `xvfb-run -a npm run test:integration`.
- Tests share one temporary repository and run in order (they check out branches), so do not reorder them.
- **The integration run must build `dist/extension.js` itself.** The extension under test loads the bundle named by
  `package.json` `main`, and `dist/` is gitignored. `test:integration` once bundled only the test files: it passed
  on a developer machine with a leftover (maybe stale) `dist/` and failed in CI on a fresh checkout with
  `Cannot find module '.../dist/extension.js'` (the two tests that activate the extension). The script now runs
  `node esbuild.mjs` first. To check, delete `dist/` and run it.

## Packaging

- `npm run package` = `vsce package --no-dependencies --allow-missing-repository`. `--no-dependencies` because
  everything is bundled; `--allow-missing-repository` until a real repository URL exists.
- **Do not use relative image links in `README.md`.** Without a repository URL vsce cannot rewrite them and
  packaging fails. The README uses text placeholders for screenshots; add absolute URLs when it is published.
- `publisher` in `package.json` is a placeholder (`vijay-mehrotra`). Change it before publishing.
- vsce prints an advisory that `dist/extension.js` is large (about 420 KB). It is the minified bundle including
  the SDK. Accepted.
- Check the file list vsce prints: it must contain only `package.json`, `README.md`, `CHANGELOG.md`,
  `LICENSE`, `media/icon.png` and `dist/extension.js` (a manifest test pins `.vscodeignore`).

## Secrets in the repo

- **Never commit a secret-shaped literal, even a fake one.** GitHub push protection and local scanners match
  on format. Fakes are assembled from fragments at run time (`test/helpers/fakeSecrets.ts`), and fixtures use
  `{{FAKE_...}}` placeholders. The submission checklist asks you to search the Git history for secrets: this
  is why that search should come back empty.
- Even the PEM header string trips tools such as `detect-private-key`; it is also built from fragments.

## Writing code against the SDK

- See `anthropic-api-notes.md` for the client hardening and the `Anthropic.RateLimitError` type-position quirk.
- `instanceof` narrowing of `Anthropic.APIError` gives `any` type arguments; annotate `status` explicitly.

## Writing tests

- A parameter with a default value is replaced when you pass `undefined` explicitly. A test helper
  `repoOn(name, commit = 'x')` could not build a repo "with no commit" until the default was removed.
- Test the ordering invariants with the **real** collaborators *and* a stub that cannot compensate. The
  real redactor masks an unterminated key to the end, so a pipeline-level test passed even with truncation
  and redaction swapped; only the `processDiff` test with a strict stub caught it (found by mutation).
- Regenerating fixtures: `scripts/make-fixtures.sh` (needs `git`, `python3`, `node`). Counts asserted in
  `diff.test.ts` come from the generated output, so a regeneration can legitimately change them.

## Regexes in code that processes untrusted text

- Any pattern with an unbounded quantifier that can FAIL after a long scan is quadratic on input like `eyJ-eyJ-...`
  or repeated `BEGIN` markers. The two hostile-input tests took six minutes of CPU before the fix. Bound
  quantifiers (`{8,300}`), anchor on a literal, never use a lazy `.*?` across a long line (scan with `indexOf`).
- Test with megabytes of adversarial input, and set a time budget in the test.
- `\b` treats `_` as a word character: use `(?<![A-Za-z0-9])` when an underscore or hyphen may touch a token.
- When loosening or widening a rule, re-run `npm run scan:fp`: it caught `pass: "passed"` the moment `pass` became a keyword.

## Tests that mislead

- The same default-parameter trap bit twice (`makeContext(key = API_KEY)` turned an explicit `undefined` back into a key).
  Give test factories no defaults for values a test needs to set to `undefined`.
- A `replace('A.', body)` helper that silently matches nothing makes tests pass or fail for the wrong reason. Assert
  that the substitution happened.
- A mock reset helper must clear the call history of EVERY mock a test asserts on, including ones that keep their
  implementation (`mockClear`).
- Piping a long command into `head` closes the pipe early and can kill the process with SIGPIPE (a test run looked like
  it exited 1; it had not).

## Misc

- Windows line endings: `.gitattributes` forces LF and marks fixtures `-text`.
- `execFile` is used with `windowsHide: true` so no console window flashes on Windows.
- `process.platform` decides case-insensitive path comparison (Windows and macOS) when matching repositories.
