// Small pieces shared by the redaction modules. Pure: no VS Code, no I/O.

export const REDACTED = '[REDACTED]';

export interface Tally {
  count: number;
  kinds: Set<string>;
}

export function hit(tally: Tally, kind: string): void {
  tally.count++;
  tally.kinds.add(kind);
}

/** Horizontal whitespace for use inside a RegExp source: space, tab, NBSP and the Unicode spaces. Never a line break. */
export const HSPACE = '[ \\t\\u00A0\\u2000-\\u200B\\u202F\\u205F\\u3000]';
