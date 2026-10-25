import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/artifact-store.js';
import { createBrowserCrossToolGuard, type BrowserCrossToolGuard } from '../src/browser-cross-tool-guard.js';
import { createBrowserHandoffBoundary as createProductionHandoffBoundary } from '../src/browser-handoff-boundary.js';

/**
 * TEST ONLY. Old lifecycle tests inject synthetic approval to isolate state
 * machine behavior; signed verification is separately tested against real RSA.
 * NEVER export this helper from production sources.
 */
const TEST_SYNTHETIC_PROOF = { challenge_id:'unit-only', signature_b64:'not-real', lease_id:'unit-only' };
function createBrowserHandoffBoundary(revokeObservations: (sessionId: string) => void) {
  const real = createProductionHandoffBoundary(revokeObservations, {
    verify: () => undefined,
    revokeSession: () => undefined
  });
  return {
    ...real,
    local: {
      accept: (id: string) => real.local.accept(id, TEST_SYNTHETIC_PROOF),
      reject: real.local.reject,
      resume: (id: string) => real.local.resume(id, TEST_SYNTHETIC_PROOF)
    }
  };
}
import { startHttpServer } from '../src/http-server.js';

async function withHttpArtifact(run: (args: { store: ArtifactStore; serverUrl: string }) => Promise<void>, guard?: BrowserCrossToolGuard): Promise<void> {
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
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    guard
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

test('human takeover blocks signed artifact HTTP even with a valid previously issued URL', async () => {
  const boundary=createBrowserHandoffBoundary(()=>undefined);
  const guard=createBrowserCrossToolGuard(boundary.agent);
  const session='99999999-9999-4999-8999-999999999999';
  await withHttpArtifact(async({store})=>{
    const published=await store.publishBytes('private.txt',Buffer.from('TEST_PRIVATE_DATA'),'text/plain',{retention_seconds:60});
    const url=(await store.get(published.artifact_id)).url!;
    assert.equal((await (await fetch(url)).text()),'TEST_PRIVATE_DATA');
    boundary.agent.request(session);
    const blocked=await fetch(url);
    assert.equal(blocked.status,403);
    assert.deepEqual(await blocked.json(),{error:'artifact_access_denied'});
    boundary.local.reject(session);
    const recovered=await fetch(url);
    assert.equal(recovered.status,200);
    assert.equal(await recovered.text(),'TEST_PRIVATE_DATA');
  },guard);
});

test('in-flight signed artifact HTTP transfer drains before human ownership transfer', async () => {
  const boundary=createBrowserHandoffBoundary(()=>undefined);
  const guard=createBrowserCrossToolGuard(boundary.agent);
  const session='88888888-8888-4888-8888-888888888888';
  await withHttpArtifact(async({store})=>{
    const published=await store.publishBytes('stream.txt',Buffer.from('stream complete'),'text/plain',{retention_seconds:60});
    const url=(await store.get(published.artifact_id)).url!;
    const old=store.resolveSignedDownload.bind(store);
    let entered!:()=>void;
    let release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const pause=new Promise<void>(resolve=>{release=resolve;});
    Object.assign(store, {resolveSignedDownload:async(...args:Parameters<ArtifactStore['resolveSignedDownload']>)=>{
      entered();
      await pause;
      return old(...args);
    }});
    const original=fetch(url);
    await started;
    let transferred=false;
    const handoff=guard.withHandoffBarrier(async()=>{
      transferred=true;
      return boundary.agent.request(session);
    },1500);
    assert.equal(transferred,false);
    const newRequest=await fetch(url);
    assert.equal(newRequest.status,403,'pending handoff denies a new HTTP stream');
    release();
    const response=await original;
    assert.equal(response.status,200);
    assert.equal(await response.text(),'stream complete');
    const changed=await handoff;
    assert.equal(changed.state,'handoff-requested');
    assert.equal(transferred,true);
    boundary.local.reject(session);
  },guard);
});
