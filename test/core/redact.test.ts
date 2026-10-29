import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitivePath, redact } from '../../src/core/redact';
import { FAKE } from '../helpers/fakeSecrets';
import { loadFixture } from '../helpers/fixtures';

/** Redacts `input`, asserts none of `secrets` survive, and returns the result for further checks. */
function expectMasked(input: string, ...secrets: string[]): ReturnType<typeof redact> {
  const result = redact(input);
  for (const secret of secrets) {
    expect(result.text).not.toContain(secret);
  }
  expect(result.text).toContain(REDACTED);
  expect(result.count).toBeGreaterThan(0);
  return result;
}

describe('redact: provider token formats', () => {
  it.each([
    ['AWS access key id', 'aws-access-key-id', FAKE.awsAccessKey],
    ['Anthropic API key', 'anthropic-api-key', FAKE.anthropicKey],
    ['OpenAI project key', 'openai-api-key', FAKE.openAiKey],
    ['OpenAI legacy key', 'openai-api-key', FAKE.openAiLegacyKey],
    ['GitHub token', 'github-token', FAKE.githubToken],
    ['GitHub fine-grained token', 'github-token', FAKE.githubFineGrained],
    ['GitLab token', 'gitlab-token', FAKE.gitlabToken],
    ['Slack token', 'slack-token', FAKE.slackToken],
    ['Stripe key', 'stripe-key', FAKE.stripeKey],
    ['Google API key', 'google-api-key', FAKE.googleKey],
    ['npm token', 'npm-token', FAKE.npmToken],
    ['JWT', 'jwt', FAKE.jwt],
  ])('masks a %s wherever it appears', (_label, kind, secret) => {
    const line = `+  const value = "${secret}"; // keep this comment`;
    const result = expectMasked(line, secret);
    expect(result.kinds).toContain(kind);
    expect(result.text.startsWith('+  const value = "')).toBe(true);
    expect(result.text.endsWith('"; // keep this comment')).toBe(true);
  });

  it('masks tokens embedded in prose, URLs and shell commands', () => {
    expectMasked(`curl https://api.example.invalid/?k=${FAKE.githubToken}&x=1`, FAKE.githubToken);
    expectMasked(`Found key ${FAKE.awsAccessKey}, please rotate`, FAKE.awsAccessKey);
  });

  it('masks several secrets on the same line and counts each one', () => {
    const result = redact(`${FAKE.githubToken} ${FAKE.awsAccessKey} ${FAKE.anthropicKey}`);
    expect(result.text).toBe(`${REDACTED} ${REDACTED} ${REDACTED}`);
    expect(result.count).toBe(3);
    expect(result.kinds.sort()).toEqual(['anthropic-api-key', 'aws-access-key-id', 'github-token']);
  });
});

