// Parse, filter and size-limit unified diffs (the output of `git diff`). Pure: no VS Code, no I/O.

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
export type SkipReason = 'binary file' | 'lock file' | 'sensitive file';

export interface DiffFile {
  /** Path to show the user: the new path, or the old path for a deleted file. */
  path: string;
  /** Path before the change; differs from `path` only for renames and copies. */
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  /** Only the file mode (e.g. chmod +x) changed. */
  modeChangeOnly: boolean;
  additions: number;
  deletions: number;
  /** This file's section of the diff, exactly as git wrote it, without a trailing newline. */
  text: string;
}

export interface IncludedFile {
  file: DiffFile;
  /** The text to send: redacted, and shortened if it did not fit the budget. */
  text: string;
  truncated: boolean;
  omittedLines: number;
}

export interface SkippedFile {
  path: string;
  status: FileStatus;
  reason: SkipReason;
}

/** A file dropped entirely because the diff had too many files for the size budget. */
export interface OmittedFile {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export interface DiffStats {
  /** Files in the whole diff, including skipped and omitted ones. */
  files: number;
  additions: number;
  deletions: number;
  originalChars: number;
  /** Characters of diff text that will be sent (excludes the rendered file list and notes). */
  sentChars: number;
  /** True if any file was shortened or omitted to fit the size limit. */
  truncated: boolean;
}

export interface ProcessedDiff {
  included: IncludedFile[];
  skipped: SkippedFile[];
  omitted: OmittedFile[];
  /** Every file of the diff in its original order, for the "changed files" overview. */
  overview: OverviewEntry[];
  stats: DiffStats;
}

export interface OverviewEntry {
  path: string;
  oldPath: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export interface ProcessDiffOptions {
  /** Upper bound on the characters of diff text kept. */
  maxChars: number;
  /** Files for which this returns true are never included (names only). */
  isSensitivePath?: (path: string) => boolean;
  /**
   * Applied to each included file's text BEFORE truncation. Order matters: truncating first could
   * cut a multi-line secret (a private key) in half so the pattern no longer matches and the rest leaks.
   */
  redactText?: (text: string) => string;
}

// ---------------------------------------------------------------------------------------------
// Lock files
// ---------------------------------------------------------------------------------------------

const LOCK_FILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'bun.lockb',
  'go.sum',
  'packages.lock.json',
  'gradle.lockfile',
  '.terraform.lock.hcl',
  'package.resolved',
]);

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** Dependency lock files are large, machine-written and carry no intent worth describing. */
export function isLockFile(path: string): boolean {
  const name = baseName(path);
  return LOCK_FILE_NAMES.has(name) || name.endsWith('.lock');
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

const SECTION_START = /^diff --(git|cc|combined) /;

/** Decodes a path as git prints it: optional "double quotes" with C escapes and octal UTF-8 bytes. */
export function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  // Work on code points, not UTF-16 units: an emoji is two units and must not be split.
  const chars = Array.from(value.slice(1, -1));
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = chars[i + 1] ?? '';
    const octal = /^[0-7]{1,3}/.exec(chars.slice(i + 1, i + 4).join(''));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += octal[0].length;
    } else if (next in simple) {
      bytes.push(simple[next] as number);
      i += 1;
    } else {
      bytes.push(...Buffer.from(next, 'utf8'));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Reads the path after `--- ` / `+++ `. Git appends a TAB when the path contains spaces. */
function parseMarkerPath(value: string, prefix: 'a/' | 'b/'): string | null {
  const path = value.split('\t')[0] ?? '';
  if (path === '/dev/null') {
    return null;
  }
  const unquoted = unquoteGitPath(path);
  return unquoted.startsWith(prefix) ? unquoted.slice(2) : unquoted;
}

/** Reads one token from the start of `text`: a quoted string or everything up to the next space. */
function takeToken(text: string): { token: string; rest: string } {
  if (text.startsWith('"')) {
    let end = 1;
    while (end < text.length && !(text[end] === '"' && text[end - 1] !== '\\')) {
      end++;
    }
    return { token: text.slice(0, end + 1), rest: text.slice(end + 2) };
  }
  const space = text.indexOf(' ');
  return space === -1
    ? { token: text, rest: '' }
    : { token: text.slice(0, space), rest: text.slice(space + 1) };
}

/** Extracts old/new paths from the text after `diff --git `. Ambiguous for unquoted paths with spaces. */
function parseHeaderPaths(rest: string): { oldPath: string; newPath: string } {
  if (rest.startsWith('"')) {
    const first = takeToken(rest);
    const second = takeToken(first.rest);
    return {
      oldPath: stripPrefix(unquoteGitPath(first.token), 'a/'),
      newPath: stripPrefix(unquoteGitPath(second.token), 'b/'),
    };
  }
  if (rest.startsWith('a/')) {
    let from = 0;
    let firstSplit = -1;
    for (;;) {
      const index = rest.indexOf(' b/', from);
      if (index === -1) {
        break;
      }
      if (firstSplit === -1) {
        firstSplit = index;
      }
      const left = rest.slice(2, index);
      const right = rest.slice(index + 3);
      if (left === right) {
        return { oldPath: left, newPath: right };
      }
      from = index + 1;
    }
    if (firstSplit !== -1) {
      return { oldPath: rest.slice(2, firstSplit), newPath: rest.slice(firstSplit + 3) };
    }
  }
  const middle = (rest.length - 1) / 2;
  if (Number.isInteger(middle) && rest[middle] === ' ' && rest.slice(0, middle) === rest.slice(middle + 1)) {
    return { oldPath: rest.slice(0, middle), newPath: rest.slice(0, middle) };
  }
  const { token, rest: other } = takeToken(rest);
  return { oldPath: token, newPath: other || token };
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string {
  return path.startsWith(prefix) ? path.slice(2) : path;
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parseSection(lines: string[]): DiffFile {
  const header = stripCr(lines[0] ?? '');
  const combined = !header.startsWith('diff --git ');
  const headerRest = header.replace(SECTION_START, '');

  let status: FileStatus = 'modified';
  let binary = false;
  let modeChange = false;
  let inHunk = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let copyFrom: string | undefined;
  let copyTo: string | undefined;
  let minusPath: string | null | undefined;
  let plusPath: string | null | undefined;
  let additions = 0;
  let deletions = 0;

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line = stripCr(raw);
    if (inHunk) {
      const marks = combined ? raw.slice(0, 2) : raw.slice(0, 1);
      if (marks.includes('+')) {
        additions++;
      } else if (marks.includes('-')) {
        deletions++;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
    } else if (line.startsWith('new file mode')) {
      status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      renameFrom = unquoteGitPath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      renameTo = unquoteGitPath(line.slice('rename to '.length));
    } else if (line.startsWith('copy from ')) {
      copyFrom = unquoteGitPath(line.slice('copy from '.length));
    } else if (line.startsWith('copy to ')) {
      copyTo = unquoteGitPath(line.slice('copy to '.length));
    } else if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      modeChange = true;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      binary = true;
    } else if (line.startsWith('--- ')) {
      minusPath = parseMarkerPath(line.slice(4), 'a/');
    } else if (line.startsWith('+++ ')) {
      plusPath = parseMarkerPath(line.slice(4), 'b/');
    }
  }

  let oldPath: string;
  let newPath: string;
  if (renameFrom !== undefined && renameTo !== undefined) {
    status = 'renamed';
    [oldPath, newPath] = [renameFrom, renameTo];
  } else if (copyFrom !== undefined && copyTo !== undefined) {
    status = 'copied';
    [oldPath, newPath] = [copyFrom, copyTo];
  } else {
    const fromHeader = combined
      ? { oldPath: headerRest, newPath: headerRest }
      : parseHeaderPaths(headerRest);
    oldPath = minusPath ?? fromHeader.oldPath;
    newPath = plusPath ?? fromHeader.newPath;
    if (minusPath === null && plusPath) {
      oldPath = plusPath;
    }
    if (plusPath === null && minusPath) {
      newPath = minusPath;
    }
  }

  return {
    path: status === 'deleted' ? oldPath : newPath,
    oldPath,
    status,
    binary,
    modeChangeOnly: modeChange && !inHunk && !binary && status === 'modified',
    additions,
    deletions,
    text: lines.join('\n'),
  };
}

/** Splits a unified diff into one entry per file. Text before the first `diff --git` is ignored. */
export function parseDiff(raw: string): DiffFile[] {
  if (raw.trim() === '') {
    return [];
  }
  const lines = raw.split('\n');
  if (raw.endsWith('\n')) {
    lines.pop();
  }
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (SECTION_START.test(line)) {
      starts.push(index);
    }
  });
  return starts.map((start, i) => parseSection(lines.slice(start, starts[i + 1] ?? lines.length)));
}

