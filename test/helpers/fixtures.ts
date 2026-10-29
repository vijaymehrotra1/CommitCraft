import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillFakeSecrets } from './fakeSecrets';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Loads a real `git diff --cached` capture from test/fixtures (see scripts/make-fixtures.sh). */
export function loadFixture(name: string): string {
  return fillFakeSecrets(readFileSync(join(FIXTURE_DIR, `${name}.diff`), 'utf8'));
}

/** Builds a large, realistic-looking diff: `fileCount` source files with `linesPerFile` added lines. */
export function makeHugeDiff(fileCount: number, linesPerFile: number): string {
  const sections: string[] = [];
  for (let f = 0; f < fileCount; f++) {
    const lines: string[] = [];
    for (let i = 0; i < linesPerFile; i++) {
      lines.push(`+export const value${f}_${i} = computeSomething(${i}, 'generated line ${i}');`);
    }
    sections.push(
      [
        `diff --git a/src/generated/file${f}.ts b/src/generated/file${f}.ts`,
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        `+++ b/src/generated/file${f}.ts`,
        `@@ -0,0 +1,${linesPerFile} @@`,
        ...lines,
      ].join('\n'),
    );
  }
  return sections.join('\n') + '\n';
}
