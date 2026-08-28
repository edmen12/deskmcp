import path from 'node:path';
import { fileURLToPath } from 'node:url';

const compiledSrcDir = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(compiledSrcDir, '..', '..');
export const TEST_AREA = path.join(PROJECT_ROOT, 'test-area');
export const READ_TEST_FILE = path.join(TEST_AREA, 'test.txt');
export const WRITE_TEST_FILE = path.join(TEST_AREA, 'plugin-write-test.txt');
