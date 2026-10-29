import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitCraftError } from '../../src/core/errors';
import type { AiProvider, BuiltPrompt, GenerateOptions } from '../../src/core/types';
import { registerCommands } from '../../src/vscode/commands';
import type { RunGit } from '../../src/vscode/gitTypes';
import { FAKE } from '../helpers/fakeSecrets';
import { loadFixture } from '../helpers/fixtures';
import { channel, commands, mockState, progressReports, resetVscodeMock, window, workspace } from '../mocks/vscode';

const gitMock = vi.hoisted(() => ({
  getGitApi: vi.fn(),
  selectRepository: vi.fn(),
  createRunGit: vi.fn(),
}));
vi.mock('../../src/vscode/git', () => gitMock);

const GOOD_PR = '## Summary\nA.\n\n## Changes\n- b\n\n## Testing\n- c\n\n## Risks\nNone identified.';
const API_KEY = FAKE.anthropicKey;

interface FakeRepo {
  rootUri: { fsPath: string };
  inputBox: { value: string };
  state: { HEAD?: { name?: string; commit?: string } };
  /** What `git diff --cached` prints for this fake repository. */
  stagedDiff: string;
}

function makeRepo(overrides: { diff?: string; text?: string; head?: FakeRepo['state']['HEAD'] } = {}): FakeRepo {
  return {
    rootUri: { fsPath: '/work/app' },
    inputBox: { value: overrides.text ?? '' },
    state: { HEAD: overrides.head ?? { name: 'feature/x', commit: 'deadbeef' } },
    stagedDiff: overrides.diff ?? loadFixture('normal-edit'),
  };
}

// No default value on purpose: a default would replace an explicit `undefined` ("no key stored").
function makeContext(key: string | undefined): { secrets: { get: ReturnType<typeof vi.fn>; store: ReturnType<typeof vi.fn> } } {
  return { secrets: { get: vi.fn().mockResolvedValue(key), store: vi.fn().mockResolvedValue(undefined) } };
}

/** A context holding a different key per stored secret id, like the real SecretStorage. */
function makeKeyedContext(keys: Record<string, string>): { secrets: { get: ReturnType<typeof vi.fn>; store: ReturnType<typeof vi.fn> } } {
  return {
    secrets: {
      get: vi.fn((id: string) => Promise.resolve(keys[id])),
      store: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeProvider(reply: string | Error | ((prompt: BuiltPrompt, options: GenerateOptions) => Promise<string>)): {
  provider: AiProvider;
  generate: ReturnType<typeof vi.fn<(prompt: BuiltPrompt, options: GenerateOptions) => Promise<string>>>;
} {
  const generate = vi.fn<(prompt: BuiltPrompt, options: GenerateOptions) => Promise<string>>((prompt, options) =>
    typeof reply === 'function' ? reply(prompt, options) : reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
  );
  return { provider: { generate }, generate };
}

function stagedRunGit(repo: FakeRepo): { runGit: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  const runGit: RunGit = (args) => {
    calls.push([...args]);
    return args.includes('--cached') ? Promise.resolve(repo.stagedDiff) : Promise.reject(new Error(`unexpected git call: ${args.join(' ')}`));
  };
  return { runGit, calls };
}

function setup(
  options: {
    repo?: FakeRepo;
    key?: string | undefined;
    provider?: ReturnType<typeof makeProvider>;
    gemini?: ReturnType<typeof makeProvider>;
    context?: ReturnType<typeof makeContext>;
    runGit?: RunGit;
  } = {},
) {
  const repo = options.repo ?? makeRepo();
  const staged = stagedRunGit(repo);
  gitMock.createRunGit.mockReturnValue(options.runGit ?? staged.runGit);
  const context = options.context ?? makeContext('key' in options ? options.key : API_KEY);
  const providerSpy = options.provider ?? makeProvider('feat(auth): shorten session lifetime');
  const geminiSpy = options.gemini ?? makeProvider('feat(auth): shorten session lifetime (gemini)');
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), show: vi.fn(), dispose: vi.fn() };
  gitMock.getGitApi.mockResolvedValue({ git: { path: '/usr/bin/git' }, repositories: [repo] });
  gitMock.selectRepository.mockResolvedValue(repo);
  registerCommands({ context: context as never, logger, providers: { anthropic: providerSpy.provider, gemini: geminiSpy.provider } });
  const run = (id: string, arg?: unknown): Promise<unknown> => {
    const handler = mockState.commandHandlers.get(id);
    if (!handler) {
      throw new Error(`command ${id} not registered`);
    }
    return Promise.resolve(handler(arg));
  };
  return { repo, context, logger, gitCalls: staged.calls, ...providerSpy, geminiGenerate: geminiSpy.generate, run };
}

const COMMIT = 'commitcraft.generateCommitMessage';
const PR = 'commitcraft.generatePrDescription';
const SET_KEY = 'commitcraft.setApiKey';

beforeEach(() => {
  resetVscodeMock();
  gitMock.getGitApi.mockReset();
  gitMock.selectRepository.mockReset();
  gitMock.createRunGit.mockReset();
});

describe('registerCommands', () => {
  it('registers exactly the three commands and returns disposables for them', () => {
    const disposables = registerCommands({
      context: makeContext(API_KEY) as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), show: vi.fn(), dispose: vi.fn() },
      providers: { anthropic: makeProvider('x').provider, gemini: makeProvider('y').provider },
    });
    expect([...mockState.commandHandlers.keys()].sort()).toEqual([COMMIT, PR, SET_KEY].sort());
    expect(disposables).toHaveLength(3);
  });
});

