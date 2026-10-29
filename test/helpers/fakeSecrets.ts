// Every value here is FAKE. They are assembled from fragments at runtime so that no secret-shaped
// string exists in the repository (secret scanners and push protection match on format, not intent).

const join = (...parts: string[]): string => parts.join('');

export const FAKE = {
  awsAccessKey: join('AKIA', 'FAKEFAKE', 'FAKE1234'),
  awsSecretKey: join('FAKE', 'aws/secret+key', 'FAKE0123456789', 'abcdefghij'),
  anthropicKey: join('sk-ant-', 'api03-', 'FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-FAKE'),
  openAiKey: join('sk-', 'proj-', 'FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_1234'),
  openAiLegacyKey: join('sk-', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234FAKE'),
  githubToken: join('gh', 'p_', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234'),
  githubFineGrained: join('github', '_pat_', 'FAKEFAKEFAKEFAKEFAKEFAKE_FAKEFAKEFAKE'),
  gitlabToken: join('gl', 'pat-', 'FAKEFAKEFAKEFAKE1234'),
  slackToken: join('xo', 'xb-', '0000000000-FAKEFAKEFAKE'),
  stripeKey: join('sk_', 'live_', 'FAKEFAKEFAKEFAKE1234'),
  googleKey: join('AI', 'za', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123'.slice(0, 35)),
  npmToken: join('npm', '_', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234'),
  jwt: [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiJGQUtFIiwibmFtZSI6IkZBS0UifQ',
    'FAKESIGNATUREFAKESIGNATURE12345',
  ].join('.'),
  dbPassword: 'FAKE-db-p4ssw0rd!',
  sessionSecret: 'FAKE-session-s3cret-value-0001',
  huggingFace: join('hf', '_', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'),
  slackWebhook: join('https://hooks.slack.', 'com/services/', 'T0FAKE000', '/B0FAKE000', '/', 'FAKEFAKEFAKEFAKEFAKE1234'),
  discordWebhook: join('https://discord', '.com/api/webhooks/', '123456789012345678', '/', 'FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_FAKE-1234'),
  googleOAuth: join('ya29', '.', 'FAKE-FAKE-FAKE-FAKE-FAKE-FAKE0123'),
  sendGrid: join('SG', '.', 'FAKEFAKEFAKEFAKE1234', '.', 'FAKEFAKEFAKEFAKEFAKEFAKE1234'),
  pypi: join('pypi', '-AgEI', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'),
  digitalOcean: join('dop', '_v1_', 'abcdef0123456789'.repeat(4)),
  shopify: join('shp', 'at_', 'abcdef0123456789'.repeat(2)),
  dockerHub: join('dckr', '_pat_', 'FAKEFAKEFAKEFAKE_1234'),
  vault: join('hvs', '.', 'FAKEFAKEFAKEFAKEFAKEFAKE1234'),
  pkBegin: join('-----BEGIN ', 'RSA PRIVATE KEY', '-----'),
  // Realistic PEM body lines: mixed case, digits, '+' and '/', 64 to 70 characters.
  pkLine1: join('MIIEFAKE', 'keyFAKE01', '23456789+/', 'abcdefFAKE', '0123456789', 'ABCDEFGHIJ', 'KLMNOPQRST'),
  pkLine2: join('QRSTUVwxyz', 'FAKE/+0123', '456789abcd', 'efFAKEGHIJ', 'klmnop0123', 'FAKEqrstuv', 'WXYZ+/FAKE'),
  pkEnd: join('-----END ', 'RSA PRIVATE KEY', '-----'),
} as const;

/** Replaces the {{FAKE_...}} placeholders used by the fixture diffs with runtime-built fakes. */
export function fillFakeSecrets(text: string): string {
  const map: Record<string, string> = {
    FAKE_AWS_ACCESS_KEY: FAKE.awsAccessKey,
    FAKE_ANTHROPIC_KEY: FAKE.anthropicKey,
    FAKE_GITHUB_TOKEN: FAKE.githubToken,
    FAKE_JWT: FAKE.jwt,
    FAKE_DB_PASSWORD: FAKE.dbPassword,
    FAKE_SESSION_SECRET: FAKE.sessionSecret,
    FAKE_PK_BEGIN: FAKE.pkBegin,
    FAKE_PK_LINE_1: FAKE.pkLine1,
    FAKE_PK_LINE_2: FAKE.pkLine2,
    FAKE_PK_END: FAKE.pkEnd,
  };
  return text.replace(/\{\{(FAKE_[A-Z0-9_]+)\}\}/g, (match, name: string) => map[name] ?? match);
}
