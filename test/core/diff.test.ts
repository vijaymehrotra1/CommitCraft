import { describe, expect, it } from 'vitest';
import {
  diffNotices,
  isLockFile,
  parseDiff,
  processDiff,
  renderDiff,
  truncateText,
  unquoteGitPath,
} from '../../src/core/diff';
import { loadFixture, makeHugeDiff } from '../helpers/fixtures';

const roundTrip = (raw: string): string => parseDiff(raw).map((f) => f.text).join('\n') + '\n';

describe('parseDiff', () => {
  it('returns no files for empty or whitespace-only input', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('\n\n  \n')).toEqual([]);
    expect(parseDiff(loadFixture('empty'))).toEqual([]);
  });

  it('returns no files when the text is not a diff', () => {
    expect(parseDiff('hello world\nthis is not a diff\n')).toEqual([]);
  });

  it('parses a normal edit with two hunks', () => {
    const [file, ...rest] = parseDiff(loadFixture('normal-edit'));
    expect(rest).toEqual([]);
    expect(file).toMatchObject({
      path: 'src/auth/session.ts',
      oldPath: 'src/auth/session.ts',
      status: 'modified',
      binary: false,
      modeChangeOnly: false,
      additions: 3,
      deletions: 3,
    });
    expect(file?.text.match(/^@@ /gm)).toHaveLength(2);
  });

  it('parses a new file', () => {
    const [file] = parseDiff(loadFixture('new-file'));
    expect(file).toMatchObject({
      path: 'src/auth/password.ts',
      status: 'added',
      binary: false,
      additions: 10,
      deletions: 0,
    });
  });

  it('parses a deleted file and reports its old path', () => {
    const [file] = parseDiff(loadFixture('deleted-file'));
    expect(file).toMatchObject({
      path: 'src/legacy/helper.ts',
      oldPath: 'src/legacy/helper.ts',
      status: 'deleted',
      additions: 0,
      deletions: 4,
    });
  });

  it('parses a rename with edits and a pure rename', () => {
    const files = parseDiff(loadFixture('renamed-file'));
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      path: 'docs/setup-guide.md',
      oldPath: 'docs/old-guide.md',
      status: 'renamed',
      additions: 1,
      deletions: 1,
    });
    expect(files[1]).toMatchObject({
      path: 'src/utils/duration.ts',
      oldPath: 'src/utils/format.ts',
      status: 'renamed',
      additions: 0,
      deletions: 0,
      binary: false,
    });
  });

  it('flags binary files, both added and modified', () => {
    const files = parseDiff(loadFixture('binary-file'));
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['assets/banner.png', 'added', true],
      ['assets/logo.png', 'modified', true],
    ]);
    expect(files.every((f) => f.additions === 0 && f.deletions === 0)).toBe(true);
  });

  it('recognises git binary patches', () => {
    const raw = [
      'diff --git a/data.bin b/data.bin',
      'new file mode 100644',
      'index 0000000..abcdef0',
      'GIT binary patch',
      'literal 12',
      'Tcmeyrbu=6JK~KMr;2H;0Rj',
      '',
    ].join('\n');
    expect(parseDiff(raw)).toMatchObject([{ path: 'data.bin', binary: true, status: 'added' }]);
  });

  it('parses a lock-file edit like any modified file', () => {
    const [file] = parseDiff(loadFixture('lock-file'));
    expect(file).toMatchObject({ path: 'package-lock.json', status: 'modified', binary: false });
    expect(file!.additions).toBeGreaterThan(0);
  });

  it('detects a mode-only change', () => {
    const [file] = parseDiff(loadFixture('mode-change'));
    expect(file).toMatchObject({
      path: 'scripts/build.sh',
      status: 'modified',
      modeChangeOnly: true,
      additions: 0,
      deletions: 0,
    });
  });

  it('handles paths with spaces (git adds a trailing tab) and quoted unicode paths', () => {
    const files = parseDiff(loadFixture('special-paths'));
    expect(files.map((f) => f.path)).toEqual(['docs/my notes/todo list.md', 'docs/résumé/café.md']);
    expect(files.every((f) => f.status === 'added')).toBe(true);
  });

  it('preserves CRLF line endings inside the diff text', () => {
    const [file] = parseDiff(loadFixture('crlf-edit'));
    expect(file).toMatchObject({ path: 'config/windows.ini', additions: 2, deletions: 1 });
    expect(file!.text).toContain('+port=8080\r\n');
  });

  it('parses a realistic mixed commit in order', () => {
    const files = parseDiff(loadFixture('mixed-commit'));
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['assets/favicon.png', 'added'],
      ['package-lock.json', 'modified'],
      ['package.json', 'modified'],
      ['src/auth/password.ts', 'added'],
      ['src/utils/duration.ts', 'renamed'],
      ['test/password.test.ts', 'added'],
    ]);
  });

  it.each([
    'normal-edit',
    'new-file',
    'deleted-file',
    'renamed-file',
    'binary-file',
    'lock-file',
    'mode-change',
    'special-paths',
    'crlf-edit',
    'mixed-commit',
    'secrets',
  ])('loses no text: sections of %s re-join to the original diff', (name) => {
    const raw = loadFixture(name);
    expect(roundTrip(raw)).toBe(raw);
  });

  it('does not throw on a diff cut off mid-file', () => {
    const raw = loadFixture('mixed-commit');
    const cut = raw.slice(0, Math.floor(raw.length / 2));
    expect(() => parseDiff(cut)).not.toThrow();
    expect(parseDiff(cut).length).toBeGreaterThan(0);
  });

  it('parses combined (merge) diffs without throwing', () => {
    const raw = [
      'diff --cc src/merge.ts',
      'index 1111111,2222222..3333333',
      '--- a/src/merge.ts',
      '+++ b/src/merge.ts',
      '@@@ -1,3 -1,3 +1,4 @@@',
      '  line',
      '++added in both',
      '',
    ].join('\n');
    expect(parseDiff(raw)).toMatchObject([{ path: 'src/merge.ts', status: 'modified' }]);
  });
});

