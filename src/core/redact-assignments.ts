// Credentials assigned to a named thing: `password=...`, `"api_key": "..."`, `token := "..."`,
// `<password>...</password>`, `PASSWORD 'x'`, `--token x`. Pure: no VS Code, no I/O.
//
// Rules of thumb (see docs/knowledge-base/secret-patterns.md):
//  - The keyword must END the key name (`passwordLabel`, `max_tokens` never match).
//  - Prefer masking to leaking, but never mask obvious non-secrets: placeholders, variable references,
//    paths to key files, snake_case labels. Those exemptions apply to the WHOLE value only.
//  - Every pattern starts at a literal or a bounded prefix so hostile input cannot make it go quadratic.

import { HSPACE, REDACTED, hit, type Tally } from './redact-shared';

const KEYWORD =
  'password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|credential|_auth|pass';

// ---------------------------------------------------------------------------------------------
// Values that are not secrets
// ---------------------------------------------------------------------------------------------

const PLACEHOLDER = new RegExp(
  String.raw`^(?:\[REDACTED\]|%[sd]|%\(.*|\{\{.*|<.*|.*>|\*+|x{3,}|\.{3,}|-+|` +
    String.raw`(?:your|my)[-_ ](?:api[-_ ]?key|key|token|secret|password|passwd|pass|value|credential)s?(?:[-_ ]here)?|` +
    String.raw`example|placeholder|dummy|sample|changeme|todo|none|null|nil|undefined|true|false)$`,
  'i',
);

