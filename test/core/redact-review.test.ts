// Regression tests for the findings of the independent security review (see docs/qa.md).
// Each block starts from an input the reviewer reproduced as leaking or hanging.
import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitivePath, redact } from '../../src/core/redact';
import { FAKE } from '../helpers/fakeSecrets';

// Assembled from fragments so no secret-shaped literal (not even a PEM header) lives in the repository.
const PEM_BEGIN = ['-----BEGIN ', 'PRIVATE KEY', '-----'].join('');
const AWS_LOOKALIKE = ['T', 'AKIA', '1234567890ABCDEFG'].join('');

function expectMasked(input: string, ...secrets: string[]): string {
  const result = redact(input);
  for (const secret of secrets) {
    expect(result.text, `leaked ${secret} from ${JSON.stringify(input)}`).not.toContain(secret);
  }
  expect(result.count).toBeGreaterThan(0);
  return result.text;
}

describe('HIGH 1: assignment syntaxes that used to slip through', () => {
  it.each([
    ['PHP/Ruby hash rocket', "'DB_PASSWORD' => 'hunter22xyz',", 'hunter22xyz'],
    ['PHP double-quoted rocket', '"api_key" => "abc123def456ghi789"', 'abc123def456ghi789'],
    ['XML element', '<password>hunter22xyz</password>', 'hunter22xyz'],
    ['XML element with attributes', '<apiKey type="string">abc123def456ghi789</apiKey>', 'abc123def456ghi789'],
    ['.NET appSettings entry', '<add key="ApiKey" value="abc123def456ghi789"/>', 'abc123def456ghi789'],
    ['SQL PASSWORD', "ALTER ROLE app WITH PASSWORD 'hunter22xyz';", 'hunter22xyz'],
    ['SQL IDENTIFIED BY', "CREATE USER app IDENTIFIED BY 'hunter22xyz';", 'hunter22xyz'],
    ['CLI flag followed by a space', 'run --password hunter22xyz', 'hunter22xyz'],
    ['CLI token flag', 'tool login --token abc123def456ghi789', 'abc123def456ghi789'],
    ['CLI flag with a quoted value', 'run --secret "hunter 22 xyz"', 'hunter 22 xyz'],
    ['env-style abbreviation', 'DB_PASS=hunter22xyz', 'hunter22xyz'],
    ['camelCase abbreviation', "dbPass = 'hunter22xyz'", 'hunter22xyz'],
    ['bare pass key', 'pass: "hunter22xyz"', 'hunter22xyz'],
    ['credential', 'credential = "hunter22xyz"', 'hunter22xyz'],
    ['npm _auth', '_auth = dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['assignment wrapped by a formatter', "+const dbPassword =\n+  'p4ssw0rd-long-value';", 'p4ssw0rd-long-value'],
    ['wrapped assignment, plain text', "const dbPassword =\n  'p4ssw0rd-long-value';", 'p4ssw0rd-long-value'],
    ['non-breaking space after the colon', 'password: hunter22xyz', 'hunter22xyz'],
    ['non-breaking space around =', 'password = "hunter22xyz"', 'hunter22xyz'],
  ])('masks %s', (_label, input, secret) => {
    expectMasked(input, secret);
  });

  it('keeps the surrounding syntax intact', () => {
    expect(redact('<password>hunter22xyz</password>').text).toBe(`<password>${REDACTED}</password>`);
    expect(redact('<add key="ApiKey" value="abc123def456ghi789"/>').text).toBe(`<add key="ApiKey" value="${REDACTED}"/>`);
    expect(redact("ALTER ROLE app WITH PASSWORD 'hunter22xyz';").text).toBe(`ALTER ROLE app WITH PASSWORD '${REDACTED}';`);
    expect(redact('run --password hunter22xyz --verbose').text).toBe(`run --password ${REDACTED} --verbose`);
    expect(redact("'DB_PASSWORD' => 'hunter22xyz',").text).toBe(`'DB_PASSWORD' => '${REDACTED}',`);
  });

  it.each([
    "bypass: 'enabled-x1'",
    "const bypass = 'some-value-1'",
    "compass: 'north-4'",
    'pass: "passed"',
    "const pass = 'success';",
    "pass: 'ok'",
    'status = { pass: "passed", fail: "failed" }',
    'run --token-file /var/run/token',
    'run --password-stdin',
    'run --secret-name my-secret-name',
    'password => password.length',
    'const f = token => token.value',
    '<password></password>',
    '<password>${DB_PASSWORD}</password>',
    '<password>changeme</password>',
    '<passwordField>hunter22xyz</passwordField>',
    '<add key="Timeout" value="30"/>',
    "SELECT password FROM users WHERE name = 'bob';",
    'password VARCHAR(255) NOT NULL,',
    "ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT 'none';",
    'credential = getCredential()',
    'credential: Credential',
    "IDENTIFIED BY 'x'",
  ])('does not mask the look-alike %j', (input) => {
    expect(redact(input).text).toBe(input);
  });
});

describe('HIGH 2: exemptions that used to let real values through', () => {
  it.each([
    ['a my_ prefix is not a placeholder', 'password = "my_s3cr3t_p4ss"', 'my_s3cr3t_p4ss'],
    ['a the_ prefix is not a placeholder', 'password = "the_s3cr3t_p4ss"', 'the_s3cr3t_p4ss'],
    ['a leading $ is not always a shell variable', 'PASSWORD=$ecretP4ssw0rd', '$ecretP4ssw0rd'],
    ['a quoted value starting with $', 'password = "$up3rS3cret!"', '$up3rS3cret!'],
    ['a base64 secret that starts with /', 'aws_secret_access_key = "/Ab1Cd2Ef3Gh4+Ij5/Kl6Mn7Op8Qr9St0Uv1Wx2Yz3"', '/Ab1Cd2Ef3Gh4+Ij5/Kl6Mn7Op8Qr9St0Uv1Wx2Yz3'],
    ['a hyphenated passphrase is not a label', 'secret: "supersecret-password-key"', 'supersecret-password-key'],
  ])('masks: %s', (_label, input, secret) => {
    expectMasked(input, secret);
  });

  it.each([
    ['&', 'PASSWORD=ab&cdef123456', 'PASSWORD=[REDACTED]'],
    [',', 'API_TOKEN=ab,cdef123456', 'API_TOKEN=[REDACTED]'],
    [';', 'SECRET_KEY=ab;cdef123456', 'SECRET_KEY=[REDACTED]'],
    [')', 'DB_PASSWORD=ab)cdef123456', 'DB_PASSWORD=[REDACTED]'],
    ['}', 'APP_SECRET=ab}cdef123456', 'APP_SECRET=[REDACTED]'],
    [']', 'AUTH_TOKEN=ab]cdef123456', 'AUTH_TOKEN=[REDACTED]'],
  ])('masks an env value that contains %s (no partial leak)', (_label, input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  it('still leaves real placeholders, variable references and key-file paths alone', () => {
    for (const input of [
      'password = "your-api-key-here"',
      'token = "your_token_here"',
      'PASSWORD=$DB_PASSWORD',
      'PASSWORD=${DB_PASSWORD:-fallback}',
      'PASSWORD=$(cat /run/secrets/pw)',
      'password: "${DB_PASSWORD}"',
      'ssl_private_key = /etc/ssl/private/server.key',
      'private_key: "~/.ssh/deploy_key"',
      "PWD: '/Users/dev/project',",
      'export const GRANT_TYPE_REFRESH_TOKEN = "refresh_token";',
    ]) {
      expect(redact(input).text, input).toBe(input);
    }
  });

  it.each([
    ['AWS key followed by _prod', `${FAKE.awsAccessKey}_prod`, FAKE.awsAccessKey],
    ['AWS key after key_', `key_${FAKE.awsAccessKey}`, FAKE.awsAccessKey],
    ['GitHub token inside a file name', `deploy_${FAKE.githubToken}.txt`, FAKE.githubToken],
    ['Anthropic key after an underscore', `ANTHROPIC_${FAKE.anthropicKey}`, FAKE.anthropicKey],
  ])('masks a token even when an underscore touches it: %s', (_label, input, secret) => {
    expectMasked(input, secret);
  });

  it('still does not mask look-alikes glued to letters or digits', () => {
    for (const input of [AWS_LOOKALIKE, 'disk-usage-report-generator-2024-final', 'xghp_short']) {
      expect(redact(input).text).toBe(input);
    }
  });
});

describe('HIGH 3: private-key lines when the BEGIN marker is not in the text', () => {
  const lines = [FAKE.pkLine1, FAKE.pkLine2];

  it('masks key body lines in a hunk that starts inside a key and ends at the END marker', () => {
    const input = [
      '@@ -20,4 +20,5 @@',
      ` ${lines[0]}`,
      ` ${lines[1]}`,
      ` ${FAKE.pkLine1.slice(0, 22)}==`,
      ` ${FAKE.pkEnd}`,
      '+an added line after the key',
    ].join('\n');
    const result = redact(input);
    const out = result.text.split('\n');
    expect(out).toEqual([
      '@@ -20,4 +20,5 @@',
      ` ${REDACTED}`,
      ` ${REDACTED}`,
      ` ${REDACTED}`,
      ` ${FAKE.pkEnd}`,
      '+an added line after the key',
    ]);
    expect(result.count).toBeGreaterThan(0);
    expect(result.kinds).toContain('private-key');
  });

  it('masks a hunk that lies entirely inside a key (no markers at all)', () => {
    const input = ['@@ -5,3 +5,3 @@', ` ${lines[0]}`, `-${lines[1]}`, `+${lines[0]}`].join('\n');
    const result = redact(input);
    expect(result.text.split('\n')).toEqual(['@@ -5,3 +5,3 @@', ` ${REDACTED}`, `-${REDACTED}`, `+${REDACTED}`]);
    expect(result.count).toBe(1); // one run of key material
  });

  it('does not mask ordinary code or short base64-looking words before an END marker', () => {
    const input = ['+const x = 1;', '+function', ` ${FAKE.pkEnd}`].join('\n');
    expect(redact(input).text).toBe(input);
  });

  it('does not mask hashes, identifiers or other long lines that are not base64 key material', () => {
    for (const line of [
      `+${'0123456789abcdef'.repeat(4)}`,
      `+${'a'.repeat(70)}`,
      `+${'someVeryLongCamelCaseIdentifierNameThatKeepsGoingAndGoingForeverAndEver'}`,
      '+Zm9vYmFy',
      ` sha512-${'AbC1'.repeat(20)}==`,
    ]) {
      expect(redact(line).text, line).toBe(line);
    }
  });

  it('keeps hunk headers when a key spans two hunks', () => {
    const input = [
      `+${FAKE.pkBegin}`,
      `+${lines[0]}`,
      '@@ -40,3 +41,3 @@',
      `+${lines[1]}`,
      `+${FAKE.pkEnd}`,
    ].join('\n');
    expect(redact(input).text.split('\n')).toEqual([
      `+${FAKE.pkBegin}`,
      `+${REDACTED}`,
      '@@ -40,3 +41,3 @@',
      `+${REDACTED}`,
      `+${FAKE.pkEnd}`,
    ]);
  });

  it('is idempotent for the new cases too', () => {
    const input = ['@@ -1,3 +1,3 @@', ` ${lines[0]}`, ` ${lines[1]}`, ` ${FAKE.pkEnd}`].join('\n');
    const once = redact(input);
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });
});

describe('HIGH 4: token formats that used to have no rule', () => {
  it.each([
    ['Hugging Face token', 'huggingface-token', FAKE.huggingFace],
    ['Slack incoming webhook URL', 'slack-webhook', FAKE.slackWebhook],
    ['Discord webhook URL', 'discord-webhook', FAKE.discordWebhook],
    ['Google OAuth access token', 'google-oauth-token', FAKE.googleOAuth],
    ['SendGrid key', 'sendgrid-key', FAKE.sendGrid],
    ['PyPI token', 'pypi-token', FAKE.pypi],
    ['DigitalOcean token', 'digitalocean-token', FAKE.digitalOcean],
    ['Shopify token', 'shopify-token', FAKE.shopify],
    ['Docker Hub token', 'dockerhub-token', FAKE.dockerHub],
    ['HashiCorp Vault token', 'vault-token', FAKE.vault],
  ])('masks a %s', (_label, kind, secret) => {
    const result = redact(`+  const value = "${secret}"; // note`);
    expect(result.text).not.toContain(secret);
    expect(result.kinds).toContain(kind);
    expect(result.text.endsWith('"; // note')).toBe(true);
  });

  it('does not mask look-alikes of the new formats', () => {
    for (const input of [
      'hf_short',
      'https://hooks.slack.com/docs',
      'https://discord.com/api/users/@me',
      'ya29.short',
      'SG.not.long',
      'pypi-AgEI',
      'shpat_xyz',
      'hvs.short',
      'dop_v1_short',
    ]) {
      expect(redact(input).text, input).toBe(input);
    }
  });
});

describe('HIGH 5: sensitive file names that used to be missed', () => {
  it.each([
    '.env_backup',
    '.env-local',
    '.env~',
    '.env.local.bak',
    'env.production',
    'env.local',
    'secrets.json',
    'secrets.yml',
    'config/secrets.yaml',
    'my-secrets.toml',
    'credentials.json',
    'credentials.yml',
    'service-account.json',
    'service_account_prod.json',
    'client_secret_1234.json',
    'terraform.tfvars.json',
    'prod.auto.tfvars',
    'kubeconfig',
    '.kube/config',
    '.docker/config.json',
    '.yarnrc.yml',
    '.yarnrc',
    '.dockercfg',
    '.s3cfg',
    '.boto',
    '.my.cnf',
    '.vault-token',
    'deploy.ppk',
    'AuthKey_ABC123.p8',
    'vault.kdbx',
    'my_id_rsa',
    'backup/id_ed25519.old',
    'keys.pem.bak',
    'server.key~',
    'wp-config.php',
    'local.settings.json',
  ])('flags %s as sensitive', (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    'src/secrets.ts',
    'src/credentials.ts',
    'src/secret-santa.ts',
    'src/env.ts',
    'src/env.d.ts',
    'config/environment.ts',
    '.environment.ts',
    '.envoy.yaml',
    'docs/secrets-management.md',
    'docs/credentials-guide.md',
    'README.md',
    'src/kube-client.ts',
    'src/service-account.ts',
    'config/kubeconfig.ts',
    'id_rsa.pub',
    'backup/id_ed25519.pub',
    'src/keys.ts',
    'src/docker/config.ts',
    'src/wp-config-reader.ts',
  ])('does not flag %s', (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });
});

describe('MEDIUM: redact() must stay linear on hostile input (it runs in the shared extension host)', () => {
  const started = (): number => Date.now();

  it('handles a megabyte of repeated eyJ- without going quadratic (JWT rule)', () => {
    const t = started();
    redact(`+${'eyJ-'.repeat(250_000)}`);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('handles a megabyte of repeated BEGIN markers on one line (one-line key rule)', () => {
    const t = started();
    redact(`+${PEM_BEGIN.repeat(37_000)}`);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('handles a megabyte of repeated BEGIN markers with spaces in the key type', () => {
    const t = started();
    redact(`+${'-----BEGIN A A A A A A A A A A A A A-----'.repeat(25_000)}`);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('handles a megabyte of repeated keywords and unterminated quotes', () => {
    const t = started();
    redact(`+${'password="'.repeat(100_000)}`);
    redact(`+${'<password>'.repeat(100_000)}`);
    redact(`+${'--password '.repeat(90_000)}`);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('still masks a real JWT and a real one-line key near hostile padding', () => {
    const jwt = `${'eyJ-'.repeat(1000)} ${FAKE.jwt}`;
    expect(redact(jwt).text).not.toContain(FAKE.jwt);
    const oneLine = `${PEM_BEGIN.repeat(100)} ${FAKE.pkBegin}\\n${FAKE.pkLine1}\\n${FAKE.pkEnd}`;
    expect(redact(oneLine).text).not.toContain(FAKE.pkLine1);
  });
});
