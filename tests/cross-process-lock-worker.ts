import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquirePidDirectoryLock } from '../src/cross-process-lock.js';

const args = process.argv.slice(2);
if (args.length !== 5 || args.some(value => value.length === 0)) {
  throw new Error('cross-process lock worker arguments are incomplete.');
}
const [lockDir, readyDir, gatePath, criticalDir, workerId] = args as [string, string, string, string, string];

async function waitForGate(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await stat(gatePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error('cross-process worker timed out waiting for start gate.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

await writeFile(path.join(readyDir, `${workerId}.ready`), `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
await waitForGate();

const lease = await acquirePidDirectoryLock(lockDir, {
  label: `cross-process worker ${workerId}`,
  timeoutMs: 30_000,
  pollMs: 2
});

let ownsCriticalMarker = false;
try {
  try {
    await mkdir(criticalDir);
    ownsCriticalMarker = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`cross-process critical section overlap detected by worker ${workerId}.`);
    }
    throw error;
  }
  await new Promise(resolve => setTimeout(resolve, 25));
} finally {
  if (ownsCriticalMarker) await rm(criticalDir, { recursive: true, force: true });
  await lease.release();
}
