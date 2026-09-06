import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const dist = path.resolve(projectRoot, 'dist');
if (path.dirname(dist) !== projectRoot || path.basename(dist) !== 'dist') {
  throw new Error(`Refusing to clean unexpected build output: ${dist}`);
}
await rm(dist, { recursive: true, force: true });
console.log('DIST_CLEAN=OK');
