import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_AREA } from '../src/paths.js';

test('independent Node processes sharing the workspace mutation lock cannot both write one observed version', async () => {
  const root = path.join(TEST_AREA, 'obs-real-cross-process');
  const file = path.join(root, 'shared.txt');
  const lockRoot = path.join(root, 'locks');
  const readyDir = path.join(root, 'ready');
  const gatePath = path.join(root, 'start.gate');
  await rm(root, { recursive: true, force: true });
  await mkdir(readyDir, { recursive: true });
  await writeFile(file, 'base', 'utf8');

  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'observation-store-cross-process-worker.js');
  const workers = ['a', 'b'].map(workerId => {
    const child = spawn(process.execPath, [workerPath, file, lockRoot, readyDir, gatePath, workerId], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    return {
      child,
      result: new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
      })
    };
  });

  try {
    const deadline = Date.now() + 15_000;
    while ((await readdir(readyDir)).length < workers.length) {
      if (Date.now() >= deadline) {
        for (const worker of workers) worker.child.kill();
        throw new Error('observation-store workers did not both become ready before timeout.');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    await writeFile(gatePath, 'go\n', { encoding: 'utf8', flag: 'wx' });
    const results = await Promise.all(workers.map(worker => worker.result));
    assert.deepEqual(
      results.filter(result => result.code !== 0 || result.signal !== null)
        .map(result => ({ code: result.code, signal: result.signal, stdout: result.stdout.trim(), stderr: result.stderr.trim() })),
      []
    );

    const outcomes = results.flatMap(result => result.stdout.trim().split(/\r?\n/u).filter(Boolean)).sort();
    assert.equal(outcomes.filter(line => line.startsWith('SUCCESS:')).length, 1, `expected one writer, got ${JSON.stringify(outcomes)}`);
    assert.equal(outcomes.filter(line => line.startsWith('STALE:')).length, 1, `expected one stale writer, got ${JSON.stringify(outcomes)}`);
    assert.match(await readFile(file, 'utf8'), /^worker-[ab]$/u);
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await rm(root, { recursive: true, force: true });
  }
});
