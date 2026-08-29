import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLatestUpdate, type FetchLike } from '../src/update-client.js';

const SHA = 'a'.repeat(64);
const RELEASE_URL = 'https://github.com/edmen12/deskmcp/releases/tag/v0.9.2';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function manifest(target = 'win-x64', artifact = 'DeskMCP-Setup-0.9.2.exe') {
  return {
    schemaVersion: 2,
    product: 'DeskMCP',
    version: '0.9.2',
    channel: 'stable',
    target,
    artifact,
    sizeBytes: 123456,
    sha256: SHA,
    updatePolicy: {
      preserveUserData: true,
      preservePermissionProfile: true,      fullControlSessionOnly: true,
      manualInstallerFallback: true,
      automaticExecutionRequiresImmutableRelease: true,
      automaticExecutionRequiresAuthenticode: true
    }
  };
}

function release(assets: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v0.9.2',
    html_url: RELEASE_URL,
    immutable: true,
    draft: false,
    prerelease: false,
    assets,
    ...overrides
  };
}

function setupAsset(name = 'DeskMCP-Setup-0.9.2.exe') {
  return {
    name,
    size: 123456,
    digest: `sha256:${SHA}`,
    browser_download_url: `https://example.test/${name}`
  };
}
test('up-to-date release does not require a manifest asset', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return json(release([], { tag_name: 'v0.9.1' }));
  };
  const result = await checkLatestUpdate('0.9.1', 'win-x64', fetchImpl);
  assert.equal(result.kind, 'up-to-date');
  assert.equal(result.version, '0.9.1');
  assert.equal(calls, 1);
});

test('Windows ARM64 selects the ARM64 manifest and setup asset', async () => {
  const manifestName = 'release-manifest-win-arm64.json';
  const setupName = 'DeskMCP-Setup-0.9.2-win-arm64.exe';
  const assets = [
    { name: manifestName, size: 900, browser_download_url: 'https://example.test/arm-manifest' },
    setupAsset(setupName)
  ];
  const fetchImpl: FetchLike = async url =>
    url.endsWith('/releases/latest') ? json(release(assets)) : json(manifest('win-arm64', setupName));
  const result = await checkLatestUpdate('0.9.1', 'win-arm64', fetchImpl);
  assert.equal(result.kind, 'verified-download-allowed');
  assert.equal(result.artifact, setupName);
  assert.equal(result.target, 'win-arm64');
});
test('missing target manifest is manual-only', async () => {
  const fetchImpl: FetchLike = async () => json(release([setupAsset()]));
  const result = await checkLatestUpdate('0.9.1', 'win-x64', fetchImpl);
  assert.equal(result.kind, 'manual-only');
  assert.deepEqual(result.reasons, ['release-manifest-missing']);
});

test('mutable release cannot enter verified download flow', async () => {
  const assets = [
    { name: 'release-manifest.json', size: 900, browser_download_url: 'https://example.test/manifest' },
    setupAsset()
  ];
  const fetchImpl: FetchLike = async url =>
    url.endsWith('/releases/latest') ? json(release(assets, { immutable: false })) : json(manifest());
  const result = await checkLatestUpdate('0.9.1', 'win-x64', fetchImpl);
  assert.equal(result.kind, 'manual-only');
  assert.deepEqual(result.reasons, ['release-not-immutable']);
});

test('draft release is rejected by the security policy', async () => {
  const assets = [
    { name: 'release-manifest.json', size: 900, browser_download_url: 'https://example.test/manifest' },
    setupAsset()
  ];
  const fetchImpl: FetchLike = async url =>
    url.endsWith('/releases/latest') ? json(release(assets, { draft: true })) : json(manifest());
  const result = await checkLatestUpdate('0.9.1', 'win-x64', fetchImpl);
  assert.equal(result.kind, 'reject');
  assert.deepEqual(result.reasons, ['non-stable-release']);
});
test('legacy manifest schema falls back to manual install', async () => {
  const assets = [
    { name: 'release-manifest.json', size: 900, browser_download_url: 'https://example.test/manifest' },
    setupAsset()
  ];
  const fetchImpl: FetchLike = async url =>
    url.endsWith('/releases/latest') ? json(release(assets)) : json({ schemaVersion: 1 });
  const result = await checkLatestUpdate('0.9.1', 'win-x64', fetchImpl);
  assert.equal(result.kind, 'manual-only');
  assert.deepEqual(result.reasons, ['unsupported-manifest-schema']);
});

test('manifest fetch failure never enables automatic download', async () => {
  const assets = [
    { name: 'release-manifest.json', size: 900, browser_download_url: 'https://example.test/manifest' },
    setupAsset()
  ];
  const fetchImpl: FetchLike = async url =>
    url.endsWith('/releases/latest') ? json(release(assets)) : json({ error: 'gone' }, 503);
  const result = await checkLatestUpdate('0.9.1', 'win-x64', fetchImpl);
  assert.equal(result.kind, 'manual-only');
  assert.deepEqual(result.reasons, ['release-manifest-unavailable']);
});
