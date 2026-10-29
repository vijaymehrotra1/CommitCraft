// Output-format constants shared by the prompts (what we ask for) and the response cleaner (what we accept).

export const CONVENTIONAL_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

/** `type(scope)!: description`. The scope and `!` are optional; a description is required. */
export const CONVENTIONAL_SUBJECT = new RegExp(
  `^(${CONVENTIONAL_TYPES.join('|')})(\\([^()\\s][^()]*\\))?!?: \\S`,
);

/** The sections every PR description must contain, in this order. */
export const PR_SECTIONS = ['Summary', 'Changes', 'Testing', 'Risks'] as const;
export type PrSection = (typeof PR_SECTIONS)[number];
