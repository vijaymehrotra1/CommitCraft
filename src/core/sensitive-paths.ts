// Which files are never sent at all, even redacted. Pure: no VS Code, no I/O.

const KEY_EXTENSIONS = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.p8',
  '.kdbx',
  '.kdb',
  '.pkcs12',
  '.tfstate',
  '.tfstate.backup',
  '.tfvars',
  '.tfvars.json',
];

const SENSITIVE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
  '.yarnrc',
  '.yarnrc.yml',
  '.dockercfg',
  '.s3cfg',
  '.boto',
  '.my.cnf',
  '.vault-token',
  '.envrc',
  'credentials',
  'kubeconfig',
  'wp-config.php',
  'local.settings.json',
]);

/** Data/config formats. A `secrets.json` is a secret file; a `secrets.ts` is source code about secrets. */
const DATA_FILE = /\.(?:json|ya?ml|toml|ini|properties|conf|cfg|xml|txt|plist|env)$/;

/** Editors and people leave `.bak`, `.old`, `~` copies of secret files behind. */
const BACKUP_SUFFIX = /(?:\.(?:bak|old|orig|backup|save|tmp|swp|copy)|~)$/;

function withoutBackupSuffix(name: string): string {
  let result = name;
  for (let i = 0; i < 2 && BACKUP_SUFFIX.test(result); i++) {
    result = result.replace(BACKUP_SUFFIX, '');
  }
  return result;
}

function isSensitiveName(name: string): boolean {
  return (
    SENSITIVE_NAMES.has(name) ||
    /^\.env(?:$|[._~-])/.test(name) ||
    /^env\.(?:production|prod|staging|stage|local|development|dev|test|secrets?)$/.test(name) ||
    name.endsWith('.env') ||
    KEY_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
    (/id_(?:rsa|dsa|ecdsa|ed25519)/.test(name) && !name.endsWith('.pub')) ||
    (name.includes('secret') && DATA_FILE.test(name)) ||
    (name.includes('credential') && DATA_FILE.test(name)) ||
    (/service[-_]?account/.test(name) && name.endsWith('.json'))
  );
}

/** Files whose content must never be sent, even redacted: env files, keys, certificates, credentials. */
export function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const name = normalized.split('/').pop() ?? '';
  return (
    isSensitiveName(name) ||
    isSensitiveName(withoutBackupSuffix(name)) ||
    /(?:^|\/)\.kube\/config$/.test(normalized) ||
    /(?:^|\/)\.docker\/config\.json$/.test(normalized)
  );
}
