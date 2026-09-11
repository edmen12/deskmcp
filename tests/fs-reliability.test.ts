import assert from 'node:assert/strict';
import test from 'node:test';
import { renameFileWithRetry } from '../src/fs-reliability.js';

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test('renameFileWithRetry retries transient filesystem errors and eventually succeeds', async () => {
  let calls = 0;
  const delays: number[] = [];
  await renameFileWithRetry('source', 'destination', {
    maxRetries: 4,
    baseDelayMs: 5,
    maxDelayMs: 20,
    renameImpl: async () => {
      calls += 1;
      if (calls <= 3) throw fsError('EPERM');
    },
    sleepImpl: async delay => { delays.push(delay); }
  });
  assert.equal(calls, 4);
  assert.deepEqual(delays, [5, 10, 20]);
});

test('renameFileWithRetry fails immediately for non-transient errors', async () => {
  let calls = 0;
  await assert.rejects(
    renameFileWithRetry('source', 'destination', {
      renameImpl: async () => {
        calls += 1;
        throw fsError('ENOENT');
      },
      sleepImpl: async () => { throw new Error('sleep should not run'); }
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
  assert.equal(calls, 1);
});

test('renameFileWithRetry stops after the configured retry budget', async () => {
  let calls = 0;
  await assert.rejects(
    renameFileWithRetry('source', 'destination', {
      maxRetries: 2,
      renameImpl: async () => {
        calls += 1;
        throw fsError('EBUSY');
      },
      sleepImpl: async () => undefined
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBUSY'
  );
  assert.equal(calls, 3);
});
