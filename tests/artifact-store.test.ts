import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/artifact-store.js';
import { DesktopPolicy } from '../src/desktop-policy.js';

async function withArtifactFixture(run: (args: {
  store: ArtifactStore;
  workspace: string;
  artifactRoot: string;
  policy: DesktopPolicy;
  root: string;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-artifact-'));
  try {
    const workspace = path.join(root, 'workspace');
    const artifactRoot = path.join(root, 'artifacts');
    await import('node:fs/promises').then(fs => fs.mkdir(workspace, { recursive: true }));
    const store = new ArtifactStore(artifactRoot);
    await store.init();
    store.setLocalBaseUrl('http://127.0.0.1:8765');
    const policy = await DesktopPolicy.create({
      profile: 'workspace-write',
      allowedRoots: [workspace]
    });
    await run({ store, workspace, artifactRoot, policy, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('artifact publish copies a policy-approved file and verifies checksum on read', async () => {
  await withArtifactFixture(async ({ store, workspace, artifactRoot, policy }) => {
    const source = path.join(workspace, 'report.txt');
    await writeFile(source, 'artifact payload\n', 'utf8');

    const artifact = await store.publishFromPath(source, policy, { retention_seconds: 60 });
    assert.equal(artifact.filename, 'report.txt');
    assert.equal(artifact.mime_type, 'text/plain; charset=utf-8');
    assert.equal(artifact.url_scope, 'local');
    assert.match(artifact.url ?? '', /^http:\/\/127\.0\.0\.1:8765\/artifacts\/public\//u);

    const copied = await readFile(path.join(artifactRoot, artifact.artifact_id, 'payload'), 'utf8');
    assert.equal(copied, 'artifact payload\n');

    const read = await store.read(artifact.artifact_id, 0, 1024, 'utf8');
    assert.equal(read.data, 'artifact payload\n');
    assert.equal(read.eof, true);
    assert.equal(read.next_offset, null);

    const url = new URL(artifact.url!);
    const resolved = await store.resolveSignedDownload(
      artifact.artifact_id,
      artifact.filename,
      url.searchParams.get('expires'),
      url.searchParams.get('sig')
    );
    assert.equal(resolved.metadata.sha256, artifact.sha256);
  });
});

test('artifact publish cannot escape DeskMCP workspace policy', async () => {
  await withArtifactFixture(async ({ store, policy, root }) => {
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'outside\n', 'utf8');
    await assert.rejects(
      store.publishFromPath(outside, policy),
      /outside DESKTOP_MCP_ALLOWED_ROOTS/i
    );
  });
});

test('artifact checksum mismatch is detected after payload tampering', async () => {
  await withArtifactFixture(async ({ store, workspace, artifactRoot, policy }) => {
    const source = path.join(workspace, 'evidence.json');
    await writeFile(source, '{"ok":true}\n', 'utf8');
    const artifact = await store.publishFromPath(source, policy, { retention_seconds: 60 });

    await writeFile(path.join(artifactRoot, artifact.artifact_id, 'payload'), '{"ok":false}\n', 'utf8');
    await assert.rejects(store.get(artifact.artifact_id), /checksum mismatch|size mismatch/i);
    await assert.rejects(store.read(artifact.artifact_id), /checksum mismatch|size mismatch/i);
  });
});

test('artifact cleanup removes expired payloads', async () => {
  await withArtifactFixture(async ({ store, workspace, policy }) => {
    const source = path.join(workspace, 'short-lived.txt');
    await writeFile(source, 'temporary\n', 'utf8');
    const artifact = await store.publishFromPath(source, policy, { retention_seconds: 60 });
    await store.cleanup(Date.parse(artifact.expires_at) + 1);
    await assert.rejects(store.get(artifact.artifact_id), /not found/i);
  });
});

test('configured artifact base URL rejects non-HTTP schemes', () => {
  assert.throws(
    () => new ArtifactStore(path.join(os.tmpdir(), 'deskmcp-invalid-artifact-root'), 'file:///tmp/share'),
    /must use HTTP or HTTPS/i
  );
});


test('configured artifact base URL requires HTTPS for non-loopback hosts and rejects URL credentials', () => {
  const root = path.join(os.tmpdir(), 'deskmcp-artifact-url-policy');
  assert.throws(
    () => new ArtifactStore(root, 'http://example.com/artifacts'),
    /HTTP only for loopback hosts|remote artifact URLs require HTTPS/i
  );
  assert.throws(
    () => new ArtifactStore(root, 'https://user:secret@example.com/artifacts'),
    /must not contain URL credentials/i
  );
  assert.doesNotThrow(() => new ArtifactStore(root, 'http://localhost:8765'));
  assert.doesNotThrow(() => new ArtifactStore(root, 'http://127.0.0.2:8765'));
  assert.doesNotThrow(() => new ArtifactStore(root, 'https://example.com/artifacts'));
});

test('local artifact base URL also rejects non-loopback HTTP', () => {
  const store = new ArtifactStore(path.join(os.tmpdir(), 'deskmcp-artifact-local-url-policy'));
  assert.throws(
    () => store.setLocalBaseUrl('http://192.168.1.20:8765'),
    /HTTP only for loopback hosts|remote artifact URLs require HTTPS/i
  );
  assert.doesNotThrow(() => store.setLocalBaseUrl('http://[::1]:8765'));
});

test('artifact store byte budget is enforced across concurrent Store instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-artifact-budget-'));
  try {
    const storeA = new ArtifactStore(root, undefined, 10);
    const storeB = new ArtifactStore(root, undefined, 10);
    await Promise.all([storeA.init(), storeB.init()]);
    const results = await Promise.allSettled([
      storeA.publishBytes('a.bin', new Uint8Array(6), 'application/octet-stream'),
      storeB.publishBytes('b.bin', new Uint8Array(6), 'application/octet-stream')
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.match(String(rejected.reason), /byte budget exceeded/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
