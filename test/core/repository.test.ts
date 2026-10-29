import { describe, expect, it } from 'vitest';
import { CommitCraftError } from '../../src/core/errors';
import { assertValidBranchName, isValidBranchName, pickRepositoryRoot } from '../../src/core/repository';

describe('isValidBranchName', () => {
  it.each(['main', 'develop', 'release/1.2', 'feature/add-login', 'user/jane_doe/fix+1', 'v2.0.1', 'fix@home', 'функция', '123-fix'])(
    'accepts %s',
    (name) => {
      expect(isValidBranchName(name)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['an option (argument injection)', '--output=/tmp/x'],
    ['a short option', '-p'],
    ['an option with value', '--upload-pack=evil'],
    ['whitespace', 'my branch'],
    ['a newline', 'main\nfoo'],
    ['parent traversal', 'a/../b'],
    ['a trailing slash', 'feature/'],
    ['a trailing dot', 'feature.'],
    ['a .lock suffix', 'main.lock'],
    ['a double slash', 'a//b'],
    ['a reflog selector', 'main@{1}'],
    ['a shell metacharacter', 'main;rm'],
    ['a backtick', 'a`b'],
    ['a dollar', 'a$(b)'],
    ['a colon', 'a:b'],
    ['a leading slash', '/main'],
    ['a leading dot', '.hidden'],
    ['too long', 'a'.repeat(201)],
  ])('rejects %s', (_label, name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});

describe('assertValidBranchName', () => {
  it('does nothing for a valid name', () => {
    expect(() => assertValidBranchName('main')).not.toThrow();
  });

  it('throws INVALID_SETTING with advice for an invalid name, truncating long values', () => {
    let error: unknown;
    try {
      assertValidBranchName(`--${'x'.repeat(100)}`);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CommitCraftError);
    expect((error as CommitCraftError).code).toBe('INVALID_SETTING');
    expect((error as CommitCraftError).message).toMatch(/commitcraft\.baseBranch/);
    expect((error as CommitCraftError).message).toMatch(/Open Settings/);
    expect((error as CommitCraftError).message.length).toBeLessThan(250);
  });
});

describe('pickRepositoryRoot', () => {
  const roots = ['/work/app', '/work/app/vendor/lib', '/work/other'];

  it('returns undefined without a file path or without a match', () => {
    expect(pickRepositoryRoot(roots, undefined)).toBeUndefined();
    expect(pickRepositoryRoot(roots, '')).toBeUndefined();
    expect(pickRepositoryRoot(roots, '/elsewhere/file.ts')).toBeUndefined();
    expect(pickRepositoryRoot([], '/work/app/a.ts')).toBeUndefined();
  });

  it('picks the repository that contains the file', () => {
    expect(pickRepositoryRoot(roots, '/work/app/src/a.ts')).toBe(0);
    expect(pickRepositoryRoot(roots, '/work/other/b.ts')).toBe(2);
  });

  it('prefers the nested repository (submodule) over its parent', () => {
    expect(pickRepositoryRoot(roots, '/work/app/vendor/lib/x.ts')).toBe(1);
  });

  it('does not match a sibling that merely shares a name prefix', () => {
    expect(pickRepositoryRoot(['/work/app'], '/work/application/a.ts')).toBeUndefined();
  });

  it('treats a path equal to the root as inside it', () => {
    expect(pickRepositoryRoot(roots, '/work/app')).toBe(0);
  });

  it('ignores trailing slashes and accepts Windows separators', () => {
    expect(pickRepositoryRoot(['C:\\work\\app\\'], 'C:\\work\\app\\src\\a.ts')).toBe(0);
    expect(pickRepositoryRoot(['/work/app/'], '/work/app/a.ts')).toBe(0);
  });

  it('is case sensitive unless told otherwise', () => {
    expect(pickRepositoryRoot(['/Work/App'], '/work/app/a.ts')).toBeUndefined();
    expect(pickRepositoryRoot(['/Work/App'], '/work/app/a.ts', { caseInsensitive: true })).toBe(0);
    expect(pickRepositoryRoot(['C:\\Work\\App'], 'c:\\work\\app\\a.ts', { caseInsensitive: true })).toBe(0);
  });
});