// ---------------------------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------------------------

/** Room kept free for the "[... N more lines truncated ...]" marker. */
const MARKER_RESERVE = 80;
/** Below this many characters a file's diff is not worth showing; drop whole files instead. */
const MIN_FILE_CHARS = 400;

export interface TruncationResult {
  text: string;
  truncated: boolean;
  omittedLines: number;
}

/**
 * Shortens `text` to at most `limit` characters (for limits of at least ~80), cutting at a line
 * boundary and appending a marker that says how many lines were dropped.
 */
export function truncateText(text: string, limit: number): TruncationResult {
  if (text.length <= limit) {
    return { text, truncated: false, omittedLines: 0 };
  }
  const lines = text.split('\n');
  const budget = Math.max(limit - MARKER_RESERVE, 0);
  let used = 0;
  let kept = 0;
  while (kept < lines.length) {
    const cost = (lines[kept] as string).length + (kept > 0 ? 1 : 0);
    if (used + cost > budget) {
      break;
    }
    used += cost;
    kept++;
  }

  let head = lines.slice(0, kept).join('\n');
  let omittedLines = lines.length - kept;
  if (kept === 0) {
    // Not even the first line fits (a pathological path in the header): keep a piece of it. A giant CONTENT
    // line (minified code) is dropped whole instead: the header and the marker still say it was there.
    head = (lines[0] as string).slice(0, budget);
    omittedLines = lines.length - 1;
  }
  const marker =
    omittedLines === 0
      ? '[... line truncated by CommitCraft ...]'
      : `[... ${omittedLines} more ${omittedLines === 1 ? 'line' : 'lines'} truncated by CommitCraft ...]`;
  return { text: head === '' ? marker : `${head}\n${marker}`, truncated: true, omittedLines };
}

