import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SCAN_ROOTS = [
  'src',
  'tests',
  'scripts',
  'control-panel',
  'installer',
  'process-host',
  'agent-desktop-host'
];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.cs', '.ps1', '.rs', '.swift']);
const SELF = path.resolve(ROOT, 'scripts', 'check-open-task-markers.mjs');
const MARKERS = /\b(?:TODO|FIXME|HACK|XXX)\b/u;

async function* filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'bin' || entry.name === 'obj' || entry.name === 'node_modules') continue;
      yield* filesUnder(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    yield full;
  }
}

const findings = [];
for (const relativeRoot of SCAN_ROOTS) {
  const scanRoot = path.resolve(ROOT, relativeRoot);
  for await (const file of filesUnder(scanRoot)) {
    if (path.resolve(file) === SELF) continue;
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index++) {
      if (MARKERS.test(lines[index] ?? '')) {
        findings.push(`${path.relative(ROOT, file)}:${index + 1}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('OPEN_TASK_MARKERS_FOUND');
  for (const finding of findings) console.error(finding);
  console.error('Move unfinished work to Task Room / GitHub Issue, or rewrite the comment as a factual invariant.');
  process.exit(1);
}

console.log('OPEN_TASK_MARKERS_OK');
