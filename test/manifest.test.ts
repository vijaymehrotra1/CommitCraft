import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, DEFAULT_SETTINGS, MAX_SUBJECT_LENGTH, MIN_SUBJECT_LENGTH, PROVIDER_NAMES } from '../src/core/settings';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

interface Manifest {
  engines: { vscode: string };
  extensionDependencies: string[];
  activationEvents: string[];
  main: string;
  icon?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  capabilities: { untrustedWorkspaces: { supported: unknown; description?: string; restrictedConfigurations?: string[] }; virtualWorkspaces: { supported: unknown } };
  contributes: {
    commands: Array<{ command: string; title: string; category: string; icon?: string }>;
    menus: { 'scm/title': Array<{ command: string; when: string; group: string }> };
    configuration: { properties: Record<string, { type: string; default: unknown; enum?: string[]; minimum?: number; maximum?: number; scope?: string; markdownDescription?: string }> };
  };
}

const manifest = JSON.parse(read('package.json')) as Manifest;
const commandsSource = read('src/vscode/commands.ts');

describe('package.json manifest', () => {
  it('contributes exactly the three commands from the requirements, each registered in code', () => {
    const ids = manifest.contributes.commands.map((c) => c.command).sort();
    expect(ids).toEqual(['commitcraft.generateCommitMessage', 'commitcraft.generatePrDescription', 'commitcraft.setApiKey']);
    for (const id of ids) {
      expect(commandsSource).toContain(`'${id}'`);
    }
  });

  it('shows as "CommitCraft: <title>" in the Command Palette', () => {
    expect(manifest.contributes.commands.map((c) => `${c.category}: ${c.title}`).sort()).toEqual([
      'CommitCraft: Generate Commit Message',
      'CommitCraft: Generate PR Description',
      'CommitCraft: Set API Key',
    ]);
  });

  it('puts the Generate Commit Message button in the Source Control title bar for Git', () => {
    expect(manifest.contributes.menus['scm/title']).toEqual([
      { command: 'commitcraft.generateCommitMessage', when: 'scmProvider == git', group: 'navigation' },
    ]);
    expect(manifest.contributes.commands.find((c) => c.command === 'commitcraft.generateCommitMessage')?.icon).toBeTruthy();
  });

  it('declares the settings with defaults that match the code', () => {
    const properties = manifest.contributes.configuration.properties;
    expect(Object.keys(properties).sort()).toEqual([
      'commitcraft.baseBranch',
      'commitcraft.maxSubjectLength',
      'commitcraft.model',
      'commitcraft.provider',
      'commitcraft.style',
    ]);
    expect(properties['commitcraft.provider']?.default).toBe(DEFAULT_SETTINGS.provider);
    expect(properties['commitcraft.provider']?.enum).toEqual([...PROVIDER_NAMES]);
    expect(properties['commitcraft.style']?.default).toBe(DEFAULT_SETTINGS.style);
    expect(properties['commitcraft.style']?.enum).toEqual(['conventional', 'plain']);
    expect(properties['commitcraft.maxSubjectLength']?.default).toBe(DEFAULT_SETTINGS.maxSubjectLength);
    expect(properties['commitcraft.maxSubjectLength']?.minimum).toBe(MIN_SUBJECT_LENGTH);
    expect(properties['commitcraft.maxSubjectLength']?.maximum).toBe(MAX_SUBJECT_LENGTH);
    expect(properties['commitcraft.baseBranch']?.default).toBe(DEFAULT_SETTINGS.baseBranch);
  });

  it('model defaults to empty, meaning "the default of the chosen provider", and says what those are', () => {
    const model = manifest.contributes.configuration.properties['commitcraft.model'];
    expect(model?.default).toBe('');
    for (const name of Object.values(DEFAULT_MODELS)) {
      expect(model?.markdownDescription).toContain(name);
    }
  });

  it('warns in the provider setting that diffs go to that vendor and about the Gemini free tier', () => {
    const provider = manifest.contributes.configuration.properties['commitcraft.provider'];
    expect(provider?.markdownDescription).toMatch(/sent to/i);
    expect(provider?.markdownDescription).toMatch(/free tier/i);
  });

  it('never stores the API key in settings', () => {
    const settingNames = Object.keys(manifest.contributes.configuration.properties).join(' ').toLowerCase();
    expect(settingNames).not.toMatch(/key|token|secret|password/);
  });

  it('depends on the built-in Git extension', () => {
    expect(manifest.extensionDependencies).toContain('vscode.git');
  });

  it('is disabled in Restricted Mode, matching the Git extension it depends on (which is disabled there)', () => {
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(false);
    expect(manifest.capabilities.untrustedWorkspaces.description).toMatch(/Git extension/);
    expect(manifest.capabilities.virtualWorkspaces.supported).toBe(false);
  });

  it('requires VS Code 1.90+ and pins @types/vscode to match (vsce rejects a newer one)', () => {
    expect(manifest.engines.vscode).toBe('^1.90.0');
    expect(manifest.devDependencies['@types/vscode']).toBe('1.90.0');
  });

  it('ships a single bundled file', () => {
    expect(manifest.main).toBe('./dist/extension.js');
  });

  it('has a real PNG icon of at least 128x128 (the Marketplace and vsce require it)', () => {
    expect(manifest.icon).toBe('media/icon.png');
    const png = readFileSync(join(root, 'media', 'icon.png'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
  });

  it('has exactly one runtime dependency: the Anthropic SDK', () => {
    expect(Object.keys(manifest.dependencies)).toEqual(['@anthropic-ai/sdk']);
  });

  it('has no telemetry dependency', () => {
    const all = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).join(' ');
    expect(all).not.toMatch(/telemetry|applicationinsights|sentry|segment|mixpanel|posthog|amplitude/i);
  });
});

describe('.vscodeignore', () => {
  const lines = read('.vscodeignore').split('\n').map((l) => l.trim()).filter(Boolean);

  it('excludes everything by default and allow-lists only what ships', () => {
    expect(lines[0]).toBe('**');
    expect(lines.slice(1).sort()).toEqual([
      '!CHANGELOG.md',
      '!LICENSE',
      '!README.md',
      '!dist/extension.js',
      '!media/icon.png',
      '!package.json',
    ]);
  });
});
