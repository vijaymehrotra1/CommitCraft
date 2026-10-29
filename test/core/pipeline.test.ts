import { describe, expect, it, vi } from 'vitest';
import { CommitCraftError } from '../../src/core/errors';
import {
  COMMIT_MAX_TOKENS,
  PR_MAX_TOKENS,
  generateCommitMessage,
  generatePrDescription,
  type PipelineStage,
} from '../../src/core/pipeline';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import type { AiProvider, BuiltPrompt, GenerateOptions } from '../../src/core/types';
import { FAKE } from '../helpers/fakeSecrets';
import { loadFixture, makeHugeDiff } from '../helpers/fixtures';

const settings = { ...DEFAULT_SETTINGS, model: 'test-model' };
const API_KEY = 'key-for-tests-only';

const GOOD_PR = '## Summary\nA.\n\n## Changes\n- b\n\n## Testing\n- c\n\n## Risks\nNone identified.';

interface Spy {
  provider: AiProvider;
  generate: ReturnType<typeof vi.fn<(prompt: BuiltPrompt, options: GenerateOptions) => Promise<string>>>;
  sentText: () => string;
}

function spyProvider(reply: string | Error): Spy {
  const generate = vi.fn<(prompt: BuiltPrompt, options: GenerateOptions) => Promise<string>>(() =>
    reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
  );
  return {
    provider: { generate },
    generate,
    sentText: () => {
      const prompt = generate.mock.calls[0]?.[0];
      return prompt ? `${prompt.system}\n${prompt.user}` : '';
    },
  };
}

const commitRequest = (rawDiff: string, spy: Spy, extra: object = {}) => ({
  rawDiff,
  apiKey: API_KEY,
  provider: spy.provider,
  settings,
  ...extra,
});

const prRequest = (rawDiff: string, spy: Spy, extra: object = {}) => ({
  ...commitRequest(rawDiff, spy, extra),
  branchName: 'feature/login',
  commitSubjects: ['feat: add login'],
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof CommitCraftError ? error.code : `unexpected: ${String(error)}`;
  }
  return 'no error';
}

