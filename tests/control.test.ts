import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requestShutdown,
  startControlServer
} from '../src/control-server.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('local control pipe requests graceful shutdown without HTTP exposure', async () => {
  const port = 30000 + (process.pid % 30000);
  let shutdownCalls = 0;
  const server = await startControlServer(port, () => {
    shutdownCalls += 1;
  });

  try {
    const response = await requestShutdown(port, 2000);
    assert.equal(response, 'OK shutdown');
    await delay(50);
    assert.equal(shutdownCalls, 1);
  } finally {
    await server.close();
  }
});
