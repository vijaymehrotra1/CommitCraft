// Smoke tests that run inside VS Code's extension host, against the REAL built-in Git extension and a
// real git binary. The logic is unit tested; these prove the packaged extension loads, wires itself
// into VS Code, and that our assumptions about the Git extension API hold.
// A tiny runner instead of Mocha keeps the dev dependencies down.
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { CommitCraftError } from '../../../src/core/errors';
import { parseDiff } from '../../../src/core/diff';
import { generateCommitMessage } from '../../../src/core/pipeline';
import { DEFAULT_SETTINGS } from '../../../src/core/settings';
import type { AiProvider, BuiltPrompt } from '../../../src/core/types';
import { createRunGit, getGitApi, selectRepository } from '../../../src/vscode/git';
import { getBranchChanges, getStagedDiff } from '../../../src/vscode/gitChanges';
import type { GitRepository } from '../../../src/vscode/gitTypes';

const EXTENSION_ID = 'vijay-mehrotra.commitcraft';

interface SmokeTest {
  name: string;
  run: () => Promise<void>;
}

const workspaceRoot = (): string => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder is open');
  return realpathSync(folder.uri.fsPath);
};

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', workspaceRoot(), ...args], { encoding: 'utf8' });

const write = (name: string, content: string): void => {
  writeFileSync(join(workspaceRoot(), name), content);
};

/** Our code only needs the structural subset; the real Repository has more (status(), ...). */
type RealRepository = GitRepository & { status(): Promise<void> };

async function realRepository(): Promise<{ repo: RealRepository; gitPath: string }> {
  const api = await getGitApi();
  const repo = (await selectRepository(api)) as RealRepository | undefined;
  assert.ok(repo, 'the Git extension did not find the workspace repository');
  await repo.status();
  return { repo, gitPath: api.git.path };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof CommitCraftError ? error.code : `unexpected: ${String(error)}`;
  }
  return 'no error';
}

