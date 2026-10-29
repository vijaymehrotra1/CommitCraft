// Reads the changes CommitCraft describes. Imports no VS Code API, so it is unit tested with fakes.

import { CommitCraftError } from '../core/errors';
import { MAX_COMMIT_SUBJECTS } from '../core/prompt';
import { assertValidBranchName } from '../core/repository';
import type { GitCommandFailure, GitRepository, RunGit } from './gitTypes';

/**
 * Fixed flags so a user's git config (diff.external, diff.noprefix, diff.mnemonicPrefix, diff.submodule,
 * color.ui, textconv drivers) cannot change the text the parser sees.
 */
const DIFF_FLAGS = [
  '-c',
  'core.quotepath=true',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--submodule=short',
  '-M',
  '--src-prefix=a/',
  '--dst-prefix=b/',
] as const;

function gitFailed(what: string, cause: unknown): CommitCraftError {
  return new CommitCraftError(
    'GIT_ERROR',
    `Git could not ${what}. Check that git works in a terminal in this folder, then try again. See the CommitCraft output for details.`,
    { cause },
  );
}

/** Rethrows cancellation as is, wraps anything else as a GIT_ERROR. */
function asGitFailure(what: string, error: unknown): CommitCraftError {
  return error instanceof CommitCraftError ? error : gitFailed(what, error);
}

/**
 * The staged diff, read with the Git extension's own git binary and the same fixed flags as the branch
 * diff. (The extension API's `repo.diff(true)` is a plain `git diff --cached`, which an external diff tool
 * or `color.ui=always` in the user's config turns into text the parser cannot read.) May be empty.
 */
export async function getStagedDiff(runGit: RunGit): Promise<string> {
  try {
    return await runGit([...DIFF_FLAGS, '--cached', '--']);
  } catch (error) {
    throw asGitFailure('read the staged changes', error);
  }
}

export interface BranchChanges {
  branchName: string;
  /** The ref actually compared against, e.g. `main` or `origin/main`. */
  baseRef: string;
  rawDiff: string;
  /** The newest commits (at most MAX_COMMIT_SUBJECTS), oldest first. */
  commitSubjects: string[];
  /** All commits on the branch that are not on the base, which can exceed `commitSubjects.length`. */
  totalCommits: number;
}

/**
 * Stdout of a git command that may legitimately exit 1 (probing whether a ref exists: `rev-parse --verify
 * --quiet` and `merge-base` both exit 1 for "no such thing"). Any other failure, such as git missing, a
 * timeout or a fatal error, is a real problem and propagates.
 */
async function probeGit(runGit: RunGit, args: readonly string[]): Promise<string | undefined> {
  try {
    return (await runGit(args)).trim();
  } catch (error) {
    if ((error as GitCommandFailure).exitCode === 1) {
      return undefined;
    }
    throw error;
  }
}

/** Finds the first of `base` and `origin/base` that exists, and its merge base with HEAD. */
async function resolveBase(
  runGit: RunGit,
  baseBranch: string,
): Promise<{ baseRef: string; mergeBase: string } | 'no-ref' | 'no-common-history'> {
  let foundRef: string | undefined;
  for (const candidate of [baseBranch, `origin/${baseBranch}`]) {
    const commit = await probeGit(runGit, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (!commit) {
      continue;
    }
    foundRef = candidate;
    const mergeBase = await probeGit(runGit, ['merge-base', commit, 'HEAD']);
    if (mergeBase) {
      return { baseRef: candidate, mergeBase };
    }
  }
  return foundRef ? 'no-common-history' : 'no-ref';
}

/**
 * The commits on the current branch that are not on `baseBranch`, and their combined diff
 * (changes since the merge base, like a pull request shows). Uncommitted changes are not included.
 * @throws CommitCraftError DETACHED_HEAD, INVALID_SETTING, ON_BASE_BRANCH, BASE_BRANCH_NOT_FOUND, NO_BRANCH_CHANGES, GIT_ERROR
 */
export async function getBranchChanges(
  repo: Pick<GitRepository, 'state'>,
  baseBranch: string,
  runGit: RunGit,
): Promise<BranchChanges> {
  assertValidBranchName(baseBranch);

  const head = repo.state.HEAD;
  if (head && head.name === undefined) {
    throw new CommitCraftError(
      'DETACHED_HEAD',
      'HEAD is detached, so there is no current branch to describe. Check out a branch (git switch <branch>) and try again.',
    );
  }
  if (!head || head.commit === undefined) {
    throw new CommitCraftError(
      'NO_BRANCH_CHANGES',
      'This repository has no commits yet, so there is nothing to compare. Make a commit on a branch first.',
    );
  }
  const branchName = head.name as string;
  if (branchName === baseBranch) {
    throw new CommitCraftError(
      'ON_BASE_BRANCH',
      `You are on ${baseBranch}, the base branch, so there is nothing to compare. Switch to your feature branch, or change commitcraft.baseBranch in Settings.`,
    );
  }

  let base: Awaited<ReturnType<typeof resolveBase>>;
  try {
    base = await resolveBase(runGit, baseBranch);
  } catch (error) {
    throw asGitFailure('check the base branch', error);
  }
  if (base === 'no-ref') {
    throw new CommitCraftError(
      'BASE_BRANCH_NOT_FOUND',
      `The base branch "${baseBranch}" (or origin/${baseBranch}) does not exist here. Set commitcraft.baseBranch to your base branch, such as develop, or run git fetch if it only exists on the remote.`,
    );
  }
  if (base === 'no-common-history') {
    throw new CommitCraftError(
      'BASE_BRANCH_NOT_FOUND',
      `"${baseBranch}" and ${branchName} share no common history, so they cannot be compared. Check commitcraft.baseBranch in Settings.`,
    );
  }

  const range = `${base.mergeBase}..HEAD`;
  let subjects: string;
  let count: string;
  let rawDiff: string;
  try {
    // Newest first, then reversed here: `git log --reverse --max-count=N` would not return the newest N.
    subjects = await runGit(['log', '--format=%s', `--max-count=${MAX_COMMIT_SUBJECTS}`, range]);
    count = await runGit(['rev-list', '--count', range]);
    rawDiff = await runGit([...DIFF_FLAGS, base.mergeBase, 'HEAD', '--']);
  } catch (error) {
    throw asGitFailure('read the branch changes', error);
  }

  const commitSubjects = subjects
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .reverse();
  const totalCommits = Math.max(Number.parseInt(count, 10) || 0, commitSubjects.length);

  if (commitSubjects.length === 0 && rawDiff.trim() === '') {
    throw new CommitCraftError(
      'NO_BRANCH_CHANGES',
      `${branchName} has no commits ahead of ${baseBranch}, so there is nothing to describe. Commit your work on this branch first.`,
    );
  }
  return { branchName, baseRef: base.baseRef, rawDiff, commitSubjects, totalCommits };
}
