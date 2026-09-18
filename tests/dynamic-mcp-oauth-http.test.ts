import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DynamicMcpHub } from '../src/dynamic-mcp-hub.js';
import { startHttpServer } from '../src/http-server.js';
import { MemorySecretStore } from '../src/secure-secret-store.js';

async function listen(server: http.Server): Promise<{ base: string; close(): Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function body(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('DeskMCP HTTP OAuth callback completes a pending Dynamic MCP authorization', async () => {
  let oauthBase = '';
  const oauthServer = http.createServer((req, res) => {
    void (async () => {
      const parsed = new URL(req.url ?? '/', oauthBase || 'http://127.0.0.1');
      if (parsed.pathname === '/mcp') {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${oauthBase}/.well-known/oauth-protected-resource"`
        });
        res.end();
        return;
      }
      if (parsed.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          resource: `${oauthBase}/mcp`,
          authorization_servers: [oauthBase],
          scopes_supported: ['read', 'write', 'admin']
        }));
        return;
      }
      if (
        parsed.pathname.startsWith('/.well-known/oauth-authorization-server') ||
        parsed.pathname.startsWith('/.well-known/openid-configuration')
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          issuer: oauthBase,
          authorization_endpoint: `${oauthBase}/authorize`,
          token_endpoint: `${oauthBase}/token`,
          registration_endpoint: `${oauthBase}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['read', 'write', 'admin']
        }));
        return;
      }
      if (parsed.pathname === '/register' && req.method === 'POST') {
        const metadata = JSON.parse(await body(req)) as Record<string, unknown>;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ...metadata,
          client_id: 'deskmcp-http-test-client',
          client_id_issued_at: Math.floor(Date.now() / 1000)
        }));
        return;
      }
      if (parsed.pathname === '/token' && req.method === 'POST') {
        await body(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'http-test-access-secret',
          token_type: 'Bearer',
          refresh_token: 'http-test-refresh-secret',
          expires_in: 3600,
          scope: 'read write admin'
        }));
        return;
      }
      res.writeHead(404).end();
    })().catch(() => res.writeHead(500).end());
  });

  const oauth = await listen(oauthServer);
  oauthBase = oauth.base;
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-oauth-http-'));
  const hub = new DynamicMcpHub(path.join(root, 'mcp-hub'), {
    secretStore: new MemorySecretStore()
  });
  await hub.init();
  await hub.addServer({
    name: 'oauth-http',
    url: `${oauthBase}/mcp`,
    oauth: true,
    enabled: false,
    timeout_ms: 5000
  });
  const gateway = await startHttpServer(
    '127.0.0.1',
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    hub
  );

  try {
    const started = await hub.startOAuth('oauth-http') as {
      status: string;
      authorization_url?: string;
      callback_url: string;
    };
    assert.equal(started.status, 'authorization_required');
    assert.equal(started.callback_url, `${gateway.url}/oauth/callback/oauth-http`);
    const authorization = new URL(started.authorization_url!);
    const state = authorization.searchParams.get('state');
    assert.ok(state);

    const callback = await fetch(
      `${started.callback_url}?code=authorization-code&state=${encodeURIComponent(state!)}`
    );
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /authorization completed/i);

    const status = await hub.oauthStatus('oauth-http') as {
      authenticated: boolean;
      scope?: string;
      pending_authorization: boolean;
    };
    assert.equal(status.authenticated, true);
    assert.equal(status.scope, 'read write admin');
    assert.equal(status.pending_authorization, false);
    assert.equal(JSON.stringify(status).includes('http-test-access-secret'), false);
  } finally {
    await gateway.close();
    await oauth.close();
    await rm(root, { recursive: true, force: true });
  }
});