/** Gives each file min(its size, fair share), handing the space small files do not need to big ones. */
function allocateBudget(lengths: number[], budget: number): number[] {
  const order = lengths.map((_, index) => index).sort((a, b) => (lengths[a] as number) - (lengths[b] as number));
  const limits = new Array<number>(lengths.length).fill(0);
  let remaining = budget;
  order.forEach((index, position) => {
    const share = Math.floor(remaining / (order.length - position));
    const limit = Math.min(lengths[index] as number, share);
    limits[index] = limit;
    remaining -= limit;
  });
  return limits;
}

// ---------------------------------------------------------------------------------------------
// Processing and rendering
// ---------------------------------------------------------------------------------------------

function skipReason(file: DiffFile, isSensitivePath?: (path: string) => boolean): SkipReason | undefined {
  if (isSensitivePath?.(file.path) || isSensitivePath?.(file.oldPath)) {
    return 'sensitive file';
  }
  if (file.binary) {
    return 'binary file';
  }
  if (isLockFile(file.path)) {
    return 'lock file';
  }
  return undefined;
}

/**
 * Turns a raw diff into what may be sent: sensitive, binary and lock files reduced to names, text
 * redacted, then shortened to fit `maxChars` (fairly per file; whole files dropped if there are too many).
 */
export function processDiff(raw: string, options: ProcessDiffOptions): ProcessedDiff {
  const files = parseDiff(raw);
  const skipped: SkippedFile[] = [];
  const candidates: Array<{ file: DiffFile; text: string; index: number }> = [];

  files.forEach((file, index) => {
    const reason = skipReason(file, options.isSensitivePath);
    if (reason) {
      skipped.push({ path: file.path, status: file.status, reason });
      return;
    }
    candidates.push({ file, text: options.redactText ? options.redactText(file.text) : file.text, index });
  });

  const totalChars = candidates.reduce((sum, c) => sum + c.text.length, 0);
  let kept = candidates;
  const omitted: OmittedFile[] = [];
  let limits = candidates.map((c) => c.text.length);

  if (totalChars > options.maxChars) {
    const maxFiles = Math.max(1, Math.floor(options.maxChars / MIN_FILE_CHARS));
    if (candidates.length > maxFiles) {
      const byChurn = [...candidates].sort(
        (a, b) => b.file.additions + b.file.deletions - (a.file.additions + a.file.deletions) || a.index - b.index,
      );
      const keepSet = new Set(byChurn.slice(0, maxFiles).map((c) => c.index));
      kept = candidates.filter((c) => keepSet.has(c.index));
      for (const c of candidates) {
        if (!keepSet.has(c.index)) {
          const { path, status, additions, deletions } = c.file;
          omitted.push({ path, status, additions, deletions });
        }
      }
    }
    limits = allocateBudget(
      kept.map((c) => c.text.length),
      options.maxChars,
    );
  }

  const included: IncludedFile[] = kept.map((c, i) => {
    const result = truncateText(c.text, limits[i] as number);
    return { file: c.file, text: result.text, truncated: result.truncated, omittedLines: result.omittedLines };
  });

  const stats: DiffStats = {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    originalChars: raw.length,
    sentChars: included.reduce((n, f) => n + f.text.length, 0),
    truncated: omitted.length > 0 || included.some((f) => f.truncated),
  };

  return {
    included,
    skipped,
    omitted,
    overview: files.map(({ path, oldPath, status, additions, deletions }) => ({
      path,
      oldPath,
      status,
      additions,
      deletions,
    })),
    stats,
  };
}

