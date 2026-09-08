import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/artifact-store.js';
import { startHttpServer } from '../src/http-server.js';

async function withHttpArtifact(run: (args: { store: ArtifactStore; serverUrl: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-artifact-http-'));
  const store = new ArtifactStore(path.join(root, 'artifacts'));
  await store.init();
  const server = await startHttpServer(
    '127.0.0.1',
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store
  );
  try {
    await run({ store, serverUrl: server.url });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('signed artifact URL serves verified bytes and rejects a bad signature', async () => {
  await withHttpArtifact(async ({ store, serverUrl }) => {
    const published = await store.publishBytes(
      'result.txt',
      Buffer.from('signed artifact\n', 'utf8'),
      'text/plain; charset=utf-8',
      { retention_seconds: 60 }
    );
    const artifact = await store.get(published.artifact_id);
    assert.equal(artifact.url_scope, 'local');
    assert.match(artifact.url ?? '', new RegExp(`^${serverUrl.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/artifacts/public/`, 'u'));

    const response = await fetch(artifact.url!);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'signed artifact\n');
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');

    const tampered = new URL(artifact.url!);
    tampered.searchParams.set('sig', '0'.repeat(64));
    const rejected = await fetch(tampered);
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: 'artifact_access_denied' });
  });
});

test('artifact HTTP route is GET-only', async () => {
  await withHttpArtifact(async ({ store }) => {
    const artifact = await store.publishBytes(
      'method.txt',
      Buffer.from('method check', 'utf8'),
      'text/plain; charset=utf-8',
      { retention_seconds: 60 }
    );
    const info = await store.get(artifact.artifact_id);
    const response = await fetch(info.url!, { method: 'POST' });
    assert.equal(response.status, 405);
  });
});
