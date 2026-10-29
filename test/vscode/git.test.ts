import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitCraftError } from '../../src/core/errors';
import { createRunGit, getGitApi, selectRepository } from '../../src/vscode/git';
import type { GitApi, GitCommandFailure, GitRepository } from '../../src/vscode/gitTypes';
import { Uri, extensions, mockState, resetVscodeMock, window } from '../mocks/vscode';

function repo(path: string): GitRepository {
  return { rootUri: { fsPath: path }, inputBox: { value: '' }, state: {} };
}

function api(repositories: GitRepository[], state: GitApi['state'] = 'initialized'): GitApi {
  return {
    state,
    repositories,
    git: { path: '/usr/bin/git' },
    onDidChangeState: () => ({ dispose: () => undefined }),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof CommitCraftError ? error.code : `unexpected: ${String(error)}`;
  }
  return 'no error';
}

beforeEach(() => {
  resetVscodeMock();
});

describe('getGitApi', () => {
  it('reports a missing Git extension with advice', async () => {
    mockState.extension = undefined;
    await expect(getGitApi()).rejects.toMatchObject({ code: 'GIT_EXTENSION_UNAVAILABLE', message: expect.stringMatching(/Enable "Git"/) as string });
  });

  it('reports Git being disabled in settings', async () => {
    mockState.extension = { isActive: true, exports: { enabled: false, getAPI: vi.fn() }, activate: vi.fn() };
    await expect(getGitApi()).rejects.toMatchObject({ code: 'GIT_EXTENSION_UNAVAILABLE', message: expect.stringMatching(/git\.enabled/) as string });
  });

  it('activates an inactive extension and returns API version 1', async () => {
    const fakeApi = api([]);
    const getAPI = vi.fn().mockReturnValue(fakeApi);
    const exports = { enabled: true, getAPI };
    const activate = vi.fn().mockResolvedValue(exports);
    mockState.extension = { isActive: false, exports: undefined, activate };
    expect(await getGitApi()).toBe(fakeApi);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(getAPI).toHaveBeenCalledWith(1);
    expect(extensions.getExtension).toHaveBeenCalledWith('vscode.git');
  });

  it('uses the exports of an already active extension without activating again', async () => {
    const fakeApi = api([]);
    const activate = vi.fn();
    mockState.extension = { isActive: true, exports: { enabled: true, getAPI: () => fakeApi }, activate };
    expect(await getGitApi()).toBe(fakeApi);
    expect(activate).not.toHaveBeenCalled();
  });
});

describe('selectRepository', () => {
  it('requires an open folder', async () => {
    mockState.workspaceFolders = undefined;
    expect(await codeOf(selectRepository(api([repo('/a')])))).toBe('NO_WORKSPACE');
    mockState.workspaceFolders = [];
    expect(await codeOf(selectRepository(api([repo('/a')])))).toBe('NO_WORKSPACE');
  });

  it('reports no repository, with advice', async () => {
    await expect(selectRepository(api([]))).rejects.toMatchObject({
      code: 'NO_REPOSITORY',
      message: expect.stringMatching(/Initialize Repository/) as string,
    });
  });

  it('returns the only repository without asking', async () => {
    const only = repo('/work/app');
    expect(await selectRepository(api([only]))).toBe(only);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  describe('with several repositories', () => {
    const a = repo('/work/a');
    const b = repo('/work/b');
    const nested = repo('/work/a/vendor/lib');
    const all = (): GitApi => api([a, b, nested]);

    it('uses the repository the command was invoked for (an SCM source control)', async () => {
      expect(await selectRepository(all(), { rootUri: Uri.file('/work/b') })).toBe(b);
      expect(window.showQuickPick).not.toHaveBeenCalled();
    });

    it('accepts a Uri argument and prefers the nested repository', async () => {
      expect(await selectRepository(all(), Uri.file('/work/a/vendor/lib/src/x.ts'))).toBe(nested);
    });

    it('falls back to the repository containing the active file', async () => {
      mockState.activeEditorUri = Uri.file('/work/b/src/main.ts');
      expect(await selectRepository(all())).toBe(b);
      expect(window.showQuickPick).not.toHaveBeenCalled();
    });

    it('ignores an active editor that is not a file (untitled, output channel)', async () => {
      mockState.activeEditorUri = new Uri('/work/b/src/main.ts', 'untitled');
      window.showQuickPick.mockResolvedValueOnce(undefined);
      await selectRepository(all());
      expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    });

    it('asks when it cannot tell, and returns the choice', async () => {
      window.showQuickPick.mockImplementationOnce((items: unknown) => Promise.resolve((items as Array<{ repository: GitRepository }>)[1]));
      expect(await selectRepository(all())).toBe(b);
      const items = window.showQuickPick.mock.calls[0]?.[0] as Array<{ label: string; description: string }>;
      expect(items.map((i) => i.label)).toEqual(['a', 'b', 'lib']);
      expect(items.map((i) => i.description)).toEqual(['/work/a', '/work/b', '/work/a/vendor/lib']);
    });

    it('returns undefined when the user dismisses the question', async () => {
      window.showQuickPick.mockResolvedValueOnce(undefined);
      expect(await selectRepository(all())).toBeUndefined();
    });

    it('an argument that matches no repository falls through to the active file', async () => {
      mockState.activeEditorUri = Uri.file('/work/a/x.ts');
      expect(await selectRepository(all(), { rootUri: Uri.file('/elsewhere') })).toBe(a);
    });

    it('ignores arguments that are not a Uri or a source control', async () => {
      mockState.activeEditorUri = Uri.file('/work/a/x.ts');
      for (const junk of [undefined, null, 'text', 42, {}, { rootUri: 'not a uri' }]) {
        expect(await selectRepository(all(), junk)).toBe(a);
      }
    });
  });

  describe('repository discovery', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits for the Git extension to finish initialising', async () => {
      const late = repo('/work/late');
      let notify: (state: 'uninitialized' | 'initialized') => unknown = () => undefined;
      const lazy: GitApi = {
        state: 'uninitialized',
        repositories: [],
        git: { path: 'git' },
        onDidChangeState: (listener) => {
          notify = listener;
          return { dispose: () => undefined };
        },
      };
      const pending = selectRepository(lazy);
      lazy.repositories.push(late);
      notify('initialized');
      expect(await pending).toBe(late);
    });

    it('gives up after a few seconds and reports no repository', async () => {
      vi.useFakeTimers();
      const never: GitApi = { state: 'uninitialized', repositories: [], git: { path: 'git' }, onDidChangeState: () => ({ dispose: () => undefined }) };
      const pending = codeOf(selectRepository(never));
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await pending).toBe('NO_REPOSITORY');
    });
  });
});

