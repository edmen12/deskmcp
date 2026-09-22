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

test('dynamic MCP registry persists OAuth metadata but never OAuth credentials', async () => {
  await withHub(async ({ hub }) => {
    const added = await hub.addServer({
      name: 'oauth-metadata',
      url: 'https://example.com/mcp',
      oauth: true,
      oauth_scope: 'admin read write admin',
      enabled: false
    }) as { oauth?: { enabled: boolean; scope?: string } };
    assert.deepEqual(added.oauth, { enabled: true, scope: 'admin read write' });

    const registry = await readFile(path.join(hub.root, 'servers.json'), 'utf8');
    assert.match(registry, /"oauth"/u);
    assert.match(registry, /"scope": "admin read write"/u);
    assert.doesNotMatch(registry, /access_token|refresh_token|code_verifier|github-client-secret/iu);

    const updated = await hub.setOAuth('oauth-metadata', true) as {
      oauth?: { enabled: boolean; scope?: string };
    };
    assert.deepEqual(updated.oauth, { enabled: true });
  });
});

test('dynamic MCP registry supports static OAuth clients through environment variable references only', async () => {
  await withHub(async ({ hub }) => {
    const added = await hub.addServer({
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      oauth: true,
      oauth_scope: 'read:user repo',
      oauth_client_id: 'github-oauth-client-id',
      oauth_client_secret_env: 'DESKMCP_GITHUB_OAUTH_CLIENT_SECRET',
      enabled: false
    }) as {
      oauth?: {
        enabled: boolean;
        scope?: string;
        static_client?: {
          client_id: string;
          client_secret_env?: string;
          token_endpoint_auth_method: string;
        };
      };
    };
    assert.deepEqual(added.oauth, {
      enabled: true,
      scope: 'read:user repo',
      static_client: {
        client_id: 'github-oauth-client-id',
        client_secret_env: 'DESKMCP_GITHUB_OAUTH_CLIENT_SECRET',
        token_endpoint_auth_method: 'client_secret_post'
      }
    });

    const registry = await readFile(path.join(hub.root, 'servers.json'), 'utf8');
    assert.match(registry, /DESKMCP_GITHUB_OAUTH_CLIENT_SECRET/u);
    assert.doesNotMatch(registry, /github-client-secret/u);

    await assert.rejects(
      hub.addServer({
        name: 'invalid-static-client',
        url: 'https://example.com/mcp',
        oauth: true,
        oauth_client_secret_env: 'DESKMCP_GITHUB_OAUTH_CLIENT_SECRET'
      }),
      /require oauth_client_id/i
    );

    const tamperedRegistryPath = path.join(hub.root, 'servers.json');
    const tampered = JSON.parse(await readFile(tamperedRegistryPath, 'utf8')) as {
      servers: Array<{ oauth?: { static_client?: Record<string, unknown> } }>;
    };
    tampered.servers[0]!.oauth!.static_client!.client_secret = 'github-client-secret';
    await writeFile(tamperedRegistryPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    await assert.rejects(hub.listServers(), /must reference a secret environment variable/i);
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
      const healthy = (await hub.listServers() as Array<{
        name: string;
        last_health_status?: string;
        last_health_at?: string;
        last_health_error?: string;
      }>).find(server => server.name === 'local-test');
      assert.equal(healthy?.last_health_status, 'ok');
      assert.ok(healthy?.last_health_at);
      assert.equal(healthy?.last_health_error, undefined);

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

test('dynamic MCP refresh persists a failed live health check instead of presenting stale cache as healthy', async () => {
  const upstream = await startHttpServer('127.0.0.1', 0);
  const url = `${upstream.url}/mcp`;
  await upstream.close();

  await withHub(async ({ hub }) => {
    await hub.addServer({ name: 'offline', url, timeout_ms: 1000 });
    const refreshed = await hub.refresh('offline');
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]?.ok, false);
    assert.ok(refreshed[0]?.error);

    const offline = (await hub.listServers() as Array<{
      name: string;
      last_health_status?: string;
      last_health_at?: string;
      last_health_error?: string;
    }>).find(server => server.name === 'offline');
    assert.equal(offline?.last_health_status, 'error');
    assert.ok(offline?.last_health_at);
    assert.ok(offline?.last_health_error);
  });
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
