// Manual end-to-end check against a REAL AI service, using the same code the extension runs.
// Anthropic costs a few cents; Gemini's free tier costs nothing. Usage:
//   ANTHROPIC_API_KEY=sk-ant-... npm run check:live
//   COMMITCRAFT_PROVIDER=gemini GEMINI_API_KEY=... npm run check:live
//   COMMITCRAFT_MODEL=gemini-3.8-flash COMMITCRAFT_PROVIDER=gemini GEMINI_API_KEY=... npm run check:live
//
// This script is the ONLY place CommitCraft reads these key variables (the extension itself never does:
// it uses VS Code SecretStorage). The key is passed straight to the provider and never printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCommitCraftError } from '../src/core/errors';
import { generateCommitMessage, generatePrDescription } from '../src/core/pipeline';
import { DEFAULT_MODELS, DEFAULT_SETTINGS, PROVIDER_LABELS, normalizeSettings } from '../src/core/settings';
import type { AiProvider, ProviderName } from '../src/core/types';
import { createAnthropicProvider } from '../src/providers/anthropic';
import { createGeminiProvider } from '../src/providers/gemini';
import { fillFakeSecrets } from '../test/helpers/fakeSecrets';

const out = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};

const fixture = (name: string): string =>
  fillFakeSecrets(readFileSync(join(process.cwd(), 'test', 'fixtures', `${name}.diff`), 'utf8'));

const KEY_VARIABLES: Record<ProviderName, string> = { anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };
const PROVIDERS: Record<ProviderName, () => AiProvider> = { anthropic: createAnthropicProvider, gemini: createGeminiProvider };

async function main(): Promise<number> {
  const chosen = normalizeSettings({ provider: process.env.COMMITCRAFT_PROVIDER, model: process.env.COMMITCRAFT_MODEL });
  const apiKey = process.env[KEY_VARIABLES[chosen.provider]];
  if (!apiKey) {
    process.stderr.write(
      `Set ${KEY_VARIABLES[chosen.provider]} to run the live check for ${PROVIDER_LABELS[chosen.provider]}, e.g.\n` +
        `  ${chosen.provider === 'gemini' ? 'COMMITCRAFT_PROVIDER=gemini ' : ''}${KEY_VARIABLES[chosen.provider]}=... npm run check:live\n`,
    );
    return 2;
  }
  const settings = { ...DEFAULT_SETTINGS, provider: chosen.provider, model: chosen.model };
  const provider = PROVIDERS[chosen.provider]();
  out(`Provider: ${PROVIDER_LABELS[settings.provider]}   Model: ${settings.model || DEFAULT_MODELS[settings.provider]}   Style: ${settings.style}\n`);

  const steps: Array<[string, () => Promise<{ text: string; notices: string[]; redactions: number }>]> = [
    ['Commit message for a mixed commit (feature + test + lockfile + image + rename)', () =>
      generateCommitMessage({ rawDiff: fixture('mixed-commit'), apiKey, provider, settings })],
    ['Commit message for a diff containing FAKE secrets and .env/.pem files (must be masked, never sent)', () =>
      generateCommitMessage({ rawDiff: fixture('secrets'), apiKey, provider, settings })],
    ['PR description for the same mixed change', () =>
      generatePrDescription({
        rawDiff: fixture('mixed-commit'),
        branchName: 'feature/password-hashing',
        commitSubjects: ['feat: add password hashing', 'test: cover hashPassword', 'chore(deps): add vitest'],
        apiKey,
        provider,
        settings,
      })],
  ];

  let failed = 0;
  for (const [label, run] of steps) {
    out(`=== ${label}`);
    try {
      const started = Date.now();
      const result = await run();
      out(result.text);
      out(`\n(${((Date.now() - started) / 1000).toFixed(1)}s, ${result.redactions} masked${result.notices.length ? `; notices: ${result.notices.join(' ')}` : ''})\n`);
    } catch (error) {
      failed++;
      out(isCommitCraftError(error) ? `FAILED [${error.code}] ${error.message}\n` : 'FAILED (unexpected error)\n');
    }
  }
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);
