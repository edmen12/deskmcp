import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ObservationStore, StaleObservationError } from '../src/observation-store.js';

const args = process.argv.slice(2);
if (args.length !== 5 || args.some(value => value.length === 0)) {
  throw new Error('observation-store worker arguments are incomplete.');
}
const [filePath, lockRoot, readyDir, gatePath, workerId] = args as [string, string, string, string, string];

async function waitForGate(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await stat(gatePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error('observation-store worker timed out waiting for start gate.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const store = new ObservationStore(1024 * 1024, 1024, lockRoot);
const observation = await store.observe(filePath);
await writeFile(path.join(readyDir, `${workerId}.ready`), `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
await waitForGate();

try {
  await store.withObservedMutation(filePath, observation.observationId, async () => {
    // Widen the race window. Without a shared cross-process lock both workers can
    // validate the same old version before either write reaches disk.
    await new Promise(resolve => setTimeout(resolve, 75));
    await writeFile(filePath, `worker-${workerId}`, 'utf8');
  });
  process.stdout.write(`SUCCESS:${workerId}\n`);
} catch (error) {
  if (error instanceof StaleObservationError) {
    process.stdout.write(`STALE:${workerId}\n`);
  } else {
    throw error;
  }
}
