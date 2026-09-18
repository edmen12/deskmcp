import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { DynamicMcpOAuthManager } from '../src/dynamic-mcp-oauth-manager.js';
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

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('OAuth manager discovers maximum resource scopes, validates state, and stores exchanged tokens', async () => {
  let base = '';
  let registeredRedirect = '';
  let tokenRequest = '';
  const server = http.createServer((req, res) => {
    void (async () => {
      const parsed = new URL(req.url ?? '/', base || 'http://127.0.0.1');
      if (parsed.pathname === '/mcp') {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`
        });
        res.end();
        return;
      }
      if (parsed.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          resource: `${base}/mcp`,
          authorization_servers: [base],
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
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['read', 'write', 'admin']
        }));
        return;
      }
      if (parsed.pathname === '/register' && req.method === 'POST') {
        const metadata = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
        registeredRedirect = metadata.redirect_uris?.[0] ?? '';
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ...metadata,
          client_id: 'deskmcp-test-client',
          client_id_issued_at: Math.floor(Date.now() / 1000)
        }));
        return;
      }
      if (parsed.pathname === '/token' && req.method === 'POST') {
        tokenRequest = await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'access-token-secret',
          token_type: 'Bearer',
          refresh_token: 'refresh-token-secret',
          expires_in: 3600,
          scope: 'read write admin'
        }));
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      res.writeHead(500).end();
    });
  });

  const running = await listen(server);
  base = running.base;
  try {
    const manager = new DynamicMcpOAuthManager('unused-test-root', new MemorySecretStore());
    manager.setCallbackBaseUrl('http://127.0.0.1:8765');
    const target = {
      name: 'oauth-test',
      url: `${base}/mcp`,
      timeout_ms: 5000
    };

    const started = await manager.start(target, {});
    assert.equal(started.status, 'authorization_required');
    assert.ok(started.authorization_url);
    assert.equal(registeredRedirect, 'http://127.0.0.1:8765/oauth/callback/oauth-test');

    const authorization = new URL(started.authorization_url!);
    const requestedScopes = new Set((authorization.searchParams.get('scope') ?? '').split(/\s+/u));
    assert.equal(requestedScopes.has('read'), true);
    assert.equal(requestedScopes.has('write'), true);
    assert.equal(requestedScopes.has('admin'), true);
    const state = authorization.searchParams.get('state');
    assert.ok(state);

    await manager.finishCallback(target, new URLSearchParams({
      code: 'authorization-code',
      state: state!
    }));

    assert.match(tokenRequest, /grant_type=authorization_code/u);
    assert.match(tokenRequest, /code=authorization-code/u);
    assert.match(tokenRequest, /code_verifier=/u);

    const status = await manager.status(target) as {
      authenticated: boolean;
      scope?: string;
      pending_authorization: boolean;
    };
    assert.equal(status.authenticated, true);
    assert.equal(status.scope, 'read write admin');
    assert.equal(status.pending_authorization, false);
    assert.equal(JSON.stringify(status).includes('access-token-secret'), false);
    assert.equal(JSON.stringify(status).includes('refresh-token-secret'), false);
  } finally {
    await running.close();
  }
});
