import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const group = process.argv[2];
if (group !== 'fast' && group !== 'integration') {
  console.error('Usage: node scripts/run-test-group.mjs <fast|integration>');
  process.exit(2);
}

const integrationFiles = new Set([
  'bridge.test.js',
  'browser-playwright.test.js',
  'browser-runtime.test.js',
  'browser-tools.test.js',
  'control.test.js',
  'cross-process-lock.test.js',
  'dynamic-mcp-oauth-http.test.js',
  'native-process-backend.test.js',
  'observation-store-cross-process.test.js'
]);

const testRoot = path.resolve('dist', 'tests');
const all = (await readdir(testRoot))
  .filter(name => name.endsWith('.test.js'))
  .sort();

const selected = all.filter(name =>
  group === 'integration'
    ? integrationFiles.has(name)
    : !integrationFiles.has(name)
);

if (selected.length === 0) {
  console.error(`TEST_GROUP_EMPTY=${group}`);
  process.exit(1);
}

console.log(`TEST_GROUP=${group}`);
console.log(`TEST_GROUP_FILES=${selected.length}`);

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-concurrency=4',
    ...selected.map(name => path.join('dist', 'tests', name))
  ],
  {
    stdio: 'inherit',
    windowsHide: true
  }
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