describe('Generate Commit Message', () => {
  it('reads the staged diff, generates, writes the message box and shows the SCM view', async () => {
    const { repo, run, generate, gitCalls } = setup();
    await run(COMMIT);

    expect(gitMock.createRunGit).toHaveBeenCalledWith('/usr/bin/git', '/work/app');
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0]).toContain('--cached');
    expect(gitCalls[0]).toContain('--no-ext-diff');
    expect(generate).toHaveBeenCalledTimes(1);
    const [prompt, options] = generate.mock.calls[0] as [BuiltPrompt, GenerateOptions];
    expect(prompt.user).toContain('src/auth/session.ts');
    expect(options).toMatchObject({ apiKey: API_KEY, model: 'claude-opus-5-5' });
    expect(repo.inputBox.value).toBe('feat(auth): shorten session lifetime');
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.view.scm');
    expect(progressReports).toEqual(['Reading and checking your changes…', 'Asking Claude…']);
  });

  it('confirms briefly in the status bar when there is nothing to warn about', async () => {
    const { run } = setup();
    await run(COMMIT);
    expect(window.setStatusBarMessage).toHaveBeenCalledWith(expect.stringContaining('Commit message ready'), 4000);
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('tells the user what was masked or not sent', async () => {
    const { run } = setup({ repo: makeRepo({ diff: loadFixture('secrets') }) });
    await run(COMMIT);
    const message = String(window.showInformationMessage.mock.calls.at(-1)?.[0]);
    expect(message).toMatch(/possible secrets were masked/);
    expect(message).toMatch(/\.env: sensitive file/);
  });

  it('passes the settings from VS Code configuration to the pipeline', async () => {
    mockState.settings = { style: 'plain', maxSubjectLength: 40, model: 'claude-haiku-5-5' };
    const { repo, run, generate } = setup({ provider: makeProvider('Shorten session lifetime') });
    await run(COMMIT);
    expect((generate.mock.calls[0] as [BuiltPrompt, GenerateOptions])[1].model).toBe('claude-haiku-5-5');
    expect((generate.mock.calls[0] as [BuiltPrompt, GenerateOptions])[0].system).toContain('at most 40 characters');
    expect(repo.inputBox.value).toBe('Shorten session lifetime');
  });

  describe('nothing to do', () => {
    it('warns when nothing is staged, without showing progress or calling the AI', async () => {
      const { run, generate, repo } = setup({ repo: makeRepo({ diff: '' }) });
      await run(COMMIT);
      expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('no staged changes'));
      expect(window.withProgress).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(repo.inputBox.value).toBe('');
    });

    it('does nothing, silently, when the user dismisses the repository question', async () => {
      const { run, generate } = setup();
      gitMock.selectRepository.mockResolvedValue(undefined);
      await run(COMMIT);
      expect(generate).not.toHaveBeenCalled();
      expect(window.showErrorMessage).not.toHaveBeenCalled();
      expect(window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('shows an open-folder warning when there is no workspace', async () => {
      const { run } = setup();
      gitMock.selectRepository.mockRejectedValue(new CommitCraftError('NO_WORKSPACE', 'No folder is open. Open one.'));
      await run(COMMIT);
      expect(window.showWarningMessage).toHaveBeenCalledWith('CommitCraft: No folder is open. Open one.');
    });
  });

  describe('API key', () => {
    it('offers to set a missing key, saves it, and continues', async () => {
      const { run, generate, context } = setup({ key: undefined });
      window.showInformationMessage.mockResolvedValueOnce('Set API Key');
      window.showInputBox.mockResolvedValueOnce(`  ${API_KEY}  `);
      await run(COMMIT);
      expect(window.showInformationMessage.mock.calls[0]?.[0]).toMatch(/needs an Anthropic API key/);
      expect(context.secrets.store).toHaveBeenCalledWith('commitcraft.anthropicApiKey', API_KEY);
      expect(generate).toHaveBeenCalledTimes(1);
      expect((generate.mock.calls[0] as [BuiltPrompt, GenerateOptions])[1].apiKey).toBe(API_KEY);
    });

    it.each([
      ['dismisses the offer', undefined as string | undefined, undefined as string | undefined],
      ['cancels the key input', 'Set API Key', undefined],
    ])('stops quietly when the user %s', async (_label, offerAnswer, inputAnswer) => {
      const { run, generate, context } = setup({ key: undefined });
      window.showInformationMessage.mockResolvedValueOnce(offerAnswer);
      window.showInputBox.mockResolvedValueOnce(inputAnswer);
      await run(COMMIT);
      expect(generate).not.toHaveBeenCalled();
      expect(context.secrets.store).not.toHaveBeenCalled();
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('a rejected key shows an error with a Set API Key button that opens the key prompt', async () => {
      const { run } = setup({
        provider: makeProvider(new CommitCraftError('INVALID_API_KEY', 'The API key was rejected. Set one.')),
      });
      window.showErrorMessage.mockResolvedValueOnce('Set API Key');
      window.showInputBox.mockResolvedValueOnce(API_KEY);
      await run(COMMIT);
      expect(window.showErrorMessage).toHaveBeenCalledWith('CommitCraft: The API key was rejected. Set one.', 'Set API Key');
      expect(window.showInputBox).toHaveBeenCalledTimes(1);
    });
  });

  describe('protecting existing text', () => {
    it('asks before replacing and keeps the text when the user declines', async () => {
      const { repo, run, generate } = setup({ repo: makeRepo({ text: 'my draft' }) });
      window.showWarningMessage.mockResolvedValueOnce(undefined);
      await run(COMMIT);
      expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('already has text'), { modal: true }, 'Replace');
      expect(generate).not.toHaveBeenCalled();
      expect(repo.inputBox.value).toBe('my draft');
    });

    it('replaces the text when the user agrees', async () => {
      const { repo, run } = setup({ repo: makeRepo({ text: 'my draft' }) });
      window.showWarningMessage.mockResolvedValueOnce('Replace');
      await run(COMMIT);
      expect(repo.inputBox.value).toBe('feat(auth): shorten session lifetime');
    });

    it('does not ask when the box only holds whitespace', async () => {
      const { repo, run } = setup({ repo: makeRepo({ text: '  \n' }) });
      await run(COMMIT);
      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(repo.inputBox.value).toBe('feat(auth): shorten session lifetime');
    });
  });

  describe('failures', () => {
    it('shows the provider error with a Try Again button, and Try Again re-runs the command', async () => {
      let calls = 0;
      const { repo, run, generate } = setup({
        provider: makeProvider(() => {
          calls++;
          return calls === 1
            ? Promise.reject(new CommitCraftError('NETWORK', 'Could not reach the AI provider.'))
            : Promise.resolve('fix: handle retry');
        }),
      });
      window.showErrorMessage.mockResolvedValueOnce('Try Again');
      await run(COMMIT);
      expect(window.showErrorMessage).toHaveBeenCalledWith('CommitCraft: Could not reach the AI provider.', 'Try Again');
      expect(generate).toHaveBeenCalledTimes(2);
      expect(repo.inputBox.value).toBe('fix: handle retry');
    });

    it('offers Open Settings for a bad base branch and opens the right setting', async () => {
      mockState.settings = { baseBranch: '--output=/tmp/x' };
      const { run, generate } = setup();
      window.showErrorMessage.mockResolvedValueOnce('Open Settings');
      await run(PR);
      expect(String(window.showErrorMessage.mock.calls[0]?.[0])).toMatch(/not a usable branch name/);
      expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'commitcraft.baseBranch');
      expect(generate).not.toHaveBeenCalled();
    });

    it('a malformed answer leaves the message box alone', async () => {
      const { repo, run } = setup({ provider: makeProvider('Added some stuff') });
      await run(COMMIT);
      expect(repo.inputBox.value).toBe('');
      expect(String(window.showErrorMessage.mock.calls[0]?.[0])).toMatch(/Conventional Commit format/);
    });

    it('treats unexpected errors generically: no raw text on screen, redacted in the log', async () => {
      const { run, logger } = setup();
      gitMock.selectRepository.mockRejectedValue(new Error(`weird failure with ${FAKE.githubToken}`));
      await run(COMMIT);
      const shown = String(window.showErrorMessage.mock.calls[0]?.[0]);
      expect(shown).toMatch(/Something unexpected went wrong/);
      expect(shown).not.toContain(FAKE.githubToken);
      const logged = String(logger.error.mock.calls[0]?.[0]);
      expect(logged).toMatch(/^UNEXPECTED /);
      expect(logged).not.toContain(FAKE.githubToken);
    });

    it('logs only the error code (and cause class), never prompts or diffs', async () => {
      const cause = Object.assign(new Error(`secret ${FAKE.sessionSecret}`), { status: 500 });
      const { run, logger } = setup({ provider: makeProvider(new CommitCraftError('PROVIDER_ERROR', 'Provider trouble.', { cause })) });
      await run(COMMIT);
      expect(logger.error).toHaveBeenCalledWith('PROVIDER_ERROR (Error HTTP 500)');
      const everythingLogged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
      expect(everythingLogged).not.toContain(FAKE.sessionSecret);
      expect(everythingLogged).not.toContain('SESSION_TTL_MS');
    });

    it('logs counts after a success, not content', async () => {
      const { run, logger } = setup();
      await run(COMMIT);
      expect(logger.info).toHaveBeenCalledWith('commit message generated: provider=anthropic files=1 redactions=0 truncated=false');
    });
  });

  describe('concurrency and cancellation', () => {
    it('refuses a second run while one is in progress, then allows a new one', async () => {
      let release: (text: string) => void = () => undefined;
      const { repo, run, generate } = setup({
        provider: makeProvider(
          () =>
            new Promise<string>((resolve) => {
              release = resolve;
            }),
        ),
      });
      const first = run(COMMIT);
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

      await run(COMMIT);
      expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('already working'));
      expect(generate).toHaveBeenCalledTimes(1);

      release('fix: first run');
      await first;
      expect(repo.inputBox.value).toBe('fix: first run');
      repo.inputBox.value = ''; // otherwise the overwrite confirmation (correctly) stops the third run
      const third = run(COMMIT);
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      release('fix: third run');
      await third;
    });

    it('stops quietly when the user cancels the progress notification', async () => {
      const { repo, run } = setup({
        provider: makeProvider(
          (_prompt, options) =>
            new Promise<string>((_resolve, reject) => {
              options.signal?.addEventListener('abort', () => reject(new CommitCraftError('CANCELLED', 'cancelled')));
            }),
        ),
      });
      mockState.onProgressStart = (token) => {
        setTimeout(() => token.cancel(), 0);
      };
      await run(COMMIT);
      expect(repo.inputBox.value).toBe('');
      expect(window.showErrorMessage).not.toHaveBeenCalled();
      expect(window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('releases the guard after a failure so the next run works', async () => {
      const { run, generate } = setup({ provider: makeProvider(new CommitCraftError('RATE_LIMITED', 'Slow down.')) });
      await run(COMMIT);
      await run(COMMIT);
      expect(generate).toHaveBeenCalledTimes(2);
    });
  });

  it('passes the command argument (the SCM source control) to repository selection', async () => {
    const { run } = setup();
    const sourceControl = { rootUri: { fsPath: '/work/app' } };
    await run(COMMIT, sourceControl);
    expect(gitMock.selectRepository).toHaveBeenCalledWith(expect.anything(), sourceControl);
  });
});

describe('Generate PR Description', () => {
  const prSetup = (options: Parameters<typeof setup>[0] = {}) => setup({ ...options, runGit: fakeGit });

  const fakeGit: RunGit = (args) => {
    if (args[0] === 'rev-parse') {
      return Promise.resolve('c0ffee\n');
    }
    if (args[0] === 'merge-base') {
      return Promise.resolve('abc123\n');
    }
    if (args[0] === 'rev-list') {
      return Promise.resolve('2\n');
    }
    if (args[0] === 'log') {
      return Promise.resolve('fix: typo\nfeat: add login\n'); // real git prints the newest commit first
    }
    if (args.includes('diff')) {
      return Promise.resolve(loadFixture('mixed-commit'));
    }
    return Promise.reject(new Error(`unexpected git call: ${args.join(' ')}`));
  };

  it('opens the description in a new untitled Markdown tab', async () => {
    const { run, generate } = prSetup({ provider: makeProvider(GOOD_PR) });
    await run(PR);

    const [prompt] = generate.mock.calls[0] as [BuiltPrompt, GenerateOptions];
    expect(prompt.user).toContain('branch "feature/x" compared with base branch "main"');
    expect(prompt.user).toContain('- feat: add login\n- fix: typo');
    expect(workspace.openTextDocument).toHaveBeenCalledWith({ language: 'markdown', content: `${GOOD_PR}\n` });
    expect(window.showTextDocument).toHaveBeenCalledWith(expect.anything(), { preview: false });
    expect(progressReports[0]).toBe('Reading branch changes…');
  });

  it('runs git through the Git extension binary in the repository folder, with the cancel signal', async () => {
    const { run } = prSetup({ provider: makeProvider(GOOD_PR) });
    await run(PR);
    expect(gitMock.createRunGit).toHaveBeenCalledWith('/usr/bin/git', '/work/app', expect.any(AbortSignal));
  });

  it('uses the baseBranch setting', async () => {
    mockState.settings = { baseBranch: 'develop' };
    const { run, generate } = prSetup({ provider: makeProvider(GOOD_PR) });
    await run(PR);
    expect((generate.mock.calls[0] as [BuiltPrompt, GenerateOptions])[0].user).toContain('base branch "develop"');
  });

  it('explains when you are on the base branch (a warning, not an error) and opens nothing', async () => {
    const { run, generate } = prSetup({ repo: makeRepo({ head: { name: 'main', commit: 'deadbeef' } }) });
    await run(PR);
    expect(String(window.showWarningMessage.mock.calls[0]?.[0])).toMatch(/You are on main/);
    expect(generate).not.toHaveBeenCalled();
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('explains a detached HEAD', async () => {
    const { run } = prSetup({ repo: makeRepo({ head: { commit: 'deadbeef' } }) });
    await run(PR);
    expect(String(window.showWarningMessage.mock.calls[0]?.[0])).toMatch(/HEAD is detached/);
  });

  it('a malformed description opens no tab', async () => {
    const { run } = prSetup({ provider: makeProvider('## Summary\nOnly this.') });
    await run(PR);
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
    expect(String(window.showErrorMessage.mock.calls[0]?.[0])).toMatch(/missing the Changes and Testing and Risks/);
  });

  it('reports a missing API key the same way as the commit flow', async () => {
    const { run, generate } = prSetup({ key: undefined });
    await run(PR);
    expect(window.showInformationMessage.mock.calls[0]?.[0]).toMatch(/needs an Anthropic API key/);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('Set API Key', () => {
  it('stores the trimmed key in SecretStorage and never shows it', async () => {
    const { run, context } = setup();
    window.showInputBox.mockResolvedValueOnce(`  ${API_KEY}\n`);
    await run(SET_KEY);
    expect(context.secrets.store).toHaveBeenCalledWith('commitcraft.anthropicApiKey', API_KEY);
    const shown = JSON.stringify([...window.showInformationMessage.mock.calls, ...window.setStatusBarMessage.mock.calls, ...channel.info.mock.calls]);
    expect(shown).not.toContain(API_KEY);
    expect(shown).toContain('API key saved');
  });

  it('asks for a masked input that ignores focus loss and validates', async () => {
    const { run } = setup();
    await run(SET_KEY);
    const options = window.showInputBox.mock.calls[0]?.[0] as { password: boolean; ignoreFocusOut: boolean; validateInput: (v: string) => string | undefined };
    expect(options.password).toBe(true);
    expect(options.ignoreFocusOut).toBe(true);
    expect(options.validateInput('')).toEqual(expect.any(String));
    expect(options.validateInput(API_KEY)).toBeUndefined();
  });

  it('stores nothing when the user cancels', async () => {
    const { run, context } = setup();
    await run(SET_KEY);
    expect(context.secrets.store).not.toHaveBeenCalled();
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('explains a SecretStorage failure (no OS keychain) without including the key', async () => {
    const { run, context } = setup();
    context.secrets.store.mockRejectedValueOnce(new Error(`keychain locked while storing ${API_KEY}`));
    window.showInputBox.mockResolvedValueOnce(API_KEY);
    await run(SET_KEY);
    const shown = String(window.showErrorMessage.mock.calls[0]?.[0]);
    expect(shown).toMatch(/secure storage/);
    expect(shown).toMatch(/keyring/);
    expect(shown).not.toContain(API_KEY);
  });
});


describe('findings from the independent review', () => {
  describe('the staged diff comes from git with fixed flags (not the API call a user config can break)', () => {
    it('reports a git failure while reading the staged changes, with a Show Log button', async () => {
      const failing: RunGit = () => Promise.reject(Object.assign(new Error('fatal'), { exitCode: 128 }));
      const { run, generate, logger } = setup({ runGit: failing });
      window.showErrorMessage.mockResolvedValueOnce('Show Log');
      await run(COMMIT);
      expect(String(window.showErrorMessage.mock.calls[0]?.[0])).toMatch(/Git could not read the staged changes/);
      expect(window.showErrorMessage.mock.calls[0]).toContain('Show Log');
      expect(generate).not.toHaveBeenCalled();
      expect(logger.show).toHaveBeenCalledTimes(1);
    });

    it('logs the git exit code and first stderr line, so "see the log" is true', async () => {
      const failing: RunGit = () =>
        Promise.reject(Object.assign(new Error('fatal'), { exitCode: 128, stderrSummary: `fatal: bad object ${FAKE.githubToken}` }));
      const { run, logger } = setup({ runGit: failing });
      await run(COMMIT);
      const logged = String(logger.error.mock.calls[0]?.[0]);
      expect(logged).toMatch(/^GIT_ERROR \(Error exit 128: fatal: bad object /);
      expect(logged).not.toContain(FAKE.githubToken); // redacted before it is written
    });
  });

  describe('text typed while the AI is working is not silently overwritten', () => {
    function startRun(): { repo: FakeRepo; run: ReturnType<typeof setup>['run']; finish: (text: string) => Promise<void>; generate: ReturnType<typeof setup>['generate'] } {
      let release: (text: string) => void = () => undefined;
      const ctx = setup({
        provider: makeProvider(
          () =>
            new Promise<string>((resolve) => {
              release = resolve;
            }),
        ),
      });
      const running = ctx.run(COMMIT);
      return {
        repo: ctx.repo,
        run: ctx.run,
        generate: ctx.generate,
        finish: async (text) => {
          await vi.waitFor(() => expect(ctx.generate).toHaveBeenCalledTimes(1));
          ctx.repo.inputBox.value = 'typed meanwhile';
          release(text);
          await running;
        },
      };
    }

    it('asks again, and Replace overwrites', async () => {
      const { repo, finish } = startRun();
      window.showWarningMessage.mockResolvedValueOnce('Replace');
      await finish('fix: generated');
      expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('changed while'), { modal: true }, 'Replace', 'Open in New Tab');
      expect(repo.inputBox.value).toBe('fix: generated');
    });

    it('Open in New Tab keeps what the user typed and shows the generated message in a tab', async () => {
      const { repo, finish } = startRun();
      window.showWarningMessage.mockResolvedValueOnce('Open in New Tab');
      await finish('fix: generated');
      expect(repo.inputBox.value).toBe('typed meanwhile');
      expect(workspace.openTextDocument).toHaveBeenCalledWith({ content: 'fix: generated' });
      expect(window.showTextDocument).toHaveBeenCalledTimes(1);
    });

    it('dismissing keeps what the user typed and opens nothing', async () => {
      const { repo, finish } = startRun();
      window.showWarningMessage.mockResolvedValueOnce(undefined);
      await finish('fix: generated');
      expect(repo.inputBox.value).toBe('typed meanwhile');
      expect(workspace.openTextDocument).not.toHaveBeenCalled();
    });

    it('does not ask when the box did not change', async () => {
      const { repo, run } = setup();
      await run(COMMIT);
      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(repo.inputBox.value).toBe('feat(auth): shorten session lifetime');
    });
  });

  it('an error toast that is still open does not clear the busy flag of a newer run', async () => {
    let calls = 0;
    let releaseSecond: (text: string) => void = () => undefined;
    const { run, generate, repo } = setup({
      provider: makeProvider(() => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new CommitCraftError('NETWORK', 'Could not reach the AI provider.'));
        }
        return new Promise<string>((resolve) => {
          releaseSecond = resolve;
        });
      }),
    });
    let closeToast: (value: unknown) => void = () => undefined;
    window.showErrorMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          closeToast = resolve;
        }),
    );

    const first = run(COMMIT);
    await vi.waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledTimes(1)); // toast is open, nothing is running

    const second = run(COMMIT); // allowed: the failed run is over
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));

    closeToast(undefined); // the old toast closes while the second run is still going
    await first;

    await run(COMMIT); // must be refused: the second run is still in progress
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('already working'));
    expect(generate).toHaveBeenCalledTimes(2);

    releaseSecond('fix: second');
    await second;
    expect(repo.inputBox.value).toBe('fix: second');
  });

  describe('the OS keychain can be unavailable (common on Linux and WSL)', () => {
    it('explains a failure to READ the key, and does not call the AI', async () => {
      const { run, generate, context } = setup();
      context.secrets.get.mockRejectedValueOnce(new Error('The name org.freedesktop.secrets was not provided'));
      await run(COMMIT);
      const shown = String(window.showErrorMessage.mock.calls[0]?.[0]);
      expect(shown).toMatch(/secure storage/);
      expect(shown).not.toMatch(/freedesktop/);
      expect(generate).not.toHaveBeenCalled();
    });
  });
});


describe('choosing the AI provider (Anthropic or Google Gemini)', () => {
  const ANTHROPIC_SECRET = 'commitcraft.anthropicApiKey';
  const GEMINI_SECRET = 'commitcraft.geminiApiKey';
  const GEMINI_KEY = ['AQ', '.', 'FAKE-gemini-key-for-tests-0123456789'].join('');

  it('uses Anthropic by default, with the Anthropic key and model', async () => {
    const context = makeKeyedContext({ [ANTHROPIC_SECRET]: API_KEY, [GEMINI_SECRET]: GEMINI_KEY });
    const { run, generate, geminiGenerate } = setup({ context });
    await run(COMMIT);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(geminiGenerate).not.toHaveBeenCalled();
    expect((generate.mock.calls[0] as [BuiltPrompt, GenerateOptions])[1]).toMatchObject({ apiKey: API_KEY, model: 'claude-opus-5-5' });
  });

  it('uses Gemini when commitcraft.provider is gemini: its provider, ITS key, and its default model', async () => {
    mockState.settings = { provider: 'gemini', model: '' };
    const context = makeKeyedContext({ [ANTHROPIC_SECRET]: API_KEY, [GEMINI_SECRET]: GEMINI_KEY });
    const { run, generate, geminiGenerate, repo } = setup({ context });
    await run(COMMIT);
    expect(generate).not.toHaveBeenCalled();
    expect(geminiGenerate).toHaveBeenCalledTimes(1);
    expect((geminiGenerate.mock.calls[0] as [BuiltPrompt, GenerateOptions])[1]).toMatchObject({
      apiKey: GEMINI_KEY,
      model: 'gemini-3.5-flash-lite',
    });
    expect(repo.inputBox.value).toBe('feat(auth): shorten session lifetime (gemini)');
  });

  it('never sends one provider the other provider\'s key', async () => {
    mockState.settings = { provider: 'gemini' };
    const context = makeKeyedContext({ [ANTHROPIC_SECRET]: API_KEY }); // only an Anthropic key is stored
    const { run, geminiGenerate } = setup({ context });
    window.showInformationMessage.mockResolvedValueOnce(undefined);
    await run(COMMIT);
    expect(geminiGenerate).not.toHaveBeenCalled(); // no Gemini key, so it asks instead of reusing the Anthropic one
    expect(String(window.showInformationMessage.mock.calls[0]?.[0])).toMatch(/needs a Google Gemini API key/);
  });

  it('an explicit commitcraft.model is passed through for Gemini', async () => {
    mockState.settings = { provider: 'gemini', model: 'gemini-3.8-flash' };
    const context = makeKeyedContext({ [GEMINI_SECRET]: GEMINI_KEY });
    const { run, geminiGenerate } = setup({ context });
    await run(COMMIT);
    expect((geminiGenerate.mock.calls[0] as [BuiltPrompt, GenerateOptions])[1].model).toBe('gemini-3.8-flash');
  });

  it('works the same for the PR description', async () => {
    mockState.settings = { provider: 'gemini' };
    const context = makeKeyedContext({ [GEMINI_SECRET]: GEMINI_KEY });
    const { run, geminiGenerate } = setup({
      context,
      gemini: makeProvider(GOOD_PR),
      runGit: (args) =>
        args[0] === 'rev-parse' ? Promise.resolve('c0ffee\n')
        : args[0] === 'merge-base' ? Promise.resolve('abc123\n')
        : args[0] === 'rev-list' ? Promise.resolve('1\n')
        : args[0] === 'log' ? Promise.resolve('feat: add login\n')
        : Promise.resolve(loadFixture('mixed-commit')),
    });
    await run(PR);
    expect(geminiGenerate).toHaveBeenCalledTimes(1);
    expect(workspace.openTextDocument).toHaveBeenCalledWith({ language: 'markdown', content: `${GOOD_PR}\n` });
  });

  describe('the key prompt', () => {
    it('Set API Key stores the Anthropic key under its own name by default', async () => {
      const { run, context } = setup();
      window.showInputBox.mockResolvedValueOnce(API_KEY);
      await run(SET_KEY);
      expect(context.secrets.store).toHaveBeenCalledWith(ANTHROPIC_SECRET, API_KEY);
    });

    it('Set API Key stores the Gemini key under a separate name when Gemini is selected', async () => {
      mockState.settings = { provider: 'gemini' };
      const { run, context } = setup();
      window.showInputBox.mockResolvedValueOnce(GEMINI_KEY);
      await run(SET_KEY);
      expect(context.secrets.store).toHaveBeenCalledWith(GEMINI_SECRET, GEMINI_KEY);
      expect(context.secrets.store).not.toHaveBeenCalledWith(ANTHROPIC_SECRET, expect.anything());
    });

    it('the Gemini prompt says where to get a key, where it is sent, and warns about the free tier', async () => {
      mockState.settings = { provider: 'gemini' };
      const { run } = setup();
      await run(SET_KEY);
      const options = window.showInputBox.mock.calls[0]?.[0] as { title: string; prompt: string; password: boolean };
      expect(options.password).toBe(true);
      expect(options.title).toMatch(/Gemini/);
      expect(options.prompt).toMatch(/Google AI Studio/);
      expect(options.prompt).toMatch(/generativelanguage\.googleapis\.com/);
      expect(options.prompt).toMatch(/free tier/i);
      expect(options.prompt).toMatch(/human reviewers|improve/i);
      expect(options.prompt).toMatch(/confidential/i);
    });

    it('the Anthropic prompt still names Anthropic and its endpoint only', async () => {
      const { run } = setup();
      await run(SET_KEY);
      const options = window.showInputBox.mock.calls[0]?.[0] as { prompt: string };
      expect(options.prompt).toMatch(/api\.anthropic\.com/);
      expect(options.prompt).not.toMatch(/Gemini/);
    });

    it('after a rejected Gemini key, the Set API Key button asks for a GEMINI key', async () => {
      mockState.settings = { provider: 'gemini' };
      const context = makeKeyedContext({ [GEMINI_SECRET]: GEMINI_KEY });
      const { run } = setup({
        context,
        gemini: makeProvider(new CommitCraftError('INVALID_API_KEY', 'The Gemini API key was rejected.')),
      });
      window.showErrorMessage.mockResolvedValueOnce('Set API Key');
      window.showInputBox.mockResolvedValueOnce(GEMINI_KEY);
      await run(COMMIT);
      expect(context.secrets.store).toHaveBeenCalledWith(GEMINI_SECRET, GEMINI_KEY);
    });

    it('says which provider the saved key is for, and never shows the key', async () => {
      mockState.settings = { provider: 'gemini' };
      const { run } = setup();
      window.showInputBox.mockResolvedValueOnce(GEMINI_KEY);
      await run(SET_KEY);
      const shown = JSON.stringify(window.showInformationMessage.mock.calls);
      expect(shown).toContain('Google Gemini');
      expect(shown).not.toContain(GEMINI_KEY);
    });
  });

  describe('transparency about where the diff went', () => {
    it('names the provider in the confirmation and in the log', async () => {
      mockState.settings = { provider: 'gemini' };
      const context = makeKeyedContext({ [GEMINI_SECRET]: GEMINI_KEY });
      const { run, logger } = setup({ context });
      await run(COMMIT);
      expect(window.setStatusBarMessage).toHaveBeenCalledWith(expect.stringContaining('Google Gemini'), 4000);
      expect(logger.info).toHaveBeenCalledWith('commit message generated: provider=gemini files=1 redactions=0 truncated=false');
    });

    it('names the provider when it also reports what was masked', async () => {
      mockState.settings = { provider: 'gemini' };
      const context = makeKeyedContext({ [GEMINI_SECRET]: GEMINI_KEY });
      const { run } = setup({ context, repo: makeRepo({ diff: loadFixture('secrets') }) });
      await run(COMMIT);
      const message = String(window.showInformationMessage.mock.calls.at(-1)?.[0]);
      expect(message).toMatch(/Google Gemini/);
      expect(message).toMatch(/masked/);
    });
  });
});
