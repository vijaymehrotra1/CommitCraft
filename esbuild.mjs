// Bundles the extension (and, with --integration, the smoke tests; with --live-check, the live API check).
// Usage: node esbuild.mjs [--production] [--watch] [--integration] [--live-check] [--fp-scan]
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const integration = process.argv.includes('--integration');
const liveCheck = process.argv.includes('--live-check');
const fpScan = process.argv.includes('--fp-scan');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
let builds;
if (integration) {
  builds = [
    { ...shared, entryPoints: ['test/integration/runTest.ts'], outfile: 'out/test/runTest.js' },
    { ...shared, entryPoints: ['test/integration/suite/index.ts'], outfile: 'out/test/suite/index.js' },
  ];
} else if (liveCheck) {
  builds = [{ ...shared, entryPoints: ['scripts/live-check.ts'], outfile: 'out/live-check.js' }];
} else if (fpScan) {
  builds = [{ ...shared, entryPoints: ['scripts/fp-scan.ts'], outfile: 'out/fp-scan.js' }];
} else {
  builds = [{ ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' }];
}

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
