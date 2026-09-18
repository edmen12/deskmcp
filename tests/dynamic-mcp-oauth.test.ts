import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  type StoredOAuthClientInformation,
  type StoredOAuthTokens
} from '@modelcontextprotocol/client';
import { DeskMcpOAuthProvider } from '../src/dynamic-mcp-oauth.js';
import { PlatformSecretStore } from '../src/platform-secret-store.js';
import { MemorySecretStore } from '../src/secure-secret-store.js';

test('DeskMCP OAuth provider persists protocol state without exposing secrets in public status', async () => {
  const store = new MemorySecretStore();
  const provider = new DeskMcpOAuthProvider(
    'oauth:test',
    store,
    'http://127.0.0.1:8765/oauth/callback/test'
  );
  await provider.init();

  assert.equal(provider.clientMetadata.application_type, 'native');
  assert.deepEqual(provider.clientMetadata.grant_types, ['authorization_code', 'refresh_token']);
  assert.equal(provider.clientMetadata.scope, undefined);

  const firstState = provider.state();
  const secondState = provider.state();
  assert.notEqual(firstState, secondState);
  assert.equal(provider.expectedState, secondState);

  await provider.saveCodeVerifier('pkce-secret');
  assert.equal(await provider.codeVerifier(), 'pkce-secret');

  const client = { client_id: 'client-123' } as StoredOAuthClientInformation;
  await provider.saveClientInformation(client, { issuer: 'https://auth.example.test' });
  assert.equal(
    (await provider.clientInformation({ issuer: 'https://auth.example.test' }))?.client_id,
    'client-123'
  );
  assert.equal(
    await provider.clientInformation({ issuer: 'https://other.example.test' }),
    undefined
  );

  const tokens = {
    access_token: 'access-secret',
    token_type: 'Bearer',
    refresh_token: 'refresh-secret',
    scope: 'read write admin',
    issuer: 'https://auth.example.test'
  } as StoredOAuthTokens;
  await provider.saveTokens(tokens);
  assert.equal(
    (await provider.tokens({ issuer: 'https://auth.example.test' }))?.access_token,
    'access-secret'
  );
  assert.equal(await provider.tokens({ issuer: 'https://other.example.test' }), undefined);

  const status = await provider.publicStatus();
  assert.deepEqual(status, {
    configured: true,
    authenticated: true,
    scope: 'read write admin',
    issuer: 'https://auth.example.test'
  });
  assert.equal(JSON.stringify(status).includes('access-secret'), false);
  assert.equal(JSON.stringify(status).includes('refresh-secret'), false);

  const reloaded = new DeskMcpOAuthProvider(
    'oauth:test',
    store,
    'http://127.0.0.1:8765/oauth/callback/test'
  );
  await reloaded.init();
  assert.equal((await reloaded.tokens())?.refresh_token, 'refresh-secret');

  await reloaded.invalidateCredentials?.('all');
  assert.equal((await reloaded.publicStatus()).authenticated, false);
});

test('Windows OAuth secret store uses CurrentUser protection and supports overwrite/delete', {
  skip: process.platform !== 'win32'
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-oauth-secret-'));
  const store = new PlatformSecretStore(root);
  try {
    await store.init();
    await store.set('provider-key', 'first-secret-value');
    assert.equal(await store.get('provider-key'), 'first-secret-value');

    await store.set('provider-key', 'second-secret-value');
    assert.equal(await store.get('provider-key'), 'second-secret-value');

    const files = await readdir(root);
    assert.equal(files.length, 1);
    const encrypted = await readFile(path.join(root, files[0]!), 'utf8');
    assert.doesNotMatch(encrypted, /first-secret-value|second-secret-value/u);

    await store.delete('provider-key');
    assert.equal(await store.get('provider-key'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