describe('generateCommitMessage', () => {
  it('sends the redacted diff and returns the cleaned message', async () => {
    const spy = spyProvider('```\nfeat(auth): shorten session lifetime\n\nSessions now expire after 30 minutes.\n```');
    const result = await generateCommitMessage(commitRequest(loadFixture('normal-edit'), spy));

    expect(result.text).toBe('feat(auth): shorten session lifetime\n\nSessions now expire after 30 minutes.');
    expect(result.stats).toMatchObject({ files: 1, additions: 3, deletions: 3, truncated: false });
    expect(result.redactions).toBe(0);
    expect(result.notices).toEqual([]);

    expect(spy.generate).toHaveBeenCalledTimes(1);
    const [prompt, options] = spy.generate.mock.calls[0] as [BuiltPrompt, GenerateOptions];
    expect(prompt.user).toContain('src/auth/session.ts');
    expect(prompt.user).toContain('+const SESSION_TTL_MS = 30 * 60 * 1000;');
    expect(options).toMatchObject({ apiKey: API_KEY, model: 'test-model', maxTokens: COMMIT_MAX_TOKENS, timeoutMs: 60_000 });
  });

  it('reports stages in order', async () => {
    const stages: PipelineStage[] = [];
    await generateCommitMessage(
      commitRequest(loadFixture('normal-edit'), spyProvider('fix: x'), { onStage: (s: PipelineStage) => stages.push(s) }),
    );
    expect(stages).toEqual(['preparing', 'generating']);
  });

  describe('secrets never leave the machine', () => {
    const everyFakeSecret = [
      FAKE.awsAccessKey,
      FAKE.anthropicKey,
      FAKE.githubToken,
      FAKE.jwt,
      FAKE.dbPassword,
      FAKE.sessionSecret,
      FAKE.pkLine1,
      FAKE.pkLine2,
    ];

    it('masks secrets and drops sensitive files from everything sent to the provider', async () => {
      const spy = spyProvider('chore: update configuration');
      const result = await generateCommitMessage(commitRequest(loadFixture('secrets'), spy));
      const sent = spy.sentText();

      for (const secret of everyFakeSecret) {
        expect(sent).not.toContain(secret);
      }
      // .env, id_rsa and server.pem are named but their content is never included.
      expect(sent).not.toContain('SESSION_SECRET');
      expect(sent).not.toContain('DATABASE_URL');
      expect(sent).toContain('.env (sensitive file)');
      expect(sent).toContain('deploy/id_rsa (sensitive file)');
      expect(sent).toContain('certs/server.pem (sensitive file)');
      // Non-secret code still reaches the model so the message can be accurate.
      expect(sent).toContain("+  region: 'us-east-1',");

      expect(result.redactions).toBeGreaterThanOrEqual(8);
      expect(result.notices.join(' ')).toMatch(/possible secrets were masked before sending/);
      expect(result.notices.join(' ')).toMatch(/not sent .*\.env: sensitive file/);
    });

    it('masks a private key even when truncation would have cut it in half', async () => {
      const filler = Array.from({ length: 400 }, (_, i) => `+filler line ${i} with enough text to matter`);
      const raw = [
        'diff --git a/src/keys.ts b/src/keys.ts',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/src/keys.ts',
        '@@ -0,0 +1,500 @@',
        `+export const key = \`${FAKE.pkBegin}`,
        ...Array.from({ length: 40 }, (_, i) => `+${FAKE.pkLine1}${i}`),
        `+${FAKE.pkEnd}\`;`,
        ...filler,
        '',
      ].join('\n');
      const spy = spyProvider('feat: add keys');
      await generateCommitMessage(commitRequest(raw, spy, { maxDiffChars: 1_000 }));
      expect(spy.sentText()).not.toContain(FAKE.pkLine1);
    });

    it('masks secrets that appear in file names', async () => {
      const raw = [
        `diff --git a/src/${FAKE.githubToken}.ts b/src/${FAKE.githubToken}.ts`,
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        `+++ b/src/${FAKE.githubToken}.ts`,
        '@@ -0,0 +1 @@',
        '+export const a = 1;',
        '',
      ].join('\n');
      const spy = spyProvider('feat: add file');
      await generateCommitMessage(commitRequest(raw, spy));
      expect(spy.sentText()).not.toContain(FAKE.githubToken);
    });

    it('an unterminated key in the last file masks that file only, not the rest of the prompt', async () => {
      const unterminated = [
        'diff --git a/src/key.ts b/src/key.ts',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/src/key.ts',
        '@@ -0,0 +1,3 @@',
        `+const key = \`${FAKE.pkBegin}`,
        `+${FAKE.pkLine1}`,
        '+// the key block above never ends',
        '',
      ].join('\n');
      const raw = `${unterminated}${loadFixture('lock-file')}`; // a lock file after it adds a trailing "not included" list
      const spy = spyProvider('chore: x');
      await generateCommitMessage(commitRequest(raw, spy));
      const sent = spy.sentText();
      expect(sent).not.toContain(FAKE.pkLine1);
      expect(sent).toContain('Files whose content is not included:\n- package-lock.json (lock file)');
      expect(sent.trimEnd().endsWith('</diff>')).toBe(true);
    });
  });

  describe('files that are never read', () => {
    it('sends only names for a lock-file-only commit and still asks for a message', async () => {
      const spy = spyProvider('chore(deps): update lockfile');
      const result = await generateCommitMessage(commitRequest(loadFixture('lock-file'), spy));
      expect(result.text).toBe('chore(deps): update lockfile');
      const sent = spy.sentText();
      expect(sent).toContain('package-lock.json (lock file)');
      expect(sent).not.toContain('FAKEINTEGRITY');
      expect(result.notices.join(' ')).toMatch(/Content of 1 file was not sent/);
    });

    it('sends only names for binary files', async () => {
      const spy = spyProvider('chore: update images');
      await generateCommitMessage(commitRequest(loadFixture('binary-file'), spy));
      expect(spy.sentText()).toContain('assets/banner.png (binary file)');
    });
  });

  describe('size limit', () => {
    it('truncates a huge diff, tells the user, and keeps what is sent under the limit', async () => {
      const spy = spyProvider('feat: add generated files');
      const result = await generateCommitMessage(commitRequest(makeHugeDiff(30, 200), spy, { maxDiffChars: 20_000 }));
      expect(result.stats.truncated).toBe(true);
      expect(result.notices.join(' ')).toMatch(/too large to send in full/);
      expect(spy.sentText()).toMatch(/Note: the diff was too large to send in full/);
      expect(spy.sentText().length).toBeLessThan(26_000);
    });
  });

  describe('nothing to do', () => {
    it.each([
      ['an empty diff', ''],
      ['a whitespace-only diff', '  \n\n  \n'],
      ['text that is not a diff', 'hello, this is not a diff\n'],
    ])('rejects %s with NO_STAGED_CHANGES and never calls the provider', async (_label, raw) => {
      const spy = spyProvider('fix: x');
      expect(await codeOf(generateCommitMessage(commitRequest(raw, spy)))).toBe('NO_STAGED_CHANGES');
      expect(spy.generate).not.toHaveBeenCalled();
    });

    it('tells the user what to do next', async () => {
      const spy = spyProvider('fix: x');
      await expect(generateCommitMessage(commitRequest('', spy))).rejects.toThrow(/Stage the files/);
    });
  });

  describe('provider and response problems', () => {
    it('passes CommitCraftErrors from the provider through unchanged', async () => {
      const original = new CommitCraftError('RATE_LIMITED', 'slow down');
      const spy = spyProvider(original);
      await expect(generateCommitMessage(commitRequest(loadFixture('normal-edit'), spy))).rejects.toBe(original);
    });

    it('wraps unexpected provider errors without leaking their message', async () => {
      const spy = spyProvider(new Error(`kaboom ${FAKE.githubToken}`));
      const error = await generateCommitMessage(commitRequest(loadFixture('normal-edit'), spy)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CommitCraftError);
      expect((error as CommitCraftError).code).toBe('PROVIDER_ERROR');
      expect((error as CommitCraftError).message).not.toContain(FAKE.githubToken);
    });

    it('rejects a malformed answer (not Conventional Commits)', async () => {
      const spy = spyProvider('Added some stuff to the session code');
      expect(await codeOf(generateCommitMessage(commitRequest(loadFixture('normal-edit'), spy)))).toBe('MALFORMED_RESPONSE');
    });

    it('accepts the same answer in plain style', async () => {
      const spy = spyProvider('Added some stuff to the session code.');
      const result = await generateCommitMessage(
        commitRequest(loadFixture('normal-edit'), spy, { settings: { ...settings, style: 'plain' } }),
      );
      expect(result.text).toBe('Added some stuff to the session code');
    });

    it('rejects an empty answer', async () => {
      const spy = spyProvider('   ');
      expect(await codeOf(generateCommitMessage(commitRequest(loadFixture('normal-edit'), spy)))).toBe('EMPTY_RESPONSE');
    });

    it('surfaces subject shortening as a notice', async () => {
      const spy = spyProvider(`feat: ${'add a really quite long description of things '.repeat(4)}`);
      const result = await generateCommitMessage(commitRequest(loadFixture('normal-edit'), spy));
      expect(result.notices.join(' ')).toMatch(/shortened to fit 72 characters/);
    });
  });

  describe('cancellation', () => {
    it('does not call the provider if cancelled before it starts', async () => {
      const spy = spyProvider('fix: x');
      const controller = new AbortController();
      controller.abort();
      expect(await codeOf(generateCommitMessage(commitRequest(loadFixture('normal-edit'), spy, { signal: controller.signal })))).toBe(
        'CANCELLED',
      );
      expect(spy.generate).not.toHaveBeenCalled();
    });

    it('reports CANCELLED when the signal fires while the provider is running', async () => {
      const controller = new AbortController();
      const provider: AiProvider = {
        generate: () => {
          controller.abort();
          return Promise.reject(new Error('fetch failed'));
        },
      };
      const code = await codeOf(
        generateCommitMessage({ rawDiff: loadFixture('normal-edit'), apiKey: API_KEY, provider, settings, signal: controller.signal }),
      );
      expect(code).toBe('CANCELLED');
    });

    it('passes the signal to the provider', async () => {
      const spy = spyProvider('fix: x');
      const controller = new AbortController();
      await generateCommitMessage(commitRequest(loadFixture('normal-edit'), spy, { signal: controller.signal }));
      expect((spy.generate.mock.calls[0] as [BuiltPrompt, GenerateOptions])[1].signal).toBe(controller.signal);
    });
  });
});

