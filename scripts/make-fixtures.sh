#!/usr/bin/env bash
# Regenerates test/fixtures/*.diff from REAL `git diff --cached` output so the parser is tested
# against what git actually emits (rename headers, quoted paths, binary markers, mode changes...).
#
# Usage: scripts/make-fixtures.sh [output-dir]      (default: test/fixtures)
#
# Secret-looking values are NOT written here. secrets.diff contains {{FAKE_...}} placeholders that
# test/helpers/fakeSecrets.ts fills in at test time, so no secret-shaped string lives in the repo.
set -euo pipefail

OUT="$(cd "${1:-test/fixtures}" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

git init -q -b main .
git config user.email "fixtures@example.invalid"
git config user.name "Fixture Generator"
git config core.autocrlf false

mkdir -p src/auth src/utils src/legacy docs scripts config assets

cat > src/auth/session.ts <<'EOF'
import { randomUUID } from 'node:crypto';

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const sessions = new Map<string, Session>();

export function createSession(userId: string): Session {
  const session: Session = {
    id: randomUUID(),
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  const session = sessions.get(id);
  if (!session) {
    return undefined;
  }
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return undefined;
  }
  return session;
}

export function destroySession(id: string): void {
  sessions.delete(id);
}

export function countActiveSessions(): number {
  return sessions.size;
}
EOF

cat > src/utils/format.ts <<'EOF'
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
EOF

cat > src/legacy/helper.ts <<'EOF'
// Deprecated helper kept for the old report page.
export function legacyHelper(input: string): string {
  return input.trim().toLowerCase();
}
EOF

cat > docs/old-guide.md <<'EOF'
# Setup guide

1. Install dependencies.
2. Copy the sample configuration.
3. Start the server with `npm start`.
4. Open http://localhost:3000 in your browser.
5. Sign in with the demo account.
6. Create your first project.
7. Invite a teammate.
8. Read the troubleshooting section below.

## Troubleshooting

If the server does not start, check that port 3000 is free.
EOF

cat > README.md <<'EOF'
# Demo app

A small demo application.
EOF

cat > package.json <<'EOF'
{
  "name": "demo-app",
  "version": "1.0.0",
  "dependencies": {
    "left-pad": "^1.3.0"
  }
}
EOF

node -e '
const packages = { "": { name: "demo-app", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } } };
for (let i = 0; i < 40; i++) {
  packages[`node_modules/pkg-${i}`] = {
    version: `1.${i}.0`,
    resolved: `https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.${i}.0.tgz`,
    integrity: `sha512-FAKEINTEGRITY${String(i).padStart(4, "0")}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789==`,
  };
}
console.log(JSON.stringify({ name: "demo-app", version: "1.0.0", lockfileVersion: 3, packages }, null, 2));
' > package-lock.json

cat > scripts/build.sh <<'EOF'
#!/bin/sh
echo "building"
EOF

printf '[server]\r\nhost=localhost\r\nport=3000\r\n' > config/windows.ini

# a tiny valid-looking PNG header + payload (binary content)
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x10\x00\x00\x00\x10\x08\x06\x00\x00\x00' > assets/logo.png

git add -A
git commit -q -m "base"

reset() { git reset -q --hard HEAD && git clean -qfd; }
capture() { git add -A && git diff --cached > "$OUT/$1.diff"; reset; }

# 1. normal edit (two hunks in one file)
python3 - <<'EOF'
import re, pathlib
p = pathlib.Path("src/auth/session.ts")
s = p.read_text()
s = s.replace("const SESSION_TTL_MS = 60 * 60 * 1000;", "const SESSION_TTL_MS = 30 * 60 * 1000;")
s = s.replace("export function destroySession(id: string): void {\n  sessions.delete(id);\n}",
              "export function destroySession(id: string): boolean {\n  return sessions.delete(id);\n}")
p.write_text(s)
EOF
capture normal-edit