const tests: SmokeTest[] = [
  {
    name: 'the extension is installed and activates',
    run: async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(extension, `extension ${EXTENSION_ID} not found`);
      await extension.activate();
      assert.strictEqual(extension.isActive, true);
    },
  },
  {
    name: 'registers the three commands',
    run: async () => {
      await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
      const commands = await vscode.commands.getCommands(true);
      for (const id of ['commitcraft.generateCommitMessage', 'commitcraft.generatePrDescription', 'commitcraft.setApiKey']) {
        assert.ok(commands.includes(id), `command ${id} is not registered`);
      }
    },
  },
  {
    name: 'exposes the documented settings with their defaults',
    run: () => {
      const config = vscode.workspace.getConfiguration('commitcraft');
      assert.strictEqual(config.get('style'), 'conventional');
      assert.strictEqual(config.get('maxSubjectLength'), 72);
      assert.strictEqual(config.get('baseBranch'), 'main');
      assert.strictEqual(config.get('provider'), 'anthropic');
      assert.strictEqual(config.get('model'), '', 'an empty model means the default of the chosen provider');
      return Promise.resolve();
    },
  },
  {
    name: 'the Git extension API finds the workspace repository and exposes the git binary path',
    run: async () => {
      const { repo, gitPath } = await realRepository();
      assert.strictEqual(realpathSync(repo.rootUri.fsPath), workspaceRoot());
      assert.ok(gitPath.length > 0, 'api.git.path is empty');
      assert.strictEqual(repo.state.HEAD?.name, 'main');
      assert.ok(repo.state.HEAD?.commit, 'HEAD has no commit');
    },
  },
  {
    name: 'getStagedDiff returns the staged text diff and ignores unstaged changes',
    run: async () => {
      const { gitPath } = await realRepository();
      const runGit = createRunGit(gitPath, workspaceRoot());
      assert.strictEqual((await getStagedDiff(runGit)).trim(), '', 'expected nothing staged yet');

      write('hello.ts', "export const hello = 'world';\n");
      write('unstaged.ts', 'export const notStaged = true;\n');
      git('add', 'hello.ts');
      const diff = await getStagedDiff(runGit);
      assert.match(diff, /^diff --git a\/hello\.ts b\/hello\.ts$/m);
      assert.match(diff, /^\+export const hello = 'world';$/m);
      assert.doesNotMatch(diff, /unstaged\.ts/);
    },
  },
  {
    name: 'the staged diff ignores hostile user git config (external diff tool, colour, mnemonic prefixes, submodule log)',
    run: async () => {
      git('config', 'diff.external', 'false'); // the `false` program: an external diff tool that prints nothing
      git('config', 'color.ui', 'always');
      git('config', 'diff.mnemonicPrefix', 'true');
      git('config', 'diff.submodule', 'log');
      try {
        const { gitPath } = await realRepository();
        const diff = await getStagedDiff(createRunGit(gitPath, workspaceRoot()));
        assert.match(diff, /^diff --git a\/hello\.ts b\/hello\.ts$/m, 'the staged diff was not readable text');
        assert.match(diff, /^\+export const hello = 'world';$/m);
        assert.ok(!diff.includes('\u001b['), 'colour escape codes leaked into the diff');
        assert.strictEqual(parseDiff(diff).length, 1, 'the parser should find exactly one file');
      } finally {
        for (const key of ['diff.external', 'color.ui', 'diff.mnemonicPrefix', 'diff.submodule']) {
          git('config', '--unset', key);
        }
      }
    },
  },
  {
    name: 'the whole pipeline works on the real staged diff (fake AI provider)',
    run: async () => {
      const { gitPath } = await realRepository();
      const prompts: BuiltPrompt[] = [];
      const provider: AiProvider = {
        generate: (prompt) => {
          prompts.push(prompt);
          return Promise.resolve('feat: add hello constant');
        },
      };
      const result = await generateCommitMessage({
        rawDiff: await getStagedDiff(createRunGit(gitPath, workspaceRoot())),
        apiKey: 'integration-test-key',
        provider,
        settings: DEFAULT_SETTINGS,
      });
      assert.strictEqual(result.text, 'feat: add hello constant');
      assert.strictEqual(result.stats.files, 1);
      assert.match(prompts[0]?.user ?? '', /hello\.ts/);
    },
  },
  {
    name: 'the commit message box can be written and read back',
    run: async () => {
      const { repo } = await realRepository();
      repo.inputBox.value = 'feat: from CommitCraft';
      assert.strictEqual(repo.inputBox.value, 'feat: from CommitCraft');
      repo.inputBox.value = '';
    },
  },
  {
    name: 'getBranchChanges reads commits and the diff since the merge base with the real git binary',
    run: async () => {
      git('commit', '-q', '-m', 'chore: add hello');
      git('checkout', '-q', '-b', 'feature/greeting');
      write('greeting.ts', "export const greeting = 'hi';\n");
      git('add', 'greeting.ts');
      git('commit', '-q', '-m', 'feat: add greeting');
      write('greeting.ts', "export const greeting = 'hello there';\n");
      git('commit', '-q', '-a', '-m', 'fix: friendlier greeting');
      write('uncommitted.ts', 'export const later = 1;\n'); // must not appear
      const { repo, gitPath } = await realRepository();

      const changes = await getBranchChanges(repo, 'main', createRunGit(gitPath, workspaceRoot()));
      assert.strictEqual(changes.branchName, 'feature/greeting');
      assert.strictEqual(changes.baseRef, 'main');
      assert.deepStrictEqual(changes.commitSubjects, ['feat: add greeting', 'fix: friendlier greeting']);
      assert.strictEqual(changes.totalCommits, 2);
      assert.match(changes.rawDiff, /^diff --git a\/greeting\.ts b\/greeting\.ts$/m);
      assert.match(changes.rawDiff, /^\+export const greeting = 'hello there';$/m);
      assert.doesNotMatch(changes.rawDiff, /uncommitted\.ts/);
      assert.doesNotMatch(changes.rawDiff, /hello\.ts/, 'commits already on main must not be included');
    },
  },
  {
    name: 'the branch diff ignores the user git config (external diff tools, prefixes, colour)',
    run: async () => {
      git('config', 'diff.noprefix', 'true');
      git('config', 'diff.mnemonicPrefix', 'true');
      git('config', 'color.ui', 'always');
      try {
        const { repo, gitPath } = await realRepository();
        const changes = await getBranchChanges(repo, 'main', createRunGit(gitPath, workspaceRoot()));
        assert.match(changes.rawDiff, /^diff --git a\/greeting\.ts b\/greeting\.ts$/m);
        assert.ok(!changes.rawDiff.includes('\u001b['), 'colour escape codes leaked into the diff');
      } finally {
        git('config', '--unset', 'diff.noprefix');
        git('config', '--unset', 'diff.mnemonicPrefix');
        git('config', '--unset', 'color.ui');
      }
    },
  },
  {
    name: 'getBranchChanges reports a missing base branch',
    run: async () => {
      const { repo, gitPath } = await realRepository();
      assert.strictEqual(
        await codeOf(getBranchChanges(repo, 'does-not-exist', createRunGit(gitPath, workspaceRoot()))),
        'BASE_BRANCH_NOT_FOUND',
      );
    },
  },
  {
    name: 'getBranchChanges refuses a base branch that looks like a git option',
    run: async () => {
      const { repo, gitPath } = await realRepository();
      assert.strictEqual(
        await codeOf(getBranchChanges(repo, '--output=/tmp/commitcraft-pwned', createRunGit(gitPath, workspaceRoot()))),
        'INVALID_SETTING',
      );
    },
  },
  {
    name: 'createRunGit reports a cancelled signal as CANCELLED',
    run: async () => {
      const { gitPath } = await realRepository();
      const controller = new AbortController();
      controller.abort();
      assert.strictEqual(await codeOf(createRunGit(gitPath, workspaceRoot(), controller.signal)(['status'])), 'CANCELLED');
    },
  },
  {
    name: 'getBranchChanges reports being on the base branch',
    run: async () => {
      git('stash', '-q', '--include-untracked');
      git('checkout', '-q', 'main');
      const { repo, gitPath } = await realRepository();
      assert.strictEqual(await codeOf(getBranchChanges(repo, 'main', createRunGit(gitPath, workspaceRoot()))), 'ON_BASE_BRANCH');
    },
  },
  {
    name: 'getBranchChanges reports a branch with nothing ahead of base',
    run: async () => {
      git('checkout', '-q', '-b', 'feature/empty');
      const { repo, gitPath } = await realRepository();
      assert.strictEqual(await codeOf(getBranchChanges(repo, 'main', createRunGit(gitPath, workspaceRoot()))), 'NO_BRANCH_CHANGES');
    },
  },
  {
    name: 'getBranchChanges reports a detached HEAD',
    run: async () => {
      git('checkout', '-q', '--detach');
      const { repo, gitPath } = await realRepository();
      assert.strictEqual(await codeOf(getBranchChanges(repo, 'main', createRunGit(gitPath, workspaceRoot()))), 'DETACHED_HEAD');
    },
  },
];

export async function run(): Promise<void> {
  let failures = 0;
  for (const test of tests) {
    try {
      await test.run();
      process.stdout.write(`  ok   ${test.name}\n`);
    } catch (error) {
      failures++;
      process.stdout.write(`  FAIL ${test.name}\n       ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (failures > 0) {
    throw new Error(`${failures} integration test(s) failed`);
  }
}
