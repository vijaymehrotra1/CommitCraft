import { describe, expect, it } from 'vitest';
import { CommitCraftError } from '../../src/core/errors';
import { getBranchChanges, getStagedDiff } from '../../src/vscode/gitChanges';
import type { RunGit } from '../../src/vscode/gitTypes';
import { loadFixture } from '../helpers/fixtures';

const MERGE_BASE = 'abc123def456';

/** What `createRunGit` rejects with when git exits non-zero. */
function gitExit(code: number | string, message = `git exited with ${String(code)}`): Error {
  return Object.assign(new Error(message), { exitCode: code });
}

interface FakeRepoOptions {
  /** Refs that exist, mapped to their commit. */
  refs?: Record<string, string>;
  /** Merge-base result per commit; missing means "no common history". */
  mergeBases?: Record<string, string>;
  /** Commit subjects, NEWEST first, as `git log` prints them. */
  log?: string[];
  /** Total commits ahead of the merge base (defaults to the length of `log`). */
  count?: number;
  diff?: string;
  staged?: string;
  failOn?: 'log' | 'diff' | 'count';
}

function fakeGit(options: FakeRepoOptions = {}): { run: RunGit; calls: string[][] } {
  const refs = options.refs ?? { main: 'c0ffee' };
  const mergeBases = options.mergeBases ?? { c0ffee: MERGE_BASE, deadbeef: MERGE_BASE };
  const log = options.log ?? ['fix: typo', 'feat: add login'];
  const calls: string[][] = [];
  const run: RunGit = (args) => {
    calls.push([...args]);
    const [command] = args;
    if (command === 'rev-parse') {
      const ref = (args[3] ?? '').replace(/\^\{commit\}$/, '');
      const commit = refs[ref];
      return commit ? Promise.resolve(`${commit}\n`) : Promise.reject(gitExit(1));
    }
    if (command === 'merge-base') {
      const base = mergeBases[args[1] ?? ''];
      return base ? Promise.resolve(`${base}\n`) : Promise.reject(gitExit(1));
    }
    if (command === 'rev-list') {
      return options.failOn === 'count' ? Promise.reject(gitExit(128)) : Promise.resolve(`${options.count ?? log.length}\n`);
    }
    if (command === 'log') {
      return options.failOn === 'log' ? Promise.reject(gitExit(128)) : Promise.resolve(`${log.join('\n')}\n`);
    }
    if (args.includes('diff')) {
      if (options.failOn === 'diff') {
        return Promise.reject(gitExit(128));
      }
      return Promise.resolve(args.includes('--cached') ? (options.staged ?? '') : (options.diff ?? loadFixture('normal-edit')));
    }
    return Promise.reject(new Error(`unexpected git call: ${args.join(' ')}`));
  };
  return { run, calls };
}

const repoOn = (name: string | undefined) => ({
  state: { HEAD: { name, commit: 'deadbeef' } },
});

async function failureOf(promise: Promise<unknown>): Promise<CommitCraftError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CommitCraftError);
    return error as CommitCraftError;
  }
  throw new Error('expected rejection');
}

describe('getStagedDiff', () => {
  it('reads the staged diff with the same fixed flags as the branch diff', async () => {
    const git = fakeGit({ staged: 'the diff' });
    expect(await getStagedDiff(git.run)).toBe('the diff');
    expect(git.calls).toEqual([
      [
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
        '--cached',
        '--',
      ],
    ]);
  });

  it('returns an empty string when nothing is staged', async () => {
    expect(await getStagedDiff(fakeGit({ staged: '' }).run)).toBe('');
  });

  it('wraps git failures in a GIT_ERROR with advice and without the raw message', async () => {
    const error = await failureOf(getStagedDiff(() => Promise.reject(gitExit(128, 'fatal: not a git repository'))));
    expect(error.code).toBe('GIT_ERROR');
    expect(error.message).toMatch(/works in a terminal/);
    expect(error.message).not.toContain('fatal');
  });

  it('lets a cancellation propagate unchanged', async () => {
    const cancelled = new CommitCraftError('CANCELLED', 'cancelled');
    expect(await failureOf(getStagedDiff(() => Promise.reject(cancelled)))).toBe(cancelled);
  });
});