describe('unquoteGitPath', () => {
  it('leaves unquoted paths alone', () => {
    expect(unquoteGitPath('src/a.ts')).toBe('src/a.ts');
  });

  it('keeps characters outside the Basic Multilingual Plane (emoji) intact', () => {
    expect(unquoteGitPath('"we\\"ird-😀.txt"')).toBe('we"ird-😀.txt');
    expect(unquoteGitPath('"docs/😀 notes/𝒳.md"')).toBe('docs/😀 notes/𝒳.md');
    expect(unquoteGitPath('"\\360\\237\\230\\200.txt"')).toBe('😀.txt');
  });

  it('decodes octal UTF-8 escapes and C escapes', () => {
    expect(unquoteGitPath('"docs/r\\303\\251sum\\303\\251.md"')).toBe('docs/résumé.md');
    expect(unquoteGitPath('"a\\tb\\"c\\\\d"')).toBe('a\tb"c\\d');
  });
});

describe('isLockFile', () => {
  it.each([
    'package-lock.json',
    'frontend/package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'poetry.lock',
    'Gemfile.lock',
    'composer.lock',
    'go.sum',
    'bun.lockb',
    'infra/.terraform.lock.hcl',
    'apps\\web\\yarn.lock',
  ])('treats %s as a lock file', (path) => {
    expect(isLockFile(path)).toBe(true);
  });

  it.each(['package.json', 'src/lock.ts', 'docs/lockfile-guide.md', 'src/block.json', 'go.mod', 'locksmith.ts'])(
    'does not treat %s as a lock file',
    (path) => {
      expect(isLockFile(path)).toBe(false);
    },
  );
});

describe('truncateText', () => {
  const lines = (n: number): string =>
    Array.from({ length: n }, (_, i) => `+line number ${i}`).join('\n');

  it('returns text unchanged when it fits', () => {
    expect(truncateText('short', 100)).toEqual({ text: 'short', truncated: false, omittedLines: 0 });
  });

  it('cuts at a line boundary, never exceeds the limit, and says how many lines were dropped', () => {
    const text = lines(500);
    const result = truncateText(text, 400);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(400);
    expect(result.text).toMatch(/\[\.\.\. \d+ more lines truncated by CommitCraft \.\.\.\]$/);
    const kept = result.text.split('\n').filter((l) => l.startsWith('+line number')).length;
    expect(kept + result.omittedLines).toBe(500);
    expect(result.text).not.toMatch(/\+line numbe$/m);
  });

  it('hard-cuts a single enormous line (e.g. minified code)', () => {
    const text = `+${'x'.repeat(10_000)}\n+second line`;
    const result = truncateText(text, 500);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(500);
  });

  it('keeps CRLF content intact up to the cut', () => {
    const text = Array.from({ length: 200 }, (_, i) => `+row ${i}\r`).join('\n');
    const result = truncateText(text, 300);
    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(result.text.startsWith('+row 0\r\n+row 1\r')).toBe(true);
  });
});