describe('generatePrDescription', () => {
  it('sends commits, branch names and the diff, and returns the cleaned description', async () => {
    const spy = spyProvider(`Here is the PR description:\n\n${GOOD_PR}`);
    const result = await generatePrDescription(prRequest(loadFixture('mixed-commit'), spy));

    expect(result.text).toBe(`${GOOD_PR}\n`);
    const [prompt, options] = spy.generate.mock.calls[0] as [BuiltPrompt, GenerateOptions];
    expect(prompt.user).toContain('branch "feature/login" compared with base branch "main"');
    expect(prompt.user).toContain('- feat: add login');
    expect(prompt.user).toContain('src/auth/password.ts');
    expect(prompt.system).toContain('## Risks');
    expect(options.maxTokens).toBe(PR_MAX_TOKENS);
    expect(result.notices.join(' ')).toMatch(/Content of 2 files was not sent/);
  });

  it('masks secrets in commit subjects and branch names, and in the diff', async () => {
    const spy = spyProvider(GOOD_PR);
    await generatePrDescription({
      ...prRequest(loadFixture('secrets'), spy),
      commitSubjects: [`fix: rotate ${FAKE.awsAccessKey}`],
      branchName: `hotfix/${FAKE.githubToken}`,
    });
    const sent = spy.sentText();
    expect(sent).not.toContain(FAKE.awsAccessKey);
    expect(sent).not.toContain(FAKE.githubToken);
    expect(sent).not.toContain(FAKE.pkLine1);
  });

  it('tells the model how many older commits were left out when the list was trimmed', async () => {
    const spy = spyProvider(GOOD_PR);
    await generatePrDescription({ ...prRequest(loadFixture('normal-edit'), spy), commitSubjects: ['feat: a', 'fix: b', 'chore: c'], totalCommits: 10 });
    expect(spy.sentText()).toContain('(7 older commits not shown)');
  });

  it('counts redactions from commit subjects too', async () => {
    const spy = spyProvider(GOOD_PR);
    const result = await generatePrDescription({
      ...prRequest(loadFixture('normal-edit'), spy),
      commitSubjects: [`fix: rotate ${FAKE.awsAccessKey}`],
    });
    expect(result.redactions).toBe(1);
  });

  it('rejects an empty branch diff with NO_BRANCH_CHANGES', async () => {
    const spy = spyProvider(GOOD_PR);
    expect(await codeOf(generatePrDescription(prRequest('', spy)))).toBe('NO_BRANCH_CHANGES');
    expect(spy.generate).not.toHaveBeenCalled();
  });

  it('rejects an answer that is missing sections', async () => {
    const spy = spyProvider('## Summary\nOnly a summary.');
    expect(await codeOf(generatePrDescription(prRequest(loadFixture('normal-edit'), spy)))).toBe('MALFORMED_RESPONSE');
  });

  it('allows a larger diff than the commit flow', async () => {
    const spy = spyProvider(GOOD_PR);
    const raw = makeHugeDiff(1, 700);
    const commit = await generateCommitMessage(commitRequest(raw, spyProvider('feat: x')));
    const pr = await generatePrDescription(prRequest(raw, spy));
    expect(raw.length).toBeGreaterThan(40_000);
    expect(commit.stats.truncated).toBe(true);
    expect(pr.stats.truncated).toBe(false);
  });
});