const STATUS_LETTER: Record<FileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  copied: 'C',
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The listings are capped so the prompt stays bounded however many files the diff touches. */
const MAX_LISTED_FILES = 100;
const MAX_LISTED_UNSENT = 50;
const MAX_LISTED_PATH_CHARS = 200;

function shortPath(path: string): string {
  return path.length > MAX_LISTED_PATH_CHARS ? `${path.slice(0, MAX_LISTED_PATH_CHARS - 1)}…` : path;
}

/** Keeps the first `limit` lines and says how many more files exist. */
function capList(lines: string[], limit: number): string[] {
  return lines.length <= limit ? lines : [...lines.slice(0, limit), `... and ${lines.length - limit} more files (not listed)`];
}

/** The text that goes into the prompt: overview, diff sections, names of unsent files, size notes. */
export function renderDiff(processed: ProcessedDiff): string {
  const { stats, overview, included, skipped, omitted } = processed;
  const parts: string[] = [];

  parts.push(`${plural(stats.files, 'file')} changed, +${stats.additions} -${stats.deletions}.`);
  parts.push(
    [
      'Changed files:',
      ...capList(
        overview.map((entry) => {
          const name =
            entry.status === 'renamed' || entry.status === 'copied'
              ? `${shortPath(entry.oldPath)} -> ${shortPath(entry.path)}`
              : shortPath(entry.path);
          return `- ${STATUS_LETTER[entry.status]} ${name} (+${entry.additions} -${entry.deletions})`;
        }),
        MAX_LISTED_FILES,
      ),
    ].join('\n'),
  );

  if (included.length > 0) {
    parts.push(included.map((f) => f.text).join('\n'));
  }

  if (skipped.length > 0 || omitted.length > 0) {
    parts.push(
      [
        'Files whose content is not included:',
        ...capList(
          [
            ...skipped.map((s) => `- ${shortPath(s.path)} (${s.reason})`),
            ...omitted.map((o) => `- ${shortPath(o.path)} (omitted: diff too large)`),
          ],
          MAX_LISTED_UNSENT,
        ),
      ].join('\n'),
    );
  }

  if (stats.truncated) {
    const shortened = included.filter((f) => f.truncated).length;
    const clauses: string[] = [];
    if (shortened > 0) {
      clauses.push(`${plural(shortened, 'file')} shortened (marked "truncated by CommitCraft")`);
    }
    if (omitted.length > 0) {
      clauses.push(`${plural(omitted.length, 'file')} omitted entirely`);
    }
    parts.push(
      `Note: the diff was too large to send in full: ${clauses.join(' and ')}. Describe only what is shown and do not guess about the rest.`,
    );
  }

  return parts.join('\n\n');
}

const MAX_NAMES_IN_NOTICE = 5;

function nameList(names: string[]): string {
  const shown = names.slice(0, MAX_NAMES_IN_NOTICE).map(shortPath).join(', ');
  const extra = names.length - MAX_NAMES_IN_NOTICE;
  return extra > 0 ? `${shown} and ${extra} more` : shown;
}

/** Plain-language notes for the user about what was not sent in full. Empty when nothing was held back. */
export function diffNotices(processed: ProcessedDiff): string[] {
  const notices: string[] = [];
  const { skipped, omitted, included } = processed;

  if (skipped.length > 0) {
    notices.push(
      `Content of ${plural(skipped.length, 'file')} was not sent (${nameList(skipped.map((s) => `${s.path}: ${s.reason}`))}).`,
    );
  }
  const shortened = included.filter((f) => f.truncated).length;
  if (shortened > 0 || omitted.length > 0) {
    const clauses: string[] = [];
    if (shortened > 0) {
      clauses.push(`${plural(shortened, 'file was', 'files were')} shortened`);
    }
    if (omitted.length > 0) {
      clauses.push(`${plural(omitted.length, 'file was', 'files were')} left out entirely (${nameList(omitted.map((o) => o.path))})`);
    }
    notices.push(`The diff was too large to send in full: ${clauses.join(' and ')}.`);
  }
  return notices;
}
