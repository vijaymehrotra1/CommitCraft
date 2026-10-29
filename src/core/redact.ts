// Masks likely secrets in text before it leaves the machine. Pure: no VS Code, no I/O.
//
// Design rules (see docs/knowledge-base/secret-patterns.md):
//  - Replace VALUES, never lines: line count and each line's `+`/`-`/space diff prefix are
//    preserved so hunk headers (`@@ -a,b +c,d @@`) still match the body.
//  - Prefer a false positive (a harmless `[REDACTED]`) over a leak, but do not mask obvious
//    non-secrets (type annotations, env lookups, placeholders): the commit message would degrade.
//  - Every regex starts at a literal or a bounded prefix, and every quantifier that can fail after a
//    long scan is bounded, so a hostile file cannot freeze the shared extension host.
//
// The work is split by kind: redact-keys.ts (private keys), redact-assignments.ts (`name = value` forms),
// sensitive-paths.ts (files never sent). This file holds the provider token formats and the public API.

import { redactAssignments, isPlaceholder } from './redact-assignments';
import { redactPrivateKeys } from './redact-keys';
import { REDACTED, hit, type Tally } from './redact-shared';

export { REDACTED } from './redact-shared';
export { isSensitivePath } from './sensitive-paths';

export interface RedactionResult {
  text: string;
  /** Number of secrets masked. */
  count: number;
  /** Distinct rule names that fired, in first-hit order. Never contains secret values. */
  kinds: string[];
}

// ---------------------------------------------------------------------------------------------
// Provider token formats
// ---------------------------------------------------------------------------------------------

/** Not preceded by a letter or digit. Unlike `\b`, an underscore or hyphen right before a token still counts as a boundary. */
const START = '(?<![A-Za-z0-9])';

const TOKEN_RULES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'anthropic-api-key', pattern: new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{16,}`, 'g') },
  { kind: 'openai-api-key', pattern: new RegExp(`${START}sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}`, 'g') },
  {
    kind: 'openai-api-key',
    pattern: new RegExp(`${START}sk-(?=[A-Za-z0-9]*\\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}`, 'g'),
  },
  { kind: 'github-token', pattern: new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{36,}`, 'g') },
  { kind: 'github-token', pattern: new RegExp(`${START}github_pat_[A-Za-z0-9_]{22,}`, 'g') },
  { kind: 'gitlab-token', pattern: new RegExp(`${START}glpat-[A-Za-z0-9_-]{20,}`, 'g') },
  {
    kind: 'aws-access-key-id',
    pattern: new RegExp(`${START}(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}(?![A-Za-z0-9])`, 'g'),
  },
  { kind: 'slack-token', pattern: new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}`, 'g') },
  { kind: 'stripe-key', pattern: new RegExp(`${START}[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`, 'g') },
  { kind: 'google-api-key', pattern: new RegExp(`${START}AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`, 'g') },
  { kind: 'google-oauth-token', pattern: new RegExp(`${START}ya29\\.[A-Za-z0-9_-]{20,}`, 'g') },
  { kind: 'npm-token', pattern: new RegExp(`${START}npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])`, 'g') },
  { kind: 'huggingface-token', pattern: new RegExp(`${START}hf_[A-Za-z0-9]{34,}`, 'g') },
  { kind: 'sendgrid-key', pattern: new RegExp(`${START}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`, 'g') },
  { kind: 'pypi-token', pattern: new RegExp(`${START}pypi-AgE[A-Za-z0-9_-]{50,}`, 'g') },
  { kind: 'digitalocean-token', pattern: new RegExp(`${START}do[opr]_v1_[a-f0-9]{64}`, 'g') },
  { kind: 'shopify-token', pattern: new RegExp(`${START}shp(?:at|ca|pa|ss)_[a-f0-9]{32}`, 'g') },
  { kind: 'dockerhub-token', pattern: new RegExp(`${START}dckr_pat_[A-Za-z0-9_-]{20,}`, 'g') },
  { kind: 'vault-token', pattern: new RegExp(`${START}hvs\\.[A-Za-z0-9_-]{24,}`, 'g') },
  {
    kind: 'slack-webhook',
    pattern: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{20,}/g,
  },
  {
    kind: 'discord-webhook',
    pattern: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{5,}\/[A-Za-z0-9_-]{20,}/g,
  },
  // JWT segments are bounded: an unbounded `{8,}` goes quadratic on input like "eyJ-eyJ-eyJ-...".
  {
    kind: 'jwt',
    pattern: new RegExp(`${START}eyJ[A-Za-z0-9_-]{8,300}\\.eyJ[A-Za-z0-9_-]{8,3000}\\.[A-Za-z0-9_-]{0,1000}`, 'g'),
  },
];

// ---------------------------------------------------------------------------------------------
// Credentials in URLs and Authorization headers
// ---------------------------------------------------------------------------------------------

const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@/'"`<>]+:)([^\s@/'"`<>]+)(@)/gi;
const AUTH_HEADER = /\b(Authorization["']?[ \t]*[:=][ \t]*["']?(?:Bearer|Basic|Token)[ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi;
const BARE_BEARER = /\b(Bearer[ \t]+)([A-Za-z0-9._~+/=-]{20,})/g;

function redactSecondGroup(text: string, pattern: RegExp, kind: string, tally: Tally): string {
  return text.replace(pattern, (match: string, head: string, secret: string, tail?: string) => {
    if (isPlaceholder(secret)) {
      return match;
    }
    hit(tally, kind);
    return `${head}${REDACTED}${typeof tail === 'string' ? tail : ''}`;
  });
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Masks likely secrets in `text`. Safe to call repeatedly (already-masked values are left alone). */
export function redact(text: string): RedactionResult {
  const tally: Tally = { count: 0, kinds: new Set() };

  let result = redactPrivateKeys(text, tally);
  for (const rule of TOKEN_RULES) {
    result = result.replace(rule.pattern, () => {
      hit(tally, rule.kind);
      return REDACTED;
    });
  }
  result = redactSecondGroup(result, AUTH_HEADER, 'bearer-token', tally);
  result = redactSecondGroup(result, BARE_BEARER, 'bearer-token', tally);
  result = redactSecondGroup(result, URL_PASSWORD, 'url-password', tally);
  result = redactAssignments(result, tally);

  return { text: result, count: tally.count, kinds: [...tally.kinds] };
}
