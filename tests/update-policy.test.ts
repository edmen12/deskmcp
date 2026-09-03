import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePostInstallState,
  evaluateUpdateExecution,
  evaluateUpdateMetadata,
  type ReleaseMetadata,
  type UpdateManifest
} from '../src/update-policy.js';

const SHA = 'a'.repeat(64);

function manifest(overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    schemaVersion: 2,
    product: 'DeskMCP',
    version: '0.9.2',
    channel: 'stable',
    target: 'win-x64',
    artifact: 'DeskMCP-Setup-0.9.2.exe',
    sizeBytes: 123456,
    sha256: SHA,
    updatePolicy: {
      preserveUserData: true,
      preservePermissionProfile: true,
      fullControlSessionOnly: true,
      manualInstallerFallback: true,
      automaticExecutionRequiresImmutableRelease: true,
      automaticExecutionRequiresAuthenticode: true
    },
    ...overrides
  };
}
function release(overrides: Partial<ReleaseMetadata> = {}): ReleaseMetadata {
  return {
    immutable: true,
    draft: false,
    prerelease: false,
    tagName: 'v0.9.2',
    asset: {
      name: 'DeskMCP-Setup-0.9.2.exe',
      size: 123456,
      digest: `sha256:${SHA}`
    },
    ...overrides
  };
}

test('immutable release metadata permits verified download', () => {
  const decision = evaluateUpdateMetadata('0.9.1', release(), manifest());
  assert.equal(decision.kind, 'verified-download-allowed');
  assert.equal(decision.version, '0.9.2');
  assert.deepEqual(decision.reasons, []);
});

test('schema-v2 Authenticode flag is compatibility metadata, not a local execution gate', () => {
  const base = manifest();
  const decision = evaluateUpdateMetadata('0.9.1', release(), manifest({
    updatePolicy: {
      ...base.updatePolicy,
      automaticExecutionRequiresAuthenticode: false
    }
  }));
  assert.equal(decision.kind, 'verified-download-allowed');
  assert.deepEqual(decision.reasons, []);
});

test('mutable release is manual-only even when hashes match', () => {
  const decision = evaluateUpdateMetadata(
    '0.9.1', release({ immutable: false }), manifest()
  );
  assert.equal(decision.kind, 'manual-only');
  assert.deepEqual(decision.reasons, ['release-not-immutable']);
});
test('asset digest mismatch rejects the candidate', () => {
  const candidate = release({
    asset: {
      name: 'DeskMCP-Setup-0.9.2.exe',
      size: 123456,
      digest: `sha256:${'b'.repeat(64)}`
    }
  });
  const decision = evaluateUpdateMetadata('0.9.1', candidate, manifest());
  assert.equal(decision.kind, 'reject');
  assert.deepEqual(decision.reasons, ['artifact-digest-mismatch']);
});

test('same or older versions never become update candidates', () => {
  assert.equal(
    evaluateUpdateMetadata('0.9.2', release(), manifest()).kind,
    'up-to-date'
  );
  assert.equal(
    evaluateUpdateMetadata('0.10.0', release(), manifest()).kind,
    'up-to-date'
  );
});

test('unsupported channel is rejected', () => {
  const decision = evaluateUpdateMetadata(
    '0.9.1', release(), manifest({ channel: 'beta' })
  );
  assert.equal(decision.kind, 'reject');
  assert.deepEqual(decision.reasons, ['unsupported-channel']);
});

test('release target must match the installed architecture', () => {
  const decision = evaluateUpdateMetadata(
    '0.9.1', release(), manifest({ target: 'win-arm64' }), 'win-x64'
  );
  assert.equal(decision.kind, 'manual-only');
  assert.deepEqual(decision.reasons, ['target-mismatch']);
});

test('Windows ARM64 accepts a matching ARM64 release asset', () => {
  const armManifest = manifest({
    target: 'win-arm64',
    artifact: 'DeskMCP-Setup-0.9.2-win-arm64.exe'
  });
  const armRelease = release({
    asset: {
      name: 'DeskMCP-Setup-0.9.2-win-arm64.exe',
      size: 123456,
      digest: `sha256:${SHA}`
    }
  });
  const decision = evaluateUpdateMetadata('0.9.1', armRelease, armManifest, 'win-arm64');
  assert.equal(decision.kind, 'verified-download-allowed');
  assert.deepEqual(decision.reasons, []);
});
test('verified unsigned artifact is eligible before execution', () => {
  const metadata = evaluateUpdateMetadata('0.9.1', release(), manifest());
  const decision = evaluateUpdateExecution(metadata, manifest(), {
    sha256: SHA,
    sizeBytes: 123456,
    authenticodePresent: false,
    authenticodeValid: false,
    publisherPinConfigured: false,
    signerMatchesPinnedPublisher: false
  });
  assert.equal(decision.kind, 'auto-install-eligible');
  assert.deepEqual(decision.reasons, []);
});

test('invalid Authenticode is blocked instead of downgraded to unsigned', () => {
  const metadata = evaluateUpdateMetadata('0.9.1', release(), manifest());
  const decision = evaluateUpdateExecution(metadata, manifest(), {
    sha256: SHA,
    sizeBytes: 123456,
    authenticodePresent: true,
    authenticodeValid: false,
    publisherPinConfigured: true,
    signerMatchesPinnedPublisher: false
  });
  assert.equal(decision.kind, 'reject');
  assert.deepEqual(decision.reasons, ['authenticode-invalid']);
});

test('pinned publisher mismatch is blocked for an otherwise valid signature', () => {
  const metadata = evaluateUpdateMetadata('0.9.1', release(), manifest());
  const decision = evaluateUpdateExecution(metadata, manifest(), {
    sha256: SHA,
    sizeBytes: 123456,
    authenticodePresent: true,
    authenticodeValid: true,
    publisherPinConfigured: true,
    signerMatchesPinnedPublisher: false
  });
  assert.equal(decision.kind, 'reject');
  assert.deepEqual(decision.reasons, ['publisher-mismatch']);
});

test('integrity mismatch is blocked', () => {
  const metadata = evaluateUpdateMetadata('0.9.1', release(), manifest());
  const decision = evaluateUpdateExecution(metadata, manifest(), {
    sha256: 'b'.repeat(64),
    sizeBytes: 123456,
    authenticodePresent: false,
    authenticodeValid: false,
    publisherPinConfigured: false,
    signerMatchesPinnedPublisher: false
  });
  assert.equal(decision.kind, 'reject');
  assert.deepEqual(decision.reasons, ['local-sha256-mismatch']);
});

test('post-install verification detects permission profile changes', () => {
  const decision = evaluatePostInstallState('read-only', 'workspace-write');
  assert.equal(decision.kind, 'security-error');
  assert.deepEqual(decision.reasons, ['permission-profile-change']);
});
test('verified signed artifact is eligible before execution', () => {
  const metadata = evaluateUpdateMetadata('0.9.1', release(), manifest());
  const decision = evaluateUpdateExecution(metadata, manifest(), {
    sha256: SHA,
    sizeBytes: 123456,
    authenticodePresent: true,
    authenticodeValid: true,
    publisherPinConfigured: true,
    signerMatchesPinnedPublisher: true
  });
  assert.equal(decision.kind, 'auto-install-eligible');
  assert.deepEqual(decision.reasons, []);
});

test('post-install verification accepts an unchanged persisted profile', () => {
  const decision = evaluatePostInstallState('workspace-write', 'workspace-write');
  assert.equal(decision.kind, 'verified');
  assert.deepEqual(decision.reasons, []);
});
