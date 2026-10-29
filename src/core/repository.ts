// Pure helpers for choosing a repository and validating names that end up in git commands.

import { CommitCraftError } from './errors';

/**
 * Conservative check for a branch or ref name that will be passed to git. It must not start with
 * `-` (git would read it as an option: argument injection from a malicious workspace setting) and
 * must use only characters that are valid and unsurprising in ref names.
 */
export function isValidBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    /^[\p{L}\p{N}_][\p{L}\p{N}_./@+-]*$/u.test(name) &&
    !name.includes('..') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('//') &&
    !name.includes('@{')
  );
}

export function assertValidBranchName(name: string): void {
  if (!isValidBranchName(name)) {
    throw new CommitCraftError(
      'INVALID_SETTING',
      `"${name.slice(0, 60)}" is not a usable branch name for commitcraft.baseBranch. Open Settings and enter a plain branch name such as main or develop.`,
    );
  }
}

function normalizePath(path: string, caseInsensitive: boolean): string {
  let normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (caseInsensitive) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Picks the repository that contains `filePath`: the one with the longest matching root, so a
 * submodule or nested repo wins over its parent. Returns the index into `roots`, or undefined.
 */
export function pickRepositoryRoot(
  roots: readonly string[],
  filePath: string | undefined,
  options: { caseInsensitive?: boolean } = {},
): number | undefined {
  if (!filePath) {
    return undefined;
  }
  const caseInsensitive = options.caseInsensitive ?? false;
  const target = normalizePath(filePath, caseInsensitive);
  let best: { index: number; length: number } | undefined;
  roots.forEach((root, index) => {
    const normalizedRoot = normalizePath(root, caseInsensitive);
    const contains = target === normalizedRoot || target.startsWith(`${normalizedRoot}/`);
    if (contains && (best === undefined || normalizedRoot.length > best.length)) {
      best = { index, length: normalizedRoot.length };
    }
  });
  return best?.index;
}
