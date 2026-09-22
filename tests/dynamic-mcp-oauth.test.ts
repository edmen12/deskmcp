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

class LegacyMemorySecretStore extends MemorySecretStore {
  private readonly legacyValues = new Map<string, string>();
  private readonly legacyCandidates = new Map<string, string>();

  async getLegacy(key: string): Promise<string | undefined> {
    return this.legacyValues.get(key);
  }

  async deleteLegacy(key: string): Promise<void> {
    this.legacyValues.delete(key);
  }

  async listLegacyCandidates(): Promise<readonly { id: string; value: string }[]> {
    return [...this.legacyCandidates].map(([id, value]) => ({ id, value }));
  }

  async deleteLegacyCandidate(id: string): Promise<void> {
    this.legacyCandidates.delete(id);
  }

  setLegacy(key: string, value: string): void {
    this.legacyValues.set(key, value);
  }

  addLegacyCandidate(id: string, value: string): void {
    this.legacyCandidates.set(id, value);
  }

  hasLegacy(key: string): boolean {
    return this.legacyValues.has(key);
  }

  hasLegacyCandidate(id: string): boolean {
    return this.legacyCandidates.has(id);
  }
}

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

test('DeskMCP OAuth provider migrates legacy hashed secret state only when the current state has no tokens', async () => {
  const key = 'dynamic-mcp:legacy';
  const store = new LegacyMemorySecretStore();
  await store.set(key, JSON.stringify({
    version: 1,
    clients: {},
    authorization_server_url: 'https://auth.current.test',
    resource_url: 'https://resource.current.test'
  }));
  store.setLegacy(key, JSON.stringify({
    version: 1,
    clients: {
      'https://auth.legacy.test': { client_id: 'legacy-client' }
    },
    tokens: {
      access_token: 'legacy-access-secret',
      token_type: 'Bearer',
      refresh_token: 'legacy-refresh-secret',
      issuer: 'https://auth.legacy.test'
    },
    authorization_server_url: 'https://auth.legacy.test',
    resource_url: 'https://resource.legacy.test'
  }));

  const provider = new DeskMcpOAuthProvider(
    key,
    store,
    'http://127.0.0.1:8765/oauth/callback/legacy'
  );
  await provider.init();

  assert.equal((await provider.tokens())?.access_token, 'legacy-access-secret');
  assert.equal((await provider.tokens())?.refresh_token, 'legacy-refresh-secret');
  assert.equal(
    (await provider.clientInformation({ issuer: 'https://auth.legacy.test' }))?.client_id,
    'legacy-client'
  );
  assert.equal(store.hasLegacy(key), false);

  const migrated = JSON.parse((await store.get(key))!) as {
    tokens?: { access_token?: string; refresh_token?: string };
    authorization_server_url?: string;
    resource_url?: string;
  };
  assert.equal(migrated.tokens?.access_token, 'legacy-access-secret');
  assert.equal(migrated.tokens?.refresh_token, 'legacy-refresh-secret');
  assert.equal(migrated.authorization_server_url, 'https://auth.current.test');
  assert.equal(migrated.resource_url, 'https://resource.current.test');

  store.setLegacy(key, JSON.stringify({
    version: 1,
    clients: {},
    tokens: {
      access_token: 'must-not-win',
      token_type: 'Bearer',
      refresh_token: 'must-not-win'
    }
  }));
  const currentWins = new DeskMcpOAuthProvider(
    key,
    store,
    'http://127.0.0.1:8765/oauth/callback/legacy'
  );
  await currentWins.init();
  assert.equal((await currentWins.tokens())?.access_token, 'legacy-access-secret');
  assert.equal(store.hasLegacy(key), true);
});

