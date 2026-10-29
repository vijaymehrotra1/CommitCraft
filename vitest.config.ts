import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // The real 'vscode' module only exists inside VS Code. Unit tests use a controllable fake.
    alias: { vscode: join(root, 'test', 'mocks', 'vscode.ts') },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/core/types.ts', 'src/vscode/gitTypes.ts'],
      reporter: ['text', 'html'],
    },
  },
});
