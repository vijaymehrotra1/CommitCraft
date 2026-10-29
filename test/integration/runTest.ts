// Launches a real VS Code with the extension loaded and runs ./suite/index.ts inside it.
// Usage: npm run test:integration   (needs to download VS Code once; on Linux without a display, wrap with xvfb-run)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

/** A repository with one commit on `main`, so the Git extension finds it at startup. */
function createWorkspaceRepository(workspace: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'integration@example.invalid');
  git('config', 'user.name', 'Integration Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(workspace, 'README.md'), '# Integration workspace\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: initial commit');
}

async function main(): Promise<void> {
  // When this runs from a terminal inside VS Code, ELECTRON_RUN_AS_NODE=1 is inherited and would make
  // the downloaded VS Code behave as plain Node ("Cannot find module '<workspace>'"). Clear it for the child.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = mkdtempSync(join(tmpdir(), 'commitcraft-it-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  createWorkspaceRepository(workspace);
  await runTests({
    extensionDevelopmentPath: resolve(__dirname, '..', '..'),
    extensionTestsPath: resolve(__dirname, 'suite', 'index'),
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    launchArgs: [
      workspace,
      '--disable-workspace-trust',
      '--disable-gpu',
      `--user-data-dir=${join(root, 'user-data')}`,
      `--extensions-dir=${join(root, 'extensions')}`,
    ],
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`Integration tests failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
