// False-positive scan: runs redact() over real third-party source and reports every line it would change.
// Real code is the right corpus: it is full of `token`, `password`, `apiKey` and `secret` identifiers
// that are NOT secrets. Usage: npm run scan:fp [-- <dir> ...]   (default: node_modules)
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { redact } from '../src/core/redact';

const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);
const MAX_FILE_BYTES = 2_000_000;
const MAX_SAMPLES = 60;

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

let files = 0;
let lines = 0;
let changedLines = 0;
const samples: string[] = [];

function scan(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '.bin') {
        scan(path);
      }
      continue;
    }
    if (!EXTENSIONS.has(extname(entry.name)) || entry.name.endsWith('.map') || entry.name.endsWith('.min.js')) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES) {
      continue;
    }
    files++;
    const before = text.split('\n');
    lines += before.length;
    const result = redact(text);
    if (result.count === 0) {
      continue;
    }
    const after = result.text.split('\n');
    before.forEach((line, index) => {
      if (line !== after[index]) {
        changedLines++;
        if (samples.length < MAX_SAMPLES) {
          samples.push(`${relative('.', path)}:${index + 1}  ${line.trim().slice(0, 140)}`);
        }
      }
    });
  }
}

const roots = process.argv.slice(2);
for (const root of roots.length > 0 ? roots : ['node_modules']) {
  scan(root);
}
out(JSON.stringify({ files, lines, changedLines }));
out(samples.join('\n'));
