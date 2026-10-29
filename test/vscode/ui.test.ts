import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitCraftError, type CommitCraftErrorCode } from '../../src/core/errors';
import { presentError, runWithProgress } from '../../src/vscode/ui';
import { FAKE } from '../helpers/fakeSecrets';
import { channel, commands, mockState, progressReports, resetVscodeMock, window } from '../mocks/vscode';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), show: vi.fn(), dispose: vi.fn() };

function ctx(overrides: { retry?: () => Promise<void> } = {}) {
  return { logger, setApiKey: vi.fn().mockResolvedValue(undefined), ...overrides };
}

beforeEach(() => {
  resetVscodeMock();
  for (const fn of [logger.info, logger.warn, logger.error, logger.show]) {
    fn.mockReset();
  }
});

describe('presentError: severity', () => {
  it.each<CommitCraftErrorCode>(['NO_STAGED_CHANGES', 'NO_BRANCH_CHANGES', 'ON_BASE_BRANCH', 'DETACHED_HEAD', 'NO_REPOSITORY', 'NO_WORKSPACE'])(
    'shows %s as a warning (nothing is wrong, there is just nothing to do)',
    async (code) => {
      await presentError(new CommitCraftError(code, 'Nothing to do.'), ctx());
      expect(window.showWarningMessage).toHaveBeenCalledWith('CommitCraft: Nothing to do.');
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    },
  );

  it.each<CommitCraftErrorCode>(['RATE_LIMITED', 'NETWORK', 'INVALID_API_KEY', 'GIT_ERROR', 'MALFORMED_RESPONSE', 'PROVIDER_REFUSED'])(
    'shows %s as an error',
    async (code) => {
      await presentError(new CommitCraftError(code, 'Something failed.'), ctx({ retry: vi.fn() }));
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(window.showWarningMessage).not.toHaveBeenCalled();
    },
  );

  it('says what happened: the message is the error message, prefixed with the product name', async () => {
    await presentError(new CommitCraftError('NETWORK', 'Could not reach the AI provider. Check your connection.'), ctx());
    expect(String(window.showErrorMessage.mock.calls[0]?.[0])).toBe('CommitCraft: Could not reach the AI provider. Check your connection.');
  });
});

describe('presentError: buttons give the obvious next step', () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  const labelsFor = async (code: CommitCraftErrorCode, withRetry = true): Promise<string[]> => {
    resetVscodeMock();
    await presentError(new CommitCraftError(code, 'm'), ctx(withRetry ? { retry } : {}));
    const call = (window.showErrorMessage.mock.calls[0] ?? window.showWarningMessage.mock.calls[0]) ?? [];
    return call.slice(1) as string[];
  };

  it.each<[CommitCraftErrorCode, string[]]>([
    ['INVALID_API_KEY', ['Set API Key']],
    ['INVALID_SETTING', ['Open Settings']],
    ['BASE_BRANCH_NOT_FOUND', ['Open Settings']],
    ['MODEL_NOT_FOUND', ['Open Settings']],
    ['GIT_ERROR', ['Show Log']],
    ['PROVIDER_ERROR', ['Try Again', 'Show Log']],
    ['SECRET_STORAGE_ERROR', []],
    ['RATE_LIMITED', ['Try Again']],
    ['NETWORK', ['Try Again']],
    ['TIMEOUT', ['Try Again']],
    ['EMPTY_RESPONSE', ['Try Again']],
    ['MALFORMED_RESPONSE', ['Try Again']],
    ['PROVIDER_REFUSED', []],
    ['GIT_EXTENSION_UNAVAILABLE', []],
    ['NO_STAGED_CHANGES', []],
  ])('%s offers %j', async (code, expected) => {
    expect(await labelsFor(code)).toEqual(expected);
  });

  it('does not offer Try Again when there is nothing to retry', async () => {
    expect(await labelsFor('NETWORK', false)).toEqual([]);
    expect(await labelsFor('PROVIDER_ERROR', false)).toEqual(['Show Log']);
  });

  it('Set API Key runs the key prompt', async () => {
    const c = ctx();
    window.showErrorMessage.mockResolvedValueOnce('Set API Key');
    await presentError(new CommitCraftError('INVALID_API_KEY', 'm'), c);
    expect(c.setApiKey).toHaveBeenCalledTimes(1);
  });

  it('Try Again runs the retry callback', async () => {
    const again = vi.fn().mockResolvedValue(undefined);
    window.showErrorMessage.mockResolvedValueOnce('Try Again');
    await presentError(new CommitCraftError('NETWORK', 'm'), ctx({ retry: again }));
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('Open Settings opens the setting that matches the error', async () => {
    window.showErrorMessage.mockResolvedValueOnce('Open Settings');
    await presentError(new CommitCraftError('MODEL_NOT_FOUND', 'm'), ctx());
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'commitcraft.model');

    window.showErrorMessage.mockResolvedValueOnce('Open Settings');
    await presentError(new CommitCraftError('BASE_BRANCH_NOT_FOUND', 'm'), ctx());
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'commitcraft.baseBranch');
  });

  it('Show Log reveals the output channel', async () => {
    window.showErrorMessage.mockResolvedValueOnce('Show Log');
    await presentError(new CommitCraftError('GIT_ERROR', 'm'), ctx());
    expect(logger.show).toHaveBeenCalledTimes(1);
  });

  it('does nothing further when the message is dismissed', async () => {
    const c = ctx({ retry: vi.fn() });
    await presentError(new CommitCraftError('NETWORK', 'm'), c);
    expect(c.retry).not.toHaveBeenCalled();
    expect(c.setApiKey).not.toHaveBeenCalled();
  });
});

