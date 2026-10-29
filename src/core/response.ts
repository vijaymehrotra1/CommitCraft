// Cleans and validates what the model returns. Pure: no VS Code, no I/O.
// Models sometimes add a preamble ("Here's your commit message:"), wrap output in code fences, or
// run a little over the subject limit. We fix what is safe to fix and reject what is not.

import { CommitCraftError } from './errors';
import { CONVENTIONAL_SUBJECT, CONVENTIONAL_TYPES, PR_SECTIONS } from './format';
import type { CommitCraftSettings } from './types';

export interface CleanedText {
  text: string;
  /** Things we changed that the user may want to know about (e.g. "subject was shortened"). */
  warnings: string[];
}

type CleanSettings = Pick<CommitCraftSettings, 'style' | 'maxSubjectLength'>;

const PREAMBLE =
  /^(?:sure|certainly|of course|okay|ok|absolutely|here(?:'s|’s| is| are)|below is|this (?:is|commit message)|i(?:'ve|’ve| have)|based on)\b/i;

/** Words a shortened subject should not end on. */
const DANGLING_WORDS = /\s+(?:and|or|with|to|for|of|in|the|a|an|by|on|as|from|into|via|that|which)$/i;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function isPreambleLine(line: string): boolean {
  const trimmed = line.trim();
  return PREAMBLE.test(trimmed) && (trimmed.endsWith(':') || /commit message|description|pull request/i.test(trimmed));
}

/** A short label introducing the answer ("Here's the commit message:", "Commit message:"), not message content. */
function isLeadIn(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0 || lines.length > 2) {
    return false;
  }
  return lines.every(
    (line) => isPreambleLine(line) || /^(?:suggested |proposed |generated )?(?:commit message|pr description|description)\s*:$/i.test(line.trim()),
  );
}

/** If the answer is (or, after a short lead-in, contains) a fenced block, returns the block's content. */
function unwrapFence(text: string): string {
  const whole = /^```[\w+-]*[ \t]*\n([\s\S]*?)\n?```[ \t]*$/.exec(text);
  if (whole) {
    return (whole[1] ?? '').trim();
  }
  const fenceStart = text.indexOf('```');
  if (fenceStart > 0 && isLeadIn(text.slice(0, fenceStart))) {
    const block = /^```[\w+-]*[ \t]*\n([\s\S]*?)\n?```/m.exec(text.slice(fenceStart));
    if (block) {
      return (block[1] ?? '').trim();
    }
  }
  return text;
}

function stripPreamble(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 1 && isPreambleLine(lines[0] ?? '')) {
    lines.shift();
    while (lines.length > 0 && (lines[0] ?? '').trim() === '') {
      lines.shift();
    }
  }
  return lines.join('\n');
}

function stripSurroundingQuotes(text: string): string {
  const first = text.charAt(0);
  if (text.length > 1 && (first === '"' || first === "'" || first === '`') && text.endsWith(first)) {
    const inner = text.slice(1, -1);
    if (!inner.includes(first)) {
      return inner.trim();
    }
  }
  return text;
}

function tidyLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Shortens a subject to `max` characters at a word boundary, without ending on a dangling word. */
export function shortenSubject(subject: string, max: number): string {
  if (subject.length <= max) {
    return subject;
  }
  let cut = subject.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.5) {
    cut = cut.slice(0, lastSpace);
  }
  let previous: string;
  do {
    previous = cut;
    cut = cut.replace(/[\s,;:\-–—(]+$/, '').replace(DANGLING_WORDS, '');
  } while (cut !== previous);
  return cut.length > 0 ? cut : subject.slice(0, max);
}

function cleanSubject(subject: string, style: CommitCraftSettings['style']): string {
  let cleaned = subject
    .replace(/^#+\s+/, '')
    .replace(/^[-*]\s+/, '')
    .trim()
    .replace(/\.+$/, '');
  if (style === 'conventional') {
    cleaned = cleaned.replace(/^([A-Za-z]+)(\([^)]*\))?(!)?\s*:\s*/, (_m, type: string, scope?: string, bang?: string) =>
      `${type.toLowerCase()}${scope ?? ''}${bang ?? ''}: `,
    );
  }
  return cleaned;
}

/**
 * Turns the model's raw answer into a commit message: removes fences and chatter, enforces the
 * subject length, and (for the conventional style) validates the format.
 * @throws CommitCraftError EMPTY_RESPONSE or MALFORMED_RESPONSE
 */