# 2. new file
cat > src/auth/password.ts <<'EOF'
import { scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export function verifyPassword(password: string, salt: string, expected: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
EOF
capture new-file

# 3. deleted file
git rm -q src/legacy/helper.ts
capture deleted-file

# 4. renamed file (with edits) and a pure rename (100% similarity)
git mv docs/old-guide.md docs/setup-guide.md
sed -i 's/^# Setup guide/# Getting started/' docs/setup-guide.md
git mv src/utils/format.ts src/utils/duration.ts
capture renamed-file

# 5. binary file (added) and modified
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x20\x00\x00\x00\x20\x08\x06\x00\x00\x00' > assets/banner.png
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x40\x00\x00\x00\x40\x08\x06\x00\x00\x00' > assets/logo.png
capture binary-file

# 6. lock file only
node -e '
const fs = require("fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
for (let i = 0; i < 10; i++) { lock.packages[`node_modules/pkg-${i}`].version = `2.${i}.0`; }
fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
'
capture lock-file

# 7. mode change only
chmod +x scripts/build.sh
capture mode-change

# 8. special paths (spaces, unicode -> git quotes them)
mkdir -p "docs/my notes" "docs/résumé"
echo "# Notes" > "docs/my notes/todo list.md"
echo "# Résumé" > "docs/résumé/café.md"
capture special-paths

# 9. CRLF file edit
printf '[server]\r\nhost=localhost\r\nport=8080\r\ntimeout=30\r\n' > config/windows.ini
capture crlf-edit

# 10. mixed, realistic commit: feature + test + dependency bump + asset + rename
cat > src/auth/password.ts <<'EOF'
import { scryptSync } from 'node:crypto';

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}
EOF
mkdir -p test
cat > test/password.test.ts <<'EOF'
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';

describe('hashPassword', () => {
  it('is deterministic for the same salt', () => {
    expect(hashPassword('pw', 'salt')).toBe(hashPassword('pw', 'salt'));
  });
});
EOF
node -e '
const fs = require("fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
lock.packages["node_modules/pkg-0"].version = "3.0.0";
fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
'
sed -i 's/"left-pad": "\^1.3.0"/"left-pad": "^1.3.0",\n    "vitest": "^3.2.0"/' package.json
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x30\x00\x00\x00\x30\x08\x06\x00\x00\x00' > assets/favicon.png
git mv src/utils/format.ts src/utils/duration.ts
capture mixed-commit

# 11. secrets: placeholders are substituted by test/helpers/fakeSecrets.ts (see header)
cat > .env <<'EOF'
DATABASE_URL=postgres://app:{{FAKE_DB_PASSWORD}}@db.internal:5432/app
SESSION_SECRET={{FAKE_SESSION_SECRET}}
EOF
mkdir -p deploy certs
cat > src/config.ts <<'EOF'
export const config = {
  region: 'us-east-1',
  awsAccessKeyId: '{{FAKE_AWS_ACCESS_KEY}}',
  anthropicApiKey: '{{FAKE_ANTHROPIC_KEY}}',
  githubToken: '{{FAKE_GITHUB_TOKEN}}',
  adminJwt: '{{FAKE_JWT}}',
  dbPassword: '{{FAKE_DB_PASSWORD}}',
  retries: 3,
  timeoutMs: 5000,
};
EOF
# One placeholder per line keeps every diff line (and its +/- prefix) intact after substitution.
cat > deploy/id_rsa <<'EOF'
{{FAKE_PK_BEGIN}}
{{FAKE_PK_LINE_1}}
{{FAKE_PK_LINE_2}}
{{FAKE_PK_END}}
EOF
cat > certs/server.pem <<'EOF'
{{FAKE_PK_BEGIN}}
{{FAKE_PK_LINE_1}}
{{FAKE_PK_LINE_2}}
{{FAKE_PK_END}}
EOF
cat > src/embedded-key.ts <<'EOF'
export const signingKey = `{{FAKE_PK_BEGIN}}
{{FAKE_PK_LINE_1}}
{{FAKE_PK_LINE_2}}
{{FAKE_PK_END}}`;
export const keyId = 'signing-key-2026';
EOF
cat > scripts/deploy.sh <<'EOF'
#!/bin/sh
export API_TOKEN={{FAKE_SESSION_SECRET}}
curl -H "Authorization: Bearer {{FAKE_SESSION_SECRET}}" https://deploy.example.invalid/run
EOF
capture secrets

# 12. empty diff (nothing staged)
: > "$OUT/empty.diff"

echo "Fixtures written to $OUT"
ls -l "$OUT"
