import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODELS,
  DEFAULT_SETTINGS,
  PROVIDER_LABELS,
  PROVIDER_NAMES,
  normalizeSettings,
  validateApiKeyInput,
} from '../../src/core/settings';
import { FAKE } from '../helpers/fakeSecrets';

describe('validateApiKeyInput', () => {
  it('accepts a plausible key, with surrounding whitespace from a paste', () => {
    expect(validateApiKeyInput(FAKE.anthropicKey)).toBeUndefined();
    expect(validateApiKeyInput(`  ${FAKE.anthropicKey}\n`)).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too short', 'FAKE-short'],
    ['containing a space', `${FAKE.anthropicKey.slice(0, 20)} ${FAKE.anthropicKey.slice(20)}`],
    ['containing a line break', `${FAKE.anthropicKey.slice(0, 20)}\n${FAKE.anthropicKey.slice(20)}`],
  ])('rejects a key that is %s, with a message', (_label, value) => {
    expect(validateApiKeyInput(value)).toEqual(expect.any(String));
  });

  it.each([
    ['a curly quote at the end', `${FAKE.anthropicKey}\u2019`],
    ['an en dash instead of a hyphen', FAKE.anthropicKey.replace('-', '\u2013')],
    ['a zero-width space', `${FAKE.anthropicKey.slice(0, 12)}\u200b${FAKE.anthropicKey.slice(12)}`],
    ['an accented letter', `${FAKE.anthropicKey}é`],
  ])('rejects a key with %s (it would crash the HTTP header later)', (_label, value) => {
    expect(validateApiKeyInput(value)).toMatch(/plain letters, digits/);
  });

  it('does not echo the value back in the message', () => {
    expect(validateApiKeyInput('secret value with spaces in it here')).not.toContain('secret value');
  });
});

describe('providers and their default models', () => {
  it('knows exactly the two providers, each with a label and a default model', () => {
    expect([...PROVIDER_NAMES]).toEqual(['anthropic', 'gemini']);
    expect(DEFAULT_MODELS).toEqual({ anthropic: 'claude-opus-5-5', gemini: 'gemini-3.5-flash-lite' });
    expect(PROVIDER_LABELS).toEqual({ anthropic: 'Anthropic Claude', gemini: 'Google Gemini' });
  });

  it.each([
    ['anthropic', 'claude-opus-5-5'],
    ['gemini', 'gemini-3.5-flash-lite'],
  ] as const)('an empty model setting means the default of the chosen provider (%s -> %s)', (provider, model) => {
    expect(normalizeSettings({ provider, model: '' })).toMatchObject({ provider, model });
    expect(normalizeSettings({ provider })).toMatchObject({ provider, model });
    expect(normalizeSettings({ provider, model: '   ' })).toMatchObject({ provider, model });
  });

  it('an explicit model always wins, for either provider', () => {
    expect(normalizeSettings({ provider: 'gemini', model: 'gemini-3.8-flash' }).model).toBe('gemini-3.8-flash');
    expect(normalizeSettings({ provider: 'anthropic', model: 'claude-haiku-5-5' }).model).toBe('claude-haiku-5-5');
  });

  it.each(['Gemini', 'GEMINI', ' gemini '])('accepts the provider %j regardless of case or spaces', (provider) => {
    expect(normalizeSettings({ provider }).provider).toBe('gemini');
  });

  it.each([['openai'], [''], [42], [null], [undefined], [{}]])('falls back to anthropic for the unknown provider %j', (provider) => {
    expect(normalizeSettings({ provider }).provider).toBe('anthropic');
    expect(normalizeSettings({ provider }).model).toBe('claude-opus-5-5');
  });
});

describe('normalizeSettings', () => {
  it('returns the defaults for empty input', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults match the requirements', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      provider: 'anthropic',
      style: 'conventional',
      maxSubjectLength: 72,
      baseBranch: 'main',
      model: 'claude-opus-5-5',
    });
  });

  it('accepts valid values', () => {
    expect(normalizeSettings({ style: 'plain', maxSubjectLength: 50, baseBranch: 'develop', model: 'claude-haiku-5-5' })).toEqual({
      provider: 'anthropic',
      style: 'plain',
      maxSubjectLength: 50,
      baseBranch: 'develop',
      model: 'claude-haiku-5-5',
    });
  });

  it.each(['Plain', 'PLAIN', ' plain '])('accepts the style %j regardless of case or spaces', (style) => {
    expect(normalizeSettings({ style }).style).toBe('plain');
  });

  it.each([
    ['an unknown style', { style: 'fancy' }],
    ['a non-string style', { style: 42 }],
    ['a null style', { style: null }],
  ])('falls back to conventional for %s', (_label, raw) => {
    expect(normalizeSettings(raw).style).toBe('conventional');
  });

  it.each([
    [5, 20],
    [19.4, 20],
    [500, 120],
    [72.6, 73],
    [50, 50],
  ])('clamps and rounds maxSubjectLength %s to %s', (input, expected) => {
    expect(normalizeSettings({ maxSubjectLength: input }).maxSubjectLength).toBe(expected);
  });

  it.each([['72'], [Number.NaN], [Number.POSITIVE_INFINITY], [null], [undefined], [{}]])(
    'falls back to 72 for a non-numeric maxSubjectLength %j',
    (input) => {
      expect(normalizeSettings({ maxSubjectLength: input }).maxSubjectLength).toBe(72);
    },
  );

  it('trims strings and falls back for blank or non-string branch and model', () => {
    expect(normalizeSettings({ baseBranch: '  develop  ', model: '  m  ' })).toMatchObject({ baseBranch: 'develop', model: 'm' });
    expect(normalizeSettings({ baseBranch: '   ', model: '' })).toMatchObject({ baseBranch: 'main', model: 'claude-opus-5-5' });
    expect(normalizeSettings({ baseBranch: 7, model: null })).toMatchObject({ baseBranch: 'main', model: 'claude-opus-5-5' });
  });
});