describe('presentError: cancellation, logging', () => {
  it('shows only a brief status bar note for CANCELLED, and logs nothing', async () => {
    await presentError(new CommitCraftError('CANCELLED', 'cancelled'), ctx());
    expect(window.setStatusBarMessage).toHaveBeenCalledWith('CommitCraft: cancelled', 2000);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a code plus the cause class and HTTP status, never the cause message', async () => {
    const cause = Object.assign(new TypeError(`leaky ${FAKE.githubToken}`), { status: 429 });
    await presentError(new CommitCraftError('RATE_LIMITED', 'm', { cause }), ctx());
    expect(logger.error).toHaveBeenCalledWith('RATE_LIMITED (TypeError HTTP 429)');
  });

  it('logs a bare code when there is no cause', async () => {
    await presentError(new CommitCraftError('NO_STAGED_CHANGES', 'm'), ctx());
    expect(logger.error).toHaveBeenCalledWith('NO_STAGED_CHANGES');
  });

  it('for a non-CommitCraft error: generic message with Show Log, redacted truncated log line', async () => {
    window.showErrorMessage.mockResolvedValueOnce('Show Log');
    await presentError(new Error(`${FAKE.awsAccessKey} ${'x'.repeat(1000)}`), ctx());
    expect(String(window.showErrorMessage.mock.calls[0]?.[0])).toMatch(/Something unexpected went wrong/);
    const logged = String(logger.error.mock.calls[0]?.[0]);
    expect(logged).not.toContain(FAKE.awsAccessKey);
    expect(logged.length).toBeLessThanOrEqual(320);
    expect(logger.show).toHaveBeenCalledTimes(1);
  });

  it('handles a thrown string', async () => {
    await presentError('just a string', ctx());
    expect(String(logger.error.mock.calls[0]?.[0])).toBe('UNEXPECTED just a string');
  });
});

describe('runWithProgress', () => {
  it('shows a cancellable notification with the title and returns the result', async () => {
    const result = await runWithProgress('Working…', () => Promise.resolve(42));
    expect(result).toBe(42);
    expect(window.withProgress).toHaveBeenCalledWith({ location: 15, title: 'Working…', cancellable: true }, expect.any(Function));
  });

  it('forwards progress messages', async () => {
    await runWithProgress('t', (_signal, report) => {
      report('step one');
      report('step two');
      return Promise.resolve();
    });
    expect(progressReports).toEqual(['step one', 'step two']);
  });

  it('aborts the signal when the user cancels', async () => {
    mockState.onProgressStart = (token) => {
      setTimeout(() => token.cancel(), 0);
    };
    let aborted = false;
    await runWithProgress(
      't',
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
    );
    expect(aborted).toBe(true);
  });

  it('resolves undefined when the task fails with CANCELLED', async () => {
    expect(await runWithProgress('t', () => Promise.reject(new CommitCraftError('CANCELLED', 'c')))).toBeUndefined();
  });

  it('lets other errors propagate', async () => {
    const error = new CommitCraftError('NETWORK', 'down');
    await expect(runWithProgress('t', () => Promise.reject(error))).rejects.toBe(error);
    await expect(runWithProgress('t', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('stops listening for cancellation when finished', async () => {
    let disposed = false;
    window.withProgress.mockImplementationOnce(async (_options, task) =>
      task(
        { report: () => undefined },
        { onCancellationRequested: () => ({ dispose: () => { disposed = true; } }) } as never,
      ),
    );
    await runWithProgress('t', () => Promise.resolve());
    expect(disposed).toBe(true);
  });
});

describe('logger channel', () => {
  it('is only ever written through the injected logger (sanity check on the mock)', () => {
    expect(channel.info).not.toHaveBeenCalled();
  });
});
