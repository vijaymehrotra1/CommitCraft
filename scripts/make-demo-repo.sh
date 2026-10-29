#!/usr/bin/env bash
# Builds a small repository for demoing CommitCraft (see docs/demo-script.md).
#
# Usage: scripts/make-demo-repo.sh [target-dir]      (default: /tmp/commitcraft-demo)
#
# Result: branch `main` with a few commits, then branch `feature/session-timeout` with two commits,
# plus STAGED changes that include a FAKE secret and a .env file, so you can show masking live.
# The fake secret is assembled from fragments here so no secret-shaped string is stored in the repo.
set -euo pipefail

TARGET="${1:-/tmp/commitcraft-demo}"
if [ -e "$TARGET" ]; then
  echo "Refusing to overwrite existing path: $TARGET (delete it or pass another directory)" >&2
  exit 1
fi
mkdir -p "$TARGET"
cd "$TARGET"

git init -q -b main .
git config user.email "demo@example.invalid"
git config user.name "Demo User"
git config commit.gpgsign false

mkdir -p src
cat > src/session.ts <<'EOF'
const SESSION_TTL_MS = 60 * 60 * 1000;
const sessions = new Map<string, { userId: string; expiresAt: number }>();

export function createSession(id: string, userId: string): void {
  sessions.set(id, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
}

export function getSession(id: string): string | undefined {
  const session = sessions.get(id);
  return session && session.expiresAt > Date.now() ? session.userId : undefined;
}
EOF
printf '# Demo app\n\nA tiny session store used to demo CommitCraft.\n' > README.md
git add -A && git commit -q -m "chore: initial commit"

git checkout -q -b feature/session-timeout
sed -i 's/60 \* 60 \* 1000/30 * 60 * 1000/' src/session.ts
git commit -q -am "fix: shorten session lifetime to 30 minutes"

cat >> src/session.ts <<'EOF'

export function destroySession(id: string): boolean {
  return sessions.delete(id);
}
EOF
git commit -q -am "feat: allow sessions to be destroyed"

# Staged work for the commit-message demo: a real change, plus things that must never be sent as-is.
cat > src/config.ts <<EOF
export const config = {
  region: 'eu-west-1',
  sessionTtlMinutes: 30,
  // FAKE demo credential for the redaction demo (not a real key):
  awsAccessKeyId: '$(printf 'AKIA%s%s' 'FAKEFAKE' 'FAKE1234')',
  apiToken: '$(printf 'gh%s%s' 'p_' 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234')',
};
EOF
printf 'SESSION_SECRET=demo-not-a-real-secret-value-0001\n' > .env
git add src/config.ts .env

cat <<EOF

Demo repository ready: $TARGET

  Open it in VS Code:        code "$TARGET"
  Commit-message demo:       staged changes are waiting (src/config.ts + .env). Click the sparkle button
                             in Source Control. The AWS key and token are masked; .env is not sent.
  PR-description demo:       run "CommitCraft: Generate PR Description" after committing the staged
                             work (or: git commit -m "feat: add config"). Base branch is main.
EOF