describe('getBranchChanges', () => {
  it('returns the branch name, base ref, commit subjects (oldest first) and the diff', async () => {
    const git = fakeGit();
    const result = await getBranchChanges(repoOn('feature/login'), 'main', git.run);
    expect(result).toEqual({
      branchName: 'feature/login',
      baseRef: 'main',
      rawDiff: loadFixture('normal-edit'),
      commitSubjects: ['feat: add login', 'fix: typo'],
      totalCommits: 2,
    });
  });

  it('diffs from the merge base with fixed flags and no shell-sensitive input', async () => {
    const git = fakeGit();
    await getBranchChanges(repoOn('feature/login'), 'main', git.run);
    const diffCall = git.calls.find((c) => c.includes('diff')) as string[];
    expect(diffCall).toEqual([
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
      MERGE_BASE,
      'HEAD',
      '--',
    ]);
  });

  describe('commit subjects (the newest are kept, shown oldest first, and the real total is reported)', () => {
    it('asks git for the newest commits and reverses them itself', async () => {
      const git = fakeGit();
      await getBranchChanges(repoOn('feature'), 'main', git.run);
      const logCall = git.calls.find((c) => c[0] === 'log') as string[];
      expect(logCall).not.toContain('--reverse'); // with --max-count it would pick the OLDEST commits' window wrongly
      expect(logCall).toContain('--max-count=100');
      expect(logCall).toContain(`${MERGE_BASE}..HEAD`);
      const countCall = git.calls.find((c) => c[0] === 'rev-list') as string[];
      expect(countCall).toEqual(['rev-list', '--count', `${MERGE_BASE}..HEAD`]);
    });

    it('reports a total larger than the subjects returned when the branch has more than 100 commits', async () => {
      const newest = Array.from({ length: 100 }, (_, i) => `chore: commit ${129 - i}`); // git prints newest first
      const git = fakeGit({ log: newest, count: 130 });
      const result = await getBranchChanges(repoOn('feature'), 'main', git.run);
      expect(result.totalCommits).toBe(130);
      expect(result.commitSubjects).toHaveLength(100);
      expect(result.commitSubjects[0]).toBe('chore: commit 30'); // oldest of the newest 100
      expect(result.commitSubjects[99]).toBe('chore: commit 129'); // the newest, last
    });

    it('drops blank lines', async () => {
      const git = fakeGit({ log: ['fix: b', '', '  ', 'feat: a'] });
      expect((await getBranchChanges(repoOn('feature'), 'main', git.run)).commitSubjects).toEqual(['feat: a', 'fix: b']);
    });
  });

  it('falls back to origin/<base> when there is no local base branch', async () => {
    const git = fakeGit({ refs: { 'origin/main': 'c0ffee' } });
    expect((await getBranchChanges(repoOn('feature'), 'main', git.run)).baseRef).toBe('origin/main');
  });

  it('prefers the local base branch over origin', async () => {
    const git = fakeGit({ refs: { main: 'c0ffee', 'origin/main': 'c0ffee' } });
    expect((await getBranchChanges(repoOn('feature'), 'main', git.run)).baseRef).toBe('main');
  });

  it('works with a base branch name that contains a slash', async () => {
    const git = fakeGit({ refs: { 'release/1.2': 'c0ffee' } });
    expect((await getBranchChanges(repoOn('feature'), 'release/1.2', git.run)).baseRef).toBe('release/1.2');
  });

  describe('problems the user can fix', () => {
    it('reports a detached HEAD', async () => {
      const error = await failureOf(getBranchChanges(repoOn(undefined), 'main', fakeGit().run));
      expect(error.code).toBe('DETACHED_HEAD');
      expect(error.message).toMatch(/Check out a branch/);
    });

    it('reports a repository with no commits', async () => {
      const unborn = { state: { HEAD: { name: 'main' } } }; // a branch name but no commit yet
      expect((await failureOf(getBranchChanges(unborn, 'main', fakeGit().run))).code).toBe('NO_BRANCH_CHANGES');
      expect((await failureOf(getBranchChanges({ state: {} }, 'main', fakeGit().run))).code).toBe('NO_BRANCH_CHANGES');
    });

    it('reports being on the base branch itself', async () => {
      const error = await failureOf(getBranchChanges(repoOn('main'), 'main', fakeGit().run));
      expect(error.code).toBe('ON_BASE_BRANCH');
      expect(error.message).toMatch(/commitcraft\.baseBranch/);
    });

    it('reports a missing base branch and says how to fix it', async () => {
      const error = await failureOf(getBranchChanges(repoOn('feature'), 'develop', fakeGit().run));
      expect(error.code).toBe('BASE_BRANCH_NOT_FOUND');
      expect(error.message).toContain('"develop"');
      expect(error.message).toContain('origin/develop');
      expect(error.message).toMatch(/commitcraft\.baseBranch/);
      expect(error.message).toMatch(/git fetch/);
    });

    it('reports unrelated histories', async () => {
      const git = fakeGit({ mergeBases: {} });
      const error = await failureOf(getBranchChanges(repoOn('feature'), 'main', git.run));
      expect(error.code).toBe('BASE_BRANCH_NOT_FOUND');
      expect(error.message).toMatch(/no common history/);
    });

    it('reports a branch with no commits ahead of base', async () => {
      const git = fakeGit({ log: [], diff: '' });
      const error = await failureOf(getBranchChanges(repoOn('feature'), 'main', git.run));
      expect(error.code).toBe('NO_BRANCH_CHANGES');
      expect(error.message).toMatch(/no commits ahead of main/);
    });

    it('still returns when commits exist but cancel out to an empty diff (the pipeline then explains)', async () => {
      const git = fakeGit({ diff: '' });
      const result = await getBranchChanges(repoOn('feature'), 'main', git.run);
      expect(result.rawDiff).toBe('');
      expect(result.commitSubjects).toHaveLength(2);
    });
  });

  describe('unsafe base branch names (a workspace setting can come from an untrusted repo)', () => {
    it.each(['--output=/tmp/pwned', '-p', 'main; rm -rf ~', 'a b', '$(whoami)', 'main\n--exec=x'])(
      'rejects %j before running any git command',
      async (name) => {
        const git = fakeGit();
        const error = await failureOf(getBranchChanges(repoOn('feature'), name, git.run));
        expect(error.code).toBe('INVALID_SETTING');
        expect(git.calls).toEqual([]);
      },
    );
  });

  describe('git failures are not mistaken for a missing base branch (found by the review)', () => {
    it.each([
      ['git is not installed', Object.assign(new Error('spawn git ENOENT'), { exitCode: 'ENOENT' })],
      ['git was killed by the timeout', Object.assign(new Error('timed out'), { exitCode: null })],
      ['git exits with a fatal error', gitExit(128, 'fatal: not a git repository')],
      ['an error without any exit code', new Error('weird')],
    ])('%s while checking the base ref', async (_label, failure) => {
      const run: RunGit = () => Promise.reject(failure);
      const error = await failureOf(getBranchChanges(repoOn('feature'), 'main', run));
      expect(error.code).toBe('GIT_ERROR');
      expect(error.cause).toBe(failure);
    });

    it('treats only exit status 1 from rev-parse and merge-base as "not found"', async () => {
      const error = await failureOf(getBranchChanges(repoOn('feature'), 'nope', fakeGit().run));
      expect(error.code).toBe('BASE_BRANCH_NOT_FOUND');
    });

    it.each(['log', 'diff', 'count'] as const)('wraps a failing %s in GIT_ERROR', async (failOn) => {
      const error = await failureOf(getBranchChanges(repoOn('feature'), 'main', fakeGit({ failOn }).run));
      expect(error.code).toBe('GIT_ERROR');
      expect(error.message).not.toContain('128');
    });

    it('lets a cancellation raised by git propagate instead of reporting a missing branch', async () => {
      const cancelled = new CommitCraftError('CANCELLED', 'Generation was cancelled.');
      const run: RunGit = () => Promise.reject(cancelled);
      expect(await failureOf(getBranchChanges(repoOn('feature'), 'main', run))).toBe(cancelled);
    });

    it('lets a cancellation during log/diff propagate', async () => {
      const cancelled = new CommitCraftError('CANCELLED', 'Generation was cancelled.');
      const base = fakeGit();
      const run: RunGit = (args) => (args[0] === 'log' ? Promise.reject(cancelled) : base.run(args));
      expect(await failureOf(getBranchChanges(repoOn('feature'), 'main', run))).toBe(cancelled);
    });
  });
});