describe('redact: assignments', () => {
  it.each([
    ['env style', 'PASSWORD=letmein', 'letmein'],
    ['env with export', 'export API_TOKEN=abc', 'abc'],
    ['aws secret in ini', `aws_secret_access_key = ${FAKE.awsSecretKey}`, FAKE.awsSecretKey],
    ['dotted properties', 'db.password=hunter22', 'hunter22'],
    ['double-quoted string', 'const password = "correcthorse";', 'correcthorse'],
    ['single-quoted string', "apiKey = 'abcd1234efgh'", 'abcd1234efgh'],
    ['JSON', '{ "api_key": "abcd1234efgh", "retries": 3 }', 'abcd1234efgh'],
    ['YAML with digits', 'client_secret: s3cr3t-value', 's3cr3t-value'],
    ['YAML quoted', 'secret: "plainsecretvalue"', 'plainsecretvalue'],
    ['HTTP header', 'X-Api-Key: abcd1234efgh', 'abcd1234efgh'],
    ['query string', 'GET /v1/items?api_key=abcd1234&limit=10', 'abcd1234'],
    ['Go short declaration', 'token := "abcd1234efgh"', 'abcd1234efgh'],
    ['private key assignment', "private_key = 'abcd1234efgh'", 'abcd1234efgh'],
    ['secret key', 'SECRET_KEY=django-insecure-abc123', 'django-insecure-abc123'],
  ])('masks the value, keeps the key: %s', (_label, input, secret) => {
    const result = expectMasked(input, secret);
    const key = /[A-Za-z_.-]+/.exec(input)?.[0] ?? '';
    expect(result.text).toContain(key);
    expect(result.kinds).toContain('secret-assignment');
  });

  it('keeps quotes and punctuation around a masked JSON value', () => {
    expect(redact('{ "password": "hunter2hunter2", "user": "ann" }').text).toBe(
      `{ "password": "${REDACTED}", "user": "ann" }`,
    );
  });

  it('masks the password in a connection URL but not the user or host', () => {
    expect(redact('DATABASE_URL=postgres://app:p4ssw0rd!@db.internal:5432/app').text).toBe(
      `DATABASE_URL=postgres://app:${REDACTED}@db.internal:5432/app`,
    );
  });

  it('masks Authorization header credentials but keeps the scheme', () => {
    expect(redact('curl -H "Authorization: Bearer abcdef1234567890xyz" https://x.invalid').text).toBe(
      `curl -H "Authorization: Bearer ${REDACTED}" https://x.invalid`,
    );
    expect(redact('Authorization: Basic dXNlcjpwYXNzd29yZA==').text).toBe(`Authorization: Basic ${REDACTED}`);
  });

  it('does not let a YAML key at end of line swallow the next line', () => {
    const text = '+password:\n+  nested: value\n+token:\n+next: x';
    expect(redact(text).text).toBe(text);
  });
});