test('DeskMCP OAuth provider discovers an unidentified legacy secret by matching the protected resource URL', async () => {
  const key = 'dynamic-mcp:resource-match';
  const store = new LegacyMemorySecretStore();
  await store.set(key, JSON.stringify({
    version: 1,
    clients: {},
    resource_url: 'https://mcp.example.test/'
  }));
  store.addLegacyCandidate('legacy-a.dpapi', JSON.stringify({
    version: 1,
    clients: { 'https://auth.example.test': { client_id: 'resource-client' } },
    tokens: {
      access_token: 'resource-access',
      token_type: 'Bearer',
      refresh_token: 'resource-refresh',
      issuer: 'https://auth.example.test'
    },
    resource_url: 'https://mcp.example.test',
    authorization_server_url: 'https://auth.example.test'
  }));
  store.addLegacyCandidate('legacy-other.dpapi', JSON.stringify({
    version: 1,
    clients: {},
    tokens: {
      access_token: 'other-access',
      token_type: 'Bearer',
      refresh_token: 'other-refresh'
    },
    resource_url: 'https://other.example.test/'
  }));

  const provider = new DeskMcpOAuthProvider(
    key,
    store,
    'http://127.0.0.1:8765/oauth/callback/resource-match',
    undefined,
    undefined,
    undefined,
    'https://mcp.example.test/'
  );
  await provider.init();

  assert.equal((await provider.tokens())?.access_token, 'resource-access');
  assert.equal((await provider.tokens())?.refresh_token, 'resource-refresh');
  assert.equal(store.hasLegacyCandidate('legacy-a.dpapi'), false);
  assert.equal(store.hasLegacyCandidate('legacy-other.dpapi'), true);

  const changedResource = new LegacyMemorySecretStore();
  await changedResource.set('dynamic-mcp:changed-resource', JSON.stringify({
    version: 1,
    clients: {},
    resource_url: 'https://mcp.example.test/mcp',
    authorization_server_url: 'https://auth.example.test'
  }));
  changedResource.addLegacyCandidate('legacy-changed.dpapi', JSON.stringify({
    version: 1,
    clients: {},
    tokens: {
      access_token: 'changed-access',
      token_type: 'Bearer',
      refresh_token: 'changed-refresh',
      issuer: 'https://auth.example.test'
    },
    resource_url: 'https://mcp.example.test/',
    authorization_server_url: 'https://auth.example.test/'
  }));
  const changedResourceProvider = new DeskMcpOAuthProvider(
    'dynamic-mcp:changed-resource',
    changedResource,
    'http://127.0.0.1:8765/oauth/callback/changed-resource',
    undefined,
    undefined,
    undefined,
    'https://mcp.example.test/mcp'
  );
  await changedResourceProvider.init();
  assert.equal((await changedResourceProvider.tokens())?.refresh_token, 'changed-refresh');
  assert.equal(changedResource.hasLegacyCandidate('legacy-changed.dpapi'), false);

  const ambiguous = new LegacyMemorySecretStore();
  ambiguous.addLegacyCandidate('first.dpapi', JSON.stringify({
    version: 1,
    clients: {},
    tokens: { access_token: 'first', token_type: 'Bearer' },
    resource_url: 'https://mcp.example.test/'
  }));
  ambiguous.addLegacyCandidate('second.dpapi', JSON.stringify({
    version: 1,
    clients: {},
    tokens: { access_token: 'second', token_type: 'Bearer' },
    resource_url: 'https://mcp.example.test'
  }));
  const ambiguousProvider = new DeskMcpOAuthProvider(
    'dynamic-mcp:ambiguous',
    ambiguous,
    'http://127.0.0.1:8765/oauth/callback/ambiguous',
    undefined,
    undefined,
    undefined,
    'https://mcp.example.test/'
  );
  await assert.rejects(
    ambiguousProvider.init(),
    /multiple legacy OAuth secrets match/i
  );
});

test('DeskMCP OAuth provider uses a pre-registered client without persisting its secret', async () => {
  const store = new MemorySecretStore();
  const provider = new DeskMcpOAuthProvider(
    'oauth:static-client',
    store,
    'http://127.0.0.1:8765/oauth/callback/github',
    'read:user',
    undefined,
    {
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      tokenEndpointAuthMethod: 'client_secret_post'
    }
  );
  await provider.init();

  const client = await provider.clientInformation({ issuer: 'https://github.com/login/oauth' });
  assert.deepEqual(client, {
    client_id: 'github-client-id',
    client_secret: 'github-client-secret',
    token_endpoint_auth_method: 'client_secret_post',
    issuer: 'https://github.com/login/oauth'
  });

  await provider.saveClientInformation(
    { client_id: 'must-not-be-persisted', client_secret: 'must-not-be-persisted' } as StoredOAuthClientInformation,
    { issuer: 'https://github.com/login/oauth' }
  );
  assert.equal(await store.get('oauth:static-client'), undefined);
  assert.equal(
    (await provider.clientInformation({ issuer: 'https://github.com/login/oauth' }))?.client_id,
    'github-client-id'
  );
});

test('DeskMCP OAuth provider enforces the configured authorization scope at redirect time', async () => {
  const store = new MemorySecretStore();
  let redirected: URL | undefined;
  const provider = new DeskMcpOAuthProvider(
    'oauth:scoped',
    store,
    'http://127.0.0.1:8765/oauth/callback/github',
    'read:user repo',
    (url) => { redirected = url; }
  );

  await provider.redirectToAuthorization(new URL(
    'https://github.com/login/oauth/authorize?client_id=test&scope=repo+admin%3Aorg+offline_access'
  ));

  assert.equal(redirected?.searchParams.get('scope'), 'read:user repo offline_access');
  assert.equal(provider.authorizationUrl?.searchParams.get('scope'), 'read:user repo offline_access');
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
