# Working with the built-in Git extension

CommitCraft depends on `vscode.git` (`extensionDependencies` in `package.json`). Code: `src/vscode/git.ts`,
`src/vscode/gitChanges.ts`, `src/vscode/gitTypes.ts`.

**Status legend.** *Verified* = exercised against a real VS Code 1.143.1 and a real `git` by
`npm run test:integration`. *Typings* = taken from the extension's published API, not exercised by our tests.
*Manual* = covered by `docs/manual-test-checklist.md`.

## Getting the API

```ts
const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
const exports = ext.isActive ? ext.exports : await ext.activate();
if (!exports.enabled) { /* git.enabled is false */ }
const api = exports.getAPI(1);
```

- `api.repositories` is filled asynchronously after startup. `api.state` is `'uninitialized'` until discovery
  finishes, and `api.onDidChangeState` fires when it becomes `'initialized'`. `selectRepository` waits up to
  5 seconds for it before reporting "no repository". *Typings.*
- `api.git.path` is the path of the git binary the extension uses. *Verified.*

## What we use

| API | Used for | Status |
| --- | --- | --- |
| `repo.diff(true)` | Not used any more: it is a plain `git diff --cached`, which user config can make unreadable (see below) | Verified in the bundled extension's source by the review |
| `repo.rootUri.fsPath` | Matching the repo to the SCM button / the active file; `cwd` for git | Verified |
| `repo.state.HEAD.name` | Current branch; `undefined` when HEAD is detached | Verified |
| `repo.state.HEAD.commit` | `undefined` on a repository with no commits yet | Typings |
| `repo.inputBox.value` | Read (is there text to protect?) and write (the generated message) | Verified |
| `api.git.path` + `execFile` | Staged diff, branch diff, commit subjects, merge base (see below) | Verified |
| `scm/title` command argument | A `SourceControl` with `rootUri`, to pick the right repo in multi-repo windows | Manual (checklist item) |

## Why the diffs do not use the API

In the extension's typings, `diffBetween(ref1, ref2)` returns a list of changed files, and only
`diffBetween(ref1, ref2, path)` returns text for one file. Reading a whole branch would take one process per
file and lose rename detection. And `repo.diff(true)` (the staged diff) is a plain `git diff --cached` with no
protection from the user's config. So both flows run the extension's own git binary:

```
git rev-parse --verify --quiet <base>^{commit}      # does the base exist? tries <base>, then origin/<base>
git merge-base <commit> HEAD
git log --format=%s --max-count=100 <mergeBase>..HEAD       # newest first; reversed in code
git rev-list --count <mergeBase>..HEAD
git -c core.quotepath=true diff --no-color --no-ext-diff --no-textconv --submodule=short -M \
    --src-prefix=a/ --dst-prefix=b/ <mergeBase> HEAD --            # branch diff
git -c core.quotepath=true diff <same flags> --cached --          # staged diff
```

- Arguments are an **array** passed to `execFile`: no shell, nothing to escape. The base branch name is
  validated first (no leading `-`, restricted characters) because it can come from workspace settings.
- The fixed flags make the output independent of the user's config. The integration suite sets
  `diff.external`, `diff.noprefix`, `diff.mnemonicPrefix`, `diff.submodule=log` and `color.ui=always` and checks the
  output is unchanged, for both flows. *Verified.*
- `git log --reverse --max-count=N` returns the oldest commits of the NEWEST N, in the wrong window, so the log is
  read newest first and reversed in code; the true total comes from `rev-list --count`.
- `rev-parse --verify --quiet` and `merge-base` exit 1 for "no such ref / no common ancestor". Only exit status 1 is
  treated as "not found"; git missing (`ENOENT`), a timeout or a fatal error is a `GIT_ERROR`.
- Errors from the runner carry `exitCode` and a one-line `stderrSummary` for the log.
- Limits: 30 s timeout, 64 MB output (exceeding it becomes a `GIT_ERROR` with advice), `GIT_TERMINAL_PROMPT=0`.
- Uncommitted work is not part of a PR, so it is not read.

## Choosing a repository

Order: a single repository; the one the command was invoked for (the SCM title button passes its
`SourceControl`, whose `rootUri` we match); the repository containing the active file (longest root wins, so
submodules beat parents); otherwise a Quick Pick. Pure logic: `core/repository.ts: pickRepositoryRoot`.

## Gotchas

- After changing a repo from outside VS Code (tests, scripts), call `await repo.status()` before reading
  `repo.state`, or it can be stale. (Used only in the integration suite.)
- `workbench.view.scm` is executed after writing the message so the user sees the box.
- A `Uri` has no meaning without a scheme: only `file:` editors are used for repo selection.
- Virtual workspaces are unsupported (`capabilities.virtualWorkspaces`): there is no repository on disk.