export function cleanCommitMessage(raw: string, settings: CleanSettings): CleanedText {
  const warnings: string[] = [];
  let text = normalizeNewlines(raw).trim();
  if (text === '') {
    throw new CommitCraftError(
      'EMPTY_RESPONSE',
      'The AI returned an empty answer. Try again; if it keeps happening, check commitcraft.model.',
    );
  }

  text = stripSurroundingQuotes(tidyLines(stripPreamble(unwrapFence(text))));
  const lines = text.split('\n');
  const rawSubject = lines.shift() ?? '';
  const body = lines.join('\n').trim();

  let subject = cleanSubject(rawSubject, settings.style);
  if (subject === '') {
    throw new CommitCraftError(
      'EMPTY_RESPONSE',
      'The AI answer had no subject line. Try again; if it keeps happening, check commitcraft.model.',
    );
  }

  if (subject.length > settings.maxSubjectLength) {
    subject = shortenSubject(subject, settings.maxSubjectLength);
    warnings.push(`The subject line was shortened to fit ${settings.maxSubjectLength} characters.`);
  }

  if (settings.style === 'conventional' && !CONVENTIONAL_SUBJECT.test(subject)) {
    throw new CommitCraftError(
      'MALFORMED_RESPONSE',
      `The AI answer was not in Conventional Commit format (expected "<type>: <description>" with type one of ${CONVENTIONAL_TYPES.join(', ')}). Run the command again, or set commitcraft.style to "plain".`,
    );
  }

  return { text: body === '' ? subject : `${subject}\n\n${body}`, warnings };
}

const FENCE_LINE = /^[ \t]*```/;

/**
 * Drops a closing fence the model left behind after unwrapping, but only when fences are unbalanced.
 * A section that ends with its own complete code block keeps its closing fence.
 */
function removeStrayTrailingFence(text: string): string {
  const lines = text.split('\n');
  const fences = lines.filter((line) => FENCE_LINE.test(line)).length;
  const last = lines.length - 1;
  if (fences % 2 === 1 && FENCE_LINE.test(lines[last] ?? '')) {
    lines.pop();
  }
  return lines.join('\n').trimEnd();
}

/**
 * Replaces markdown and HTML images with their alt text, outside code blocks. A prompt-injected diff comment
 * could otherwise make the description contain an image whose URL is fetched when the preview opens.
 */
function neutralizeImages(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) {
        return line;
      }
      const placeholder = (alt: string): string => (alt.trim() === '' ? '(image removed)' : `${alt.trim()} (image removed)`);
      return line
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => placeholder(alt))
        .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_match, alt: string) => placeholder(alt))
        .replace(/<img\b[^>]*>/gi, '(image removed)');
    })
    .join('\n');
}

const HEADING = /^#{1,6}[ \t]+\S/;

/** Rewrites `### summary:` style headings of the required sections to `## Summary`. */
function normalizeSectionHeadings(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const match = /^#{2,3}[ \t]*(summary|changes|testing|risks)[ \t]*:?[ \t]*$/i.exec(line);
      const name = PR_SECTIONS.find((section) => section.toLowerCase() === match?.[1]?.toLowerCase());
      return name ? `## ${name}` : line;
    })
    .join('\n');
}

/**
 * Cleans a PR description: removes fences and any chatter before the first heading, normalises the
 * four required headings, and checks they are all there.
 * @throws CommitCraftError EMPTY_RESPONSE or MALFORMED_RESPONSE
 */
export function cleanPrDescription(raw: string): CleanedText {
  let text = normalizeNewlines(raw).trim();
  if (text === '') {
    throw new CommitCraftError(
      'EMPTY_RESPONSE',
      'The AI returned an empty answer. Try again; if it keeps happening, check commitcraft.model.',
    );
  }

  text = unwrapFence(text);
  const lines = text.split('\n');
  const firstHeading = lines.findIndex((line) => HEADING.test(line));
  if (firstHeading > 0) {
    lines.splice(0, firstHeading);
  }
  text = neutralizeImages(removeStrayTrailingFence(normalizeSectionHeadings(tidyLines(lines.join('\n')))));

  const missing = PR_SECTIONS.filter((section) => !new RegExp(`^## ${section}$`, 'm').test(text));
  if (missing.length > 0) {
    throw new CommitCraftError(
      'MALFORMED_RESPONSE',
      `The AI's PR description was missing the ${missing.join(' and ')} section${missing.length > 1 ? 's' : ''}. Run the command again.`,
    );
  }
  return { text: `${text.trim()}\n`, warnings: [] };
}