describe('processDiff', () => {
  const base = { maxChars: 100_000 };

  it('returns an empty result for an empty diff', () => {
    const result = processDiff('', base);
    expect(result.included).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.omitted).toEqual([]);
    expect(result.stats).toMatchObject({ files: 0, additions: 0, deletions: 0, truncated: false });
  });

  it('skips binary and lock files (names only) and keeps the rest', () => {
    const result = processDiff(loadFixture('mixed-commit'), base);
    expect(result.included.map((f) => f.file.path)).toEqual([
      'package.json',
      'src/auth/password.ts',
      'src/utils/duration.ts',
      'test/password.test.ts',
    ]);
    expect(result.skipped.map((s) => [s.path, s.reason])).toEqual([
      ['assets/favicon.png', 'binary file'],
      ['package-lock.json', 'lock file'],
    ]);
    const sent = renderDiff(result);
    expect(sent).not.toContain('FAKEINTEGRITY');
    expect(sent).not.toContain('pkg-0');
  });

  it('skips sensitive paths using the supplied predicate and never includes their content', () => {
    const result = processDiff(loadFixture('secrets'), {
      ...base,
      isSensitivePath: (p) => p === '.env' || p.endsWith('.pem') || p.endsWith('id_rsa'),
    });
    expect(result.skipped.map((s) => [s.path, s.reason])).toEqual([
      ['.env', 'sensitive file'],
      ['certs/server.pem', 'sensitive file'],
      ['deploy/id_rsa', 'sensitive file'],
    ]);
    const sent = renderDiff(result);
    expect(sent).not.toContain('SESSION_SECRET');
    expect(sent).not.toContain('certs/server.pem b/');
  });

  it('counts additions and deletions across ALL files, including skipped ones', () => {
    const result = processDiff(loadFixture('mixed-commit'), base);
    const all = parseDiff(loadFixture('mixed-commit'));
    expect(result.stats.files).toBe(all.length);
    expect(result.stats.additions).toBe(all.reduce((n, f) => n + f.additions, 0));
    expect(result.stats.deletions).toBe(all.reduce((n, f) => n + f.deletions, 0));
  });

  it('does not truncate when the diff fits', () => {
    const result = processDiff(loadFixture('normal-edit'), base);
    expect(result.stats.truncated).toBe(false);
    expect(result.included.every((f) => !f.truncated)).toBe(true);
    expect(result.stats.sentChars).toBe(result.included.reduce((n, f) => n + f.text.length, 0));
  });

  it('truncates a huge diff per file, keeps every file visible, and stays under the limit', () => {
    const raw = makeHugeDiff(30, 200);
    expect(raw.length).toBeGreaterThan(400_000);
    const result = processDiff(raw, { maxChars: 20_000 });
    expect(result.stats.truncated).toBe(true);
    expect(result.included).toHaveLength(30);
    expect(result.omitted).toEqual([]);
    expect(result.included.every((f) => f.truncated)).toBe(true);
    expect(result.included.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(20_000);
    expect(result.included.every((f) => f.text.includes('truncated by CommitCraft'))).toBe(true);
    expect(result.included.every((f) => f.text.startsWith('diff --git '))).toBe(true);
  });

  it('shares the budget fairly: small files stay whole, the giant file absorbs the cut', () => {
    const small = loadFixture('new-file');
    const huge = makeHugeDiff(1, 2000);
    const result = processDiff(small + huge, { maxChars: 8_000 });
    const byPath = new Map(result.included.map((f) => [f.file.path, f]));
    expect(byPath.get('src/auth/password.ts')?.truncated).toBe(false);
    expect(byPath.get('src/generated/file0.ts')?.truncated).toBe(true);
  });

  it('omits the least significant files entirely when there are too many to show', () => {
    const raw = makeHugeDiff(100, 50);
    const result = processDiff(raw, { maxChars: 5_000 });
    expect(result.included.length).toBeLessThan(100);
    expect(result.omitted.length + result.included.length).toBe(100);
    expect(result.included.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(5_000);
    expect(result.stats.truncated).toBe(true);
  });

  it('applies redactText to every included file BEFORE truncating', () => {
    const body = Array.from({ length: 300 }, (_, i) => `+SECRET-LINE-${i}`).join('\n');
    const raw = [
      'diff --git a/src/key.ts b/src/key.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/key.ts',
      '@@ -0,0 +1,302 @@',
      '+SECRET-BEGIN',
      body,
      '+SECRET-END',
      '',
    ].join('\n');
    const result = processDiff(raw, {
      maxChars: 600,
      redactText: (text) => text.replace(/SECRET-BEGIN[\s\S]*?SECRET-END/g, '[REDACTED]'),
    });
    const sent = renderDiff(result);
    expect(sent).not.toContain('SECRET-LINE');
    expect(sent).toContain('[REDACTED]');
  });

  it('does not run redactText on skipped files', () => {
    const seen: string[] = [];
    processDiff(loadFixture('mixed-commit'), {
      ...base,
      redactText: (text) => {
        seen.push(text);
        return text;
      },
    });
    expect(seen).toHaveLength(4);
    expect(seen.join('\n')).not.toContain('FAKEINTEGRITY');
  });
});

describe('renderDiff and diffNotices', () => {
  it('lists changed files, the diff text, and the names of skipped files', () => {
    const rendered = renderDiff(processDiff(loadFixture('mixed-commit'), { maxChars: 100_000 }));
    expect(rendered).toContain('6 files changed');
    expect(rendered).toContain('diff --git a/src/auth/password.ts b/src/auth/password.ts');
    expect(rendered).toMatch(/Files whose content is not included/);
    expect(rendered).toContain('assets/favicon.png (binary file)');
    expect(rendered).toContain('package-lock.json (lock file)');
  });

  it('mentions truncation and omitted files so the model does not over-claim', () => {
    const rendered = renderDiff(processDiff(makeHugeDiff(100, 50), { maxChars: 5_000 }));
    expect(rendered).toMatch(/diff was too large/i);
    expect(rendered).toMatch(/omitted entirely/i);
  });

  describe('a diff with a huge number of files stays within a bounded prompt (found by the review)', () => {
    it.each([500, 5_000, 20_000])('%i files: the rendered text is bounded, not proportional to the file count', (count) => {
      const rendered = renderDiff(processDiff(makeHugeDiff(count, 1), { maxChars: 40_000 }));
      expect(rendered.length).toBeLessThan(60_000);
    });

    it('says how many files are not listed, and the totals still count every file', () => {
      const processed = processDiff(makeHugeDiff(5_000, 1), { maxChars: 40_000 });
      const rendered = renderDiff(processed);
      expect(rendered).toContain('5000 files changed');
      expect(rendered).toMatch(/\.\.\. and \d+ more files/);
      expect(processed.stats.files).toBe(5_000);
    });

    it('lists every file when there are few', () => {
      const rendered = renderDiff(processDiff(makeHugeDiff(40, 1), { maxChars: 1_000_000 }));
      expect(rendered).not.toContain('more files');
      expect(rendered).toContain('src/generated/file39.ts');
    });

    it('shortens a very long path in lists and notices', () => {
      const longName = `${'deeply/'.repeat(100)}file.ts`;
      const raw = [
        `diff --git a/${longName} b/${longName}`,
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        `+++ b/${longName}`,
        '@@ -0,0 +1 @@',
        '+x',
        '',
      ].join('\n');
      const processed = processDiff(raw, { maxChars: 1_000_000 });
      const overviewLine = renderDiff(processed).split('\n').find((l) => l.startsWith('- A '));
      expect((overviewLine ?? '').length).toBeLessThan(260);
    });
  });

  it('produces no notices for a small, clean diff', () => {
    expect(diffNotices(processDiff(loadFixture('normal-edit'), { maxChars: 100_000 }))).toEqual([]);
  });

  it('produces user-facing notices for skipped, truncated and omitted files', () => {
    const skipped = diffNotices(processDiff(loadFixture('mixed-commit'), { maxChars: 100_000 }));
    expect(skipped.join(' ')).toMatch(/2 files? .*not sent/i);

    const big = diffNotices(processDiff(makeHugeDiff(100, 50), { maxChars: 5_000 }));
    expect(big.join(' ')).toMatch(/too large/i);
    expect(big.join(' ')).toMatch(/left out|omitted/i);
  });
});