describe('redact: private keys', () => {
  const block = [FAKE.pkBegin, FAKE.pkLine1, FAKE.pkLine2, FAKE.pkEnd];

  it('masks every body line but keeps line count, diff prefixes and the BEGIN/END markers', () => {
    const input = ['@@ -0,0 +1,4 @@', ...block.map((l) => `+${l}`), '+done'].join('\n');
    const result = redact(input);
    const lines = result.text.split('\n');
    expect(lines).toHaveLength(input.split('\n').length);
    expect(lines).toEqual([
      '@@ -0,0 +1,4 @@',
      `+${FAKE.pkBegin}`,
      `+${REDACTED}`,
      `+${REDACTED}`,
      `+${FAKE.pkEnd}`,
      '+done',
    ]);
    expect(result.text).not.toContain(FAKE.pkLine1);
    expect(result.count).toBe(1);
    expect(result.kinds).toEqual(['private-key']);
  });

  it('handles markers in the middle of a line (key inside a template string)', () => {
    const input = [
      `+export const signingKey = \`${FAKE.pkBegin}`,
      `+${FAKE.pkLine1}`,
      `+${FAKE.pkLine2}`,
      `+${FAKE.pkEnd}\`;`,
      "+export const keyId = 'signing-key-2026';",
    ].join('\n');
    const result = redact(input);
    expect(result.text).not.toContain(FAKE.pkLine1);
    expect(result.text).not.toContain(FAKE.pkLine2);
    expect(result.text.split('\n')).toHaveLength(5);
    expect(result.text).toContain("+export const keyId = 'signing-key-2026';");
    expect(result.text).toContain(`${FAKE.pkEnd}\`;`);
  });

  it('masks a key written on one line with escaped newlines (JSON service account)', () => {
    const json = `{"private_key": "${FAKE.pkBegin}\\n${FAKE.pkLine1}\\n${FAKE.pkEnd}\\n", "id": 1}`;
    const result = redact(json);
    expect(result.text).not.toContain(FAKE.pkLine1);
    expect(result.text).toContain('"id": 1}');
  });

  it('masks removed (-) and context ( ) lines of a key too', () => {
    const input = [` ${FAKE.pkBegin}`, `-${FAKE.pkLine1}`, ` ${FAKE.pkEnd}`].join('\n');
    const result = redact(input);
    expect(result.text.split('\n')).toEqual([` ${FAKE.pkBegin}`, `-${REDACTED}`, ` ${FAKE.pkEnd}`]);
  });

  it('masks everything after an unterminated BEGIN marker (conservative)', () => {
    const input = [`+${FAKE.pkBegin}`, `+${FAKE.pkLine1}`, '+more', '+and more'].join('\n');
    const result = redact(input);
    expect(result.text.split('\n')).toEqual([
      `+${FAKE.pkBegin}`,
      `+${REDACTED}`,
      `+${REDACTED}`,
      `+${REDACTED}`,
    ]);
  });

  it('an unterminated block ends at the next file section and does not swallow later files', () => {
    const input = [
      'diff --git a/a.txt b/a.txt',
      '@@ -0,0 +1,3 @@',
      `+${FAKE.pkBegin}`,
      `+${FAKE.pkLine1}`,
      `+${FAKE.pkLine2}`,
      'diff --git a/b.ts b/b.ts',
      '@@ -0,0 +1,1 @@',
      '+export const safe = 1;',
    ].join('\n');
    const lines = redact(input).text.split('\n');
    expect(lines.slice(2, 5)).toEqual([`+${FAKE.pkBegin}`, `+${REDACTED}`, `+${REDACTED}`]);
    expect(lines.slice(5)).toEqual(['diff --git a/b.ts b/b.ts', '@@ -0,0 +1,1 @@', '+export const safe = 1;']);
  });

  it('recognises other key types (OpenSSH, EC, PGP block)', () => {
    for (const type of ['OPENSSH PRIVATE KEY', 'EC PRIVATE KEY', 'PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
      const input = `-----BEGIN ${type}-----\n${FAKE.pkLine1}\n-----END ${type}-----`;
      expect(redact(input).text).not.toContain(FAKE.pkLine1);
    }
  });

  it('does not mask a PUBLIC key block', () => {
    const input = `-----BEGIN PUBLIC KEY-----\n${FAKE.pkLine1}\n-----END PUBLIC KEY-----`;
    expect(redact(input).text).toBe(input);
  });
});

describe('redact: things that only look like secrets must NOT be masked', () => {
  it.each([
    'password: string;',
    'password: str',
    'const password = getPassword();',
    'const password = await prompt();',
    'password = process.env.DB_PASSWORD',
    'password = os.environ["DB_PASSWORD"]',
    'token = this.token',
    'const token = response.data.access_token;',
    'password: ${DB_PASSWORD}',
    'password: "${DB_PASSWORD}"',
    'api_key: <your api key>',
    'api_key = "your-api-key-here"',
    'token: ""',
    "secret = ''",
    'api_key: xxxxxxxxxxxx',
    'PASSWORD=',
    'if (token === expected) {',
    'if (password == "")',
    'max_tokens: 4096',
    'const tokenizer = new Tokenizer();',
    "passwordLabel: 'Enter your password'",
    '<input type="password" name="password">',
    'secret_santa: "friends and family"',
    'token_count = 1234567890',
    'password: "Enter the password you chose earlier"',
    '"password": "Password"',
    'Use a Bearer token to authenticate',
    'Bearer authentication is supported',
    'secret: Buffer',
    'export const GRANT_TYPE_REFRESH_TOKEN = "refresh_token";',
    "authorization_token: 'ghp_exampletoken',",
    "token: 'bearer_exampletoken'",
    'ssl_private_key = /etc/ssl/private/server.key',
    'private_key: "~/.ssh/deploy_key"',
    "PWD: '/Users/dev/project',",
    'secret_file: ./config/secrets/db.json',
    'const { password, token } = req.body;',
    'https://example.com:8080/path',
    'git@github.com:org/repo.git',
    'https://user@example.com/page',
    'ssh://git@github.com:22/org/repo.git',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'id: 3f2b8c1e-7d4a-4f9b-9c1e-2a6d8e4f1b3c',
    'integrity: sha512-FAKEINTEGRITY0001ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789==',
    'AKIA1234',
    'class="sk-circle-fade-in-animation-keyframes-long-name"',
    'task-management-board-with-a-very-long-identifier-name-2024',
    'the disk-usage-report-generator-2024-final-version-0001 job',
    'ghp_short',
    'eyJhbGciOiJIUzI1NiJ9',
    '-----BEGIN CERTIFICATE-----',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
  ])('leaves %j untouched', (input) => {
    const result = redact(input);
    expect(result.text).toBe(input);
    expect(result.count).toBe(0);
    expect(result.kinds).toEqual([]);
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
  ])('does not change the realistic diff fixture %s', (name) => {
    const raw = loadFixture(name);
    const result = redact(raw);
    expect(result.text).toBe(raw);
    expect(result.count).toBe(0);
  });
});

describe('redact: keeps the diff structure intact', () => {
  it('keeps the line count and the first character (diff prefix) of every line', () => {
    const raw = loadFixture('secrets');
    const result = redact(raw);
    const before = raw.split('\n');
    const after = result.text.split('\n');
    expect(after).toHaveLength(before.length);
    before.forEach((line, i) => {
      expect(after[i]?.[0]).toBe(line[0]);
    });
  });

  it('masks every fake secret in the secrets fixture', () => {
    const result = redact(loadFixture('secrets'));
    for (const secret of [
      FAKE.awsAccessKey,
      FAKE.anthropicKey,
      FAKE.githubToken,
      FAKE.jwt,
      FAKE.dbPassword,
      FAKE.sessionSecret,
      FAKE.pkLine1,
      FAKE.pkLine2,
    ]) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.count).toBeGreaterThanOrEqual(8);
  });

  it('leaves headers, hunk markers and non-secret code lines alone', () => {
    const result = redact(loadFixture('secrets'));
    expect(result.text).toContain('diff --git a/src/config.ts b/src/config.ts');
    expect(result.text).toContain('@@ -0,0 +1,10 @@');
    expect(result.text).toContain("+  region: 'us-east-1',");
    expect(result.text).toContain('+  retries: 3,');
  });

  it('does not touch file names that contain secret-like words', () => {
    const header = [
      'diff --git a/src/password.ts b/src/password.ts',
      '--- a/src/token.ts',
      '+++ b/src/secret.ts',
      '@@ -1,3 +1,4 @@',
    ].join('\n');
    expect(redact(header).text).toBe(header);
  });

  it('is idempotent', () => {
    const once = redact(loadFixture('secrets'));
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });

  it('handles empty input', () => {
    expect(redact('')).toEqual({ text: '', count: 0, kinds: [] });
  });

  it('stays fast on very long single-line blobs (no catastrophic backtracking)', () => {
    const plain = 'A1b2'.repeat(250_000);
    // Base64/minified-style data is full of '+', '-', '.' and '/', which create word boundaries
    // inside the blob: the worst case for a scheme-matching regex like `\b[a-z][a-z0-9+.-]*://`.
    const dense = 'aB+c/d-e.'.repeat(120_000);
    const started = Date.now();
    redact(`+const data = "${plain}";`);
    redact(`+${plain}`);
    redact(`+const data = "${dense}";`);
    redact(`+${dense}`);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    '.env.example',
    'config/.env',
    'apps/api/.env.test',
    'prod.env',
    '.envrc',
    'server.pem',
    'certs/private.key',
    'id_rsa',
    'home/.ssh/id_ed25519',
    'deploy/id_rsa_deploy',
    'deploy\\id_rsa',
    'cert.p12',
    'cert.pfx',
    'release.jks',
    'release.keystore',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.pgpass',
    '.htpasswd',
    '.aws/credentials',
    '.git-credentials',
    'infra/terraform.tfstate',
    'infra/prod.tfvars',
    '.ENV',
    'SERVER.PEM',
  ])('flags %s as sensitive', (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    '.environment.ts',
    'src/env.ts',
    'docs/environment.md',
    '.envoy.yaml',
    'id_rsa.pub',
    'src/monkey.ts',
    'src/keys.ts',
    'docs/key-management.md',
    'src/pem-utils.ts',
    'README.md',
    'src/credentials.ts',
    'src/config/keyboard.key.ts',
    'package.json',
  ])('does not flag %s', (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });
});