/** A variable the shell or a template will fill in: `${VAR}`, `$(cmd)`, `$VAR` (upper case), `%VAR%`. */
function isVariableReference(value: string): boolean {
  return /^\$[({]/.test(value) || /^\$[A-Z_][A-Z0-9_]*$/.test(value) || /^%[A-Z_][A-Z0-9_]*%$/.test(value);
}

export function isPlaceholder(value: string): boolean {
  return value === '' || PLACEHOLDER.test(value) || isVariableReference(value);
}

/** Looks like code that fetches a value (`process.env.X`, `getPassword(`, `this.token`), not the value. */
function isReference(value: string): boolean {
  return /[([{<>]/.test(value) || /->|::/.test(value) || /^[A-Za-z_]\w*\.[A-Za-z_]/.test(value);
}

function looksHighEntropy(value: string): boolean {
  return value.length >= 24 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

/** A path to a key or secret file (`/etc/ssl/private/server.key`, `~/.ssh/id`), not the secret itself. */
function isPath(value: string): boolean {
  const pathLike = /^(?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+ -]*)*$/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
  return pathLike && !looksHighEntropy(value); // a base64 secret can start with '/'
}

/** A lowercase snake_case label that names the thing (`refresh_token`, `ghp_exampletoken`). Hyphens do not count. */
function isLabel(value: string): boolean {
  return /^[a-z]+(?:[_.:][a-z]+)+$/.test(value) && /token|secret|password|passwd|key/.test(value);
}

function isNonSecret(value: string): boolean {
  return isPlaceholder(value) || isPath(value) || isLabel(value);
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function quotedLooksSecret(value: string, keyword: string): boolean {
  if (value.length < 4 || /\s/.test(value) || isNonSecret(value)) {
    return false;
  }
  return squash(value) !== squash(keyword); // `"password": "Password"` is a label, not a secret
}

function bareLooksSecret(value: string): boolean {
  if (isNonSecret(value) || isReference(value)) {
    return false;
  }
  return value.length >= 6 && /[0-9!@#%^&*+/=~]/.test(value);
}

function identifierBefore(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_.-]/.test(text.charAt(start - 1))) {
    start--;
  }
  return text.slice(start, offset);
}

/** `pass` is a short word: `DB_PASS` and `dbPass` are keys, `bypass` and `compass` are not. */
function passKeywordOk(before: string, keywordText: string): boolean {
  if (keywordText.toLowerCase() !== 'pass') {
    return true;
  }
  return before === '' || /[_.-]$/.test(before) || (/[a-z0-9]$/.test(before) && /^[A-Z]/.test(keywordText));
}

// ---------------------------------------------------------------------------------------------
// Env-file style: UPPER_CASE_KEY=value (the value runs to the next whitespace, so nothing leaks)
// ---------------------------------------------------------------------------------------------

const ENV_KEYWORD =
  '(?:[A-Z][A-Z0-9_]*)?(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET_?KEY|CREDENTIAL|_AUTH)' +
  '|(?:[A-Z][A-Z0-9_]*_)?(?:PASS|PWD)';
const ENV_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])((?:export${HSPACE}+)?(?:${ENV_KEYWORD}))=([^\s"'\x60]+)`,
  'g',
);

function redactEnvAssignments(text: string, tally: Tally): string {
  return text.replace(ENV_ASSIGNMENT, (match: string, head: string, value: string) => {
    if (isNonSecret(value) || isReference(value) || /^\d{1,7}$/.test(value)) {
      return match;
    }
    hit(tally, 'secret-assignment');
    return `${head}=${REDACTED}`;
  });
}

// ---------------------------------------------------------------------------------------------
// Structured forms: XML elements and attributes, SQL, command-line flags
// ---------------------------------------------------------------------------------------------

const XML_ELEMENT = new RegExp(
  String.raw`<([A-Za-z0-9_.:-]{0,60}?(?:${KEYWORD}))(?:\s[^<>]*)?>([^<>\n]+)</\1>`,
  'gi',
);
const XML_KEY_VALUE_ATTRIBUTES = new RegExp(
  String.raw`(\b(?:key|name)\s*=\s*["'][^"'<>]{0,80}?(?:${KEYWORD})["']\s+value\s*=\s*)(["'])([^"'<>]*)\2`,
  'gi',
);
const SQL_PASSWORD = new RegExp(String.raw`(\b(?:PASSWORD|IDENTIFIED${HSPACE}+BY)${HSPACE}+)'([^'\n]*)'`, 'gi');
const CLI_FLAG = new RegExp(
  String.raw`(--[A-Za-z0-9-]{0,40}?(?:password|passwd|passphrase|secret|token|api-?key|access-?key|private-?key|secret-?key|credential))(${HSPACE}+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s"']*)`,
  'gi',
);

function redactStructured(text: string, tally: Tally): string {
  let result = text.replace(XML_ELEMENT, (match: string, name: string, value: string) => {
    const keyword = new RegExp(`(?:${KEYWORD})$`, 'i').exec(name)?.[0] ?? name;
    const before = name.slice(0, name.length - keyword.length);
    if (!passKeywordOk(before, keyword) || !quotedLooksSecret(value.trim(), keyword)) {
      return match;
    }
    hit(tally, 'secret-assignment');
    return match.replace(`>${value}</`, `>${REDACTED}</`);
  });

  result = result.replace(XML_KEY_VALUE_ATTRIBUTES, (match: string, head: string, quote: string, value: string) => {
    if (!quotedLooksSecret(value, '')) {
      return match;
    }
    hit(tally, 'secret-assignment');
    return `${head}${quote}${REDACTED}${quote}`;
  });

  result = result.replace(SQL_PASSWORD, (match: string, head: string, value: string) => {
    if (!quotedLooksSecret(value, 'password')) {
      return match;
    }
    hit(tally, 'secret-assignment');
    return `${head}'${REDACTED}'`;
  });

  return result.replace(CLI_FLAG, (match: string, flag: string, space: string, raw: string) => {
    const quote = raw.startsWith('"') || raw.startsWith("'") ? raw.charAt(0) : '';
    const value = quote ? raw.slice(1, -1) : raw;
    if (value.length < 4 || isNonSecret(value) || isReference(value)) {
      return match;
    }
    hit(tally, 'secret-assignment');
    return `${flag}${space}${quote}${REDACTED}${quote}`;
  });
}

// ---------------------------------------------------------------------------------------------
// General assignments: password=..., "api_key": "...", token := "...", 'X' => 'y', X-Api-Key: ...
// ---------------------------------------------------------------------------------------------

// Keyword first, so the scan starts at a keyword and never at an arbitrary identifier character.
// Separators are horizontal whitespace only, so a YAML `password:` at the end of a line cannot swallow the
// next line; a QUOTED value may sit on the next line (formatters wrap long assignments).
const CONTINUATION = String.raw`(?:\r?\n[+\- ]?${HSPACE}*)?`;
const ASSIGNMENT = new RegExp(
  String.raw`(${KEYWORD})(["']?)(${HSPACE}*)(:=|=>|=(?![=>])|:)(${HSPACE}*)` +
    String.raw`(?:${CONTINUATION}"((?:[^"\\\n]|\\.)*)"|${CONTINUATION}'((?:[^'\\\n]|\\.)*)'|([^\s"'\x60,;&)}\]]+))`,
  'gi',
);

function redactGeneralAssignments(text: string, tally: Tally): string {
  return text.replace(
    ASSIGNMENT,
    (
      match: string,
      keyword: string,
      _keyQuote: string,
      _before: string,
      operator: string,
      _after: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
      offset: number,
    ) => {
      if (!passKeywordOk(identifierBefore(text, offset), keyword)) {
        return match;
      }
      const quoted = doubleQuoted ?? singleQuoted;
      // `pass: "passed"` is a status label. For this short, common word only a credential-looking value counts.
      if (keyword.toLowerCase() === 'pass' && !/[\d!@#$%^&*+/=~]/.test(quoted ?? bare ?? '')) {
        return match;
      }

      if (quoted !== undefined) {
        if (!quotedLooksSecret(quoted, keyword)) {
          return match;
        }
        const quote = doubleQuoted !== undefined ? '"' : "'";
        hit(tally, 'secret-assignment');
        return `${match.slice(0, match.length - quoted.length - 2)}${quote}${REDACTED}${quote}`;
      }

      const value = bare ?? '';
      if (operator === '=>' || !bareLooksSecret(value)) {
        return match; // `password => password.length` is an arrow function, not an assignment
      }
      hit(tally, 'secret-assignment');
      return `${match.slice(0, match.length - value.length)}${REDACTED}`;
    },
  );
}

/** Runs every assignment-style rule. Order matters little: each leaves `[REDACTED]`, which the others skip. */
export function redactAssignments(text: string, tally: Tally): string {
  return redactGeneralAssignments(redactStructured(redactEnvAssignments(text, tally), tally), tally);
}