describe('createRunGit (runs a real child process; node stands in for git)', () => {
  const node = process.execPath;
  const run = (script: string, signal?: AbortSignal): Promise<string> => createRunGit(node, process.cwd(), signal)(['-e', script]);

  it('resolves with stdout', async () => {
    expect(await run('process.stdout.write("hello from git")')).toBe('hello from git');
  });

  it('passes arguments as an array, with no shell interpretation', async () => {
    const out = await createRunGit(node, process.cwd())(['-e', 'process.stdout.write(process.argv[1])', '$(echo pwned); `id` | & "quoted" *']);
    expect(out).toBe('$(echo pwned); `id` | & "quoted" *');
  });

  it('runs in the given working directory', async () => {
    const directory = realpathSync(tmpdir()); // real path: macOS temp dirs are symlinks
    const reported = await createRunGit(node, directory)(['-e', 'process.stdout.write(process.cwd())']);
    expect(realpathSync(reported)).toBe(directory);
  });

  it('rejects with an Error when the process exits non-zero', async () => {
    await expect(run('process.exit(3)')).rejects.toBeInstanceOf(Error);
    await expect(run('process.exit(3)')).rejects.not.toBeInstanceOf(CommitCraftError);
  });

  it('puts the exit code and the first line of stderr on the error, for the log and for probing', async () => {
    const failure = (await run('console.error("\\nfatal: bad thing happened\\nsecond line"); process.exit(3)').catch((e: unknown) => e)) as GitCommandFailure & Error;
    expect(failure.exitCode).toBe(3);
    expect(failure.stderrSummary).toBe('fatal: bad thing happened');
  });

  it('truncates a very long stderr line', async () => {
    const failure = (await run('console.error("x".repeat(5000)); process.exit(2)').catch((e: unknown) => e)) as GitCommandFailure & Error;
    expect((failure.stderrSummary ?? '').length).toBeLessThanOrEqual(200);
  });

  it('rejects when the binary does not exist, with exitCode ENOENT (not 1)', async () => {
    const failure = (await createRunGit('/definitely/not/git', process.cwd())(['status']).catch((e: unknown) => e)) as GitCommandFailure & Error;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.exitCode).toBe('ENOENT');
  });

  it('forces git messages into English so output can be recognised on any locale', async () => {
    expect(await run('process.stdout.write(process.env.LC_ALL ?? "")')).toBe('C');
  });

  it('reports CANCELLED for an already aborted signal, without starting a process', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await codeOf(run('process.stdout.write("never")', controller.signal))).toBe('CANCELLED');
  });

  it('reports CANCELLED and stops the process when aborted while running', async () => {
    const controller = new AbortController();
    const pending = codeOf(run('setTimeout(() => {}, 30000)', controller.signal));
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toBe('CANCELLED');
  });

  it('does not let GIT_TERMINAL_PROMPT stay enabled (never hang on a credential prompt)', async () => {
    expect(await run('process.stdout.write(process.env.GIT_TERMINAL_PROMPT ?? "")')).toBe('0');
  });
});
