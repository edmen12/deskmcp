import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DynamicMcpHub } from '../src/dynamic-mcp-hub.js';
import { startHttpServer } from '../src/http-server.js';

async function withHub(run: (args: { hub: DynamicMcpHub; root: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-dynamic-mcp-'));
  const hub = new DynamicMcpHub(path.join(root, 'mcp-hub'));
  await hub.init();
  try {
    await run({ hub, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('dynamic MCP registry rejects insecure remote HTTP and embedded credentials', async () => {
  await withHub(async ({ hub }) => {
    await assert.rejects(
      hub.addServer({ name: 'remote', url: 'http://example.com/mcp' }),
      /remote URLs must use HTTPS/i
    );
    await assert.rejects(
      hub.addServer({ name: 'creds', url: 'https://user:pass@example.com/mcp' }),
      /must not contain embedded credentials/i
    );
    await assert.rejects(
      hub.addServer({
        name: 'bad-header',
        url: 'https://example.com/mcp',
        header_env: { Host: 'MCP_SECRET' }
      }),
      /reserves HTTP header/i
    );
  });
});

test('dynamic MCP registry persists only secret environment names, never secret values', async () => {
  await withHub(async ({ hub }) => {
    const previous = process.env.DESKMCP_DYNAMIC_TEST_SECRET;
    process.env.DESKMCP_DYNAMIC_TEST_SECRET = 'super-secret-value-that-must-not-persist';
    try {
      await hub.addServer({
        name: 'secure',
        url: 'https://example.com/mcp',
        header_env: { Authorization: 'DESKMCP_DYNAMIC_TEST_SECRET' },
        enabled: false
      });
      const registry = await readFile(path.join(hub.root, 'servers.json'), 'utf8');
      assert.match(registry, /DESKMCP_DYNAMIC_TEST_SECRET/u);
      assert.doesNotMatch(registry, /super-secret-value-that-must-not-persist/u);
    } finally {
      if (previous === undefined) delete process.env.DESKMCP_DYNAMIC_TEST_SECRET;
      else process.env.DESKMCP_DYNAMIC_TEST_SECRET = previous;
    }
  });
});

test('dynamic MCP refresh, cached search, inspect, and live call work through one facade registry', async () => {
  const upstream = await startHttpServer('127.0.0.1', 0);
  try {
    await withHub(async ({ hub }) => {
      const added = await hub.addServer({
        name: 'local-test',
        description: 'DeskMCP safe test MCP',
        url: `${upstream.url}/mcp`,
        timeout_ms: 5000
      });
      assert.equal((added as { name: string }).name, 'local-test');

      const refreshed = await hub.refresh('local-test');
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0]?.ok, true);
      assert.ok((refreshed[0]?.tool_count ?? 0) >= 3);

      const search = await hub.searchTools('ping', 'local-test', 10);
      assert.equal(search.some(tool => tool.qualified_name === 'local-test:desktop_ping'), true);

      const inspected = await hub.inspectTool('local-test:desktop_ping');
      assert.equal(inspected.tool_name, 'desktop_ping');
      assert.ok(inspected.input_schema);

      const called = await hub.callTool('local-test:desktop_ping', {}) as {
        name: string;
        result: { content?: Array<{ type?: string; text?: string }> };
      };
      assert.equal(called.name, 'local-test:desktop_ping');
      const text = called.result.content?.find(item => item.type === 'text')?.text;
      assert.ok(text);
      const payload = JSON.parse(text!) as { ok: boolean; mode: string };
      assert.equal(payload.ok, true);
      assert.equal(payload.mode, 'safe-test');

      const reloaded = new DynamicMcpHub(hub.root);
      await reloaded.init();
      const persistedSearch = await reloaded.searchTools('read test', 'local-test', 10);
      assert.equal(persistedSearch.some(tool => tool.tool_name === 'desktop_read_test'), true);
    });
  } finally {
    await upstream.close();
  }
});

test('disabled dynamic MCP server cannot be called', async () => {
  const upstream = await startHttpServer('127.0.0.1', 0);
  try {
    await withHub(async ({ hub }) => {
      await hub.addServer({ name: 'disabled', url: `${upstream.url}/mcp`, enabled: false });
      await assert.rejects(hub.callTool('disabled:desktop_ping', {}), /disabled/i);
    });
  } finally {
    await upstream.close();
  }
});


test('dynamic MCP registry serializes concurrent mutations across Hub instances', async () => {
  await withHub(async ({ hub }) => {
    const second = new DynamicMcpHub(hub.root);
    await second.init();
    await Promise.all([
      hub.addServer({ name: 'alpha', url: 'https://alpha.example.com/mcp', enabled: false }),
      second.addServer({ name: 'beta', url: 'https://beta.example.com/mcp', enabled: false })
    ]);
    const names = (await hub.listServers() as Array<{ name: string }>).map(item => item.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
  });
});

test('dynamic MCP refresh never writes stale discovery into a replaced same-name server', async () => {
  const upstream = await startHttpServer('127.0.0.1', 0);
  try {
    await withHub(async ({ hub }) => {
      await hub.addServer({ name: 'replaceable', url: `${upstream.url}/mcp`, timeout_ms: 5000 });
      let releasePersist!: () => void;
      let reachedPersist!: () => void;
      const persistGate = new Promise<void>(resolve => { releasePersist = resolve; });
      const persistReached = new Promise<void>(resolve => { reachedPersist = resolve; });
      const refreshing = new DynamicMcpHub(hub.root, {
        beforePersistRefresh: async () => {
          reachedPersist();
          await persistGate;
        }
      });
      await refreshing.init();

      const refreshPromise = refreshing.refresh('replaceable');
      await persistReached;
      await hub.removeServer('replaceable');
      await hub.addServer({ name: 'replaceable', url: 'https://replacement.example.com/mcp', enabled: false });
      releasePersist();

      const result = await refreshPromise;
      assert.equal(result[0]?.ok, false);
      assert.match(result[0]?.error ?? '', /configuration changed.*stale discovery was not persisted/i);
      const servers = await hub.listServers() as Array<{ name: string; url: string; tool_count: number }>;
      const replacement = servers.find(server => server.name === 'replaceable');
      assert.equal(replacement?.url, 'https://replacement.example.com/mcp');
      assert.equal(replacement?.tool_count, 0);
    });
  } finally {
    await upstream.close();
  }
});

test('dynamic MCP registry fails closed on cached tool identity tampering', async () => {
  await withHub(async ({ hub }) => {
    await hub.addServer({ name: 'cached', url: 'https://example.com/mcp', enabled: false });
    const registryPath = path.join(hub.root, 'servers.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
      servers: Array<{ name: string; tools: unknown[] }>;
    };
    registry.servers[0]!.tools = [{
      qualified_name: 'other:desktop_ping',
      server: 'cached',
      tool_name: 'desktop_ping',
      input_schema: { type: 'object' }
    }];
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await assert.rejects(hub.listServers(), /cached tool identity mismatch/i);
  });
});
