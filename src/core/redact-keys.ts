// Private-key material. Handled line by line so every line and its diff prefix survive (hunk headers
// must keep matching), and in linear time (this runs synchronously in the shared extension host).
// Pure: no VS Code, no I/O.

import { REDACTED, hit, type Tally } from './redact-shared';

// The key type ("RSA ", "OPENSSH ", "ENCRYPTED ", "PGP ...") is short; bounding it keeps every scan linear.
const KEY_TYPE = '[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?';
const BEGIN_KEY = new RegExp(`-----BEGIN ${KEY_TYPE}-----`);
const END_KEY = new RegExp(`-----END ${KEY_TYPE}-----`);
const BEGIN_KEY_GLOBAL = new RegExp(BEGIN_KEY.source, 'g');
const END_KEY_GLOBAL = new RegExp(END_KEY.source, 'g');
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;
// Public keys and certificates have the same shape as private key bodies but are not secret: leave them readable.
const PUBLIC_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}(?:PUBLIC KEY|CERTIFICATE(?: REQUEST)?)-----/;
const ANY_END = /-----END [A-Z0-9 ]{0,40}-----/;

interface SplitLine {
  prefix: string;
  content: string;
  cr: string;
}

/** Separates a diff prefix (`+`, `-`, space) and a trailing CR from the content of a line. */
function splitLine(line: string): SplitLine {
  const cr = line.endsWith('\r') ? '\r' : '';
  const body = cr ? line.slice(0, -1) : line;
  const prefix = body.length > 0 && '+- '.includes(body.charAt(0)) ? body.charAt(0) : '';
  return { prefix, content: body.slice(prefix.length), cr };
}

/**
 * Masks the content of a line part but keeps a leading diff prefix and a trailing CR. `masked` is false
 * when there was nothing to mask or it was already masked (idempotence).
 */
function maskLinePart(part: string): { text: string; masked: boolean } {
  const { prefix, content, cr } = splitLine(part);
  if (content.trim() === '' || content === REDACTED) {
    return { text: part, masked: false };
  }
  return { text: `${prefix}${REDACTED}${cr}`, masked: true };
}

function execFrom(pattern: RegExp, text: string, from: number): RegExpExecArray | null {
  pattern.lastIndex = from;
  return pattern.exec(text);
}

/** Masks complete BEGIN..END blocks that sit on one line (JSON with escaped newlines). Linear: it never rescans. */
function maskInlineKeys(line: string, tally: Tally): string {
  let result = '';
  let position = 0;
  for (;;) {
    const begin = execFrom(BEGIN_KEY_GLOBAL, line, position);
    if (!begin) {
      break;
    }
    const end = execFrom(END_KEY_GLOBAL, line, begin.index + begin[0].length);
    if (!end) {
      break; // no END after this BEGIN, so none after any later BEGIN either
    }
    result += line.slice(position, begin.index) + REDACTED;
    hit(tally, 'private-key');
    position = end.index + end[0].length;
  }
  return result + line.slice(position);
}

/** A line of base64 key body as found inside a PEM block (used when walking back from an END marker). */
function isKeyBodyLine(content: string): boolean {
  return content.length >= 8 && BASE64_ONLY.test(content) && (content.length >= 40 || content.endsWith('='));
}

/** A full-width PEM body line on its own: 60 to 80 base64 characters with mixed case and a digit, '+' or '/'. */
function isPemBodyLine(content: string): boolean {
  return (
    content.length >= 60 &&
    content.length <= 80 &&
    BASE64_ONLY.test(content) &&
    /[a-z]/.test(content) &&
    /[A-Z]/.test(content) &&
    /[\d+/]/.test(content)
  );
}

/** An END marker with no BEGIN in the text (the hunk started inside the key): mask the body above it. */
function maskBodyAbove(lines: string[], endIndex: number): boolean {
  let masked = false;
  for (let j = endIndex - 1; j >= 0; j--) {
    const { prefix, content, cr } = splitLine(lines[j] as string);
    if (content === REDACTED) {
      continue;
    }
    if (!isKeyBodyLine(content)) {
      break;
    }
    lines[j] = `${prefix}${REDACTED}${cr}`;
    masked = true;
  }
  return masked;
}

/**
 * Masks private keys: complete blocks (multi-line, mid-line, one-line), the rest of a file section after an
 * unterminated BEGIN, body lines above an END whose BEGIN is outside the text, and stray PEM body lines.
 * Each key counts once, and only if something was not already masked.
 */
export function redactPrivateKeys(text: string, tally: Tally): string {
  const lines = text.split('\n');
  let inside = false;
  let blockMasked = false; // did the current block contain anything not already masked?
  let strayRun = false; // are we inside a run of stray PEM body lines (so it counts once)?
  let publicBlock = false; // inside an explicit PUBLIC KEY / CERTIFICATE block, which is not secret

  const closeBlock = (): void => {
    if (blockMasked) {
      hit(tally, 'private-key');
    }
    inside = false;
    blockMasked = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i] as string;

    if (original.startsWith('diff --git ')) {
      publicBlock = false;
      if (inside) {
        closeBlock(); // the key was never terminated; the next file section is not part of it
      }
    }

    if (inside) {
      if (HUNK_HEADER.test(original) || original.startsWith('\\')) {
        continue; // structure of the diff, not key material: keep it so the hunks still line up
      }
      const end = END_KEY.exec(original);
      const part = maskLinePart(end ? original.slice(0, end.index) : original);
      lines[i] = end ? part.text + original.slice(end.index) : part.text;
      blockMasked ||= part.masked;
      if (end) {
        closeBlock();
      }
      continue;
    }

    if (!original.includes('PRIVATE KEY')) {
      if (publicBlock || PUBLIC_BEGIN.test(original)) {
        publicBlock = !ANY_END.test(original);
        strayRun = false;
        continue;
      }
      const { prefix, content, cr } = splitLine(original);
      if (isPemBodyLine(content)) {
        lines[i] = `${prefix}${REDACTED}${cr}`;
        if (!strayRun) {
          hit(tally, 'private-key');
          strayRun = true;
        }
      } else {
        strayRun = false;
      }
      continue;
    }

    strayRun = false;
    const line = maskInlineKeys(original, tally);
    const begin = BEGIN_KEY.exec(line);
    if (begin) {
      const afterMarker = begin.index + begin[0].length;
      const rest = line.slice(afterMarker);
      const { content, cr } = splitLine(rest);
      const maskRest = content.trim() !== '' && content !== REDACTED;
      lines[i] = line.slice(0, afterMarker) + (maskRest ? `${REDACTED}${cr}` : rest);
      inside = true;
      blockMasked = maskRest;
      continue;
    }

    const end = END_KEY.exec(line);
    if (end) {
      const part = maskLinePart(line.slice(0, end.index));
      lines[i] = part.text + line.slice(end.index);
      if (maskBodyAbove(lines, i) || part.masked) {
        hit(tally, 'private-key');
      }
      continue;
    }
    lines[i] = line;
  }
  if (inside) {
    closeBlock(); // unterminated block: everything after BEGIN was masked
  }
  return lines.join('\n');
}
