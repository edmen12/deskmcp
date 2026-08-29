import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpServer } from '../src/http-server.js';
import { WRITE_TEST_FILE } from '../src/paths.js';

test('safe-test MCP endpoint lists and executes only the three test tools', async () => {
  await rm(WRITE_TEST_FILE, { force: true });
  const running = await startHttpServer('127.0.0.1', 0);
  const client = new Client(
    { name: 'deskmcp-test', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } }
  );

  try {
    const health = await fetch(`${running.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);

    await client.connect(new StreamableHTTPClientTransport(
      new URL(`${running.url}/mcp`)
    ));

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(tool => tool.name).sort(),
      ['desktop_ping', 'desktop_read_test', 'desktop_write_test']
    );

    const ping = await client.callTool({ name: 'desktop_ping', arguments: {} });
    assert.equal(ping.isError, undefined);

    const read = await client.callTool({
      name: 'desktop_read_test',
      arguments: {}
    });
    assert.equal(read.isError, undefined);
    assert.match(JSON.stringify(read.content), /DESKTOP_MCP_READ_TEST_OK/);

    const marker = `WRITE_E2E_${Date.now()}`;
    const write = await client.callTool({
      name: 'desktop_write_test',
      arguments: { content: marker }
    });
    assert.equal(write.isError, undefined);
    assert.equal(await readFile(WRITE_TEST_FILE, 'utf8'), marker);
  } finally {
    await client.close();
    await running.close();
  }
});
