export type PersistedProfile = 'read-only' | 'workspace-write';

export interface UpdateManifestPolicy {
  readonly preserveUserData: boolean;
  readonly preservePermissionProfile: boolean;
  readonly fullControlSessionOnly: boolean;
  readonly manualInstallerFallback: boolean;
  readonly automaticExecutionRequiresImmutableRelease: boolean;
  readonly automaticExecutionRequiresAuthenticode: boolean;
}

export interface UpdateManifest {
  readonly schemaVersion: number;
  readonly product: string;
  readonly version: string;
  readonly channel: string;
  readonly target: string;
  readonly artifact: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly updatePolicy: UpdateManifestPolicy;
}

export interface ReleaseAssetMetadata {
  readonly name: string;
  readonly size: number;
  readonly digest?: string;
}
export interface ReleaseMetadata {
  readonly immutable: boolean;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly tagName: string;
  readonly asset: ReleaseAssetMetadata;
}

export type UpdateMetadataDecisionKind =
  | 'reject'
  | 'up-to-date'
  | 'manual-only'
  | 'verified-download-allowed';

export interface UpdateMetadataDecision {
  readonly kind: UpdateMetadataDecisionKind;
  readonly version?: string;
  readonly reasons: readonly string[];
}

export interface LocalArtifactTrust {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly authenticodeValid: boolean;
  readonly signerMatchesPinnedPublisher: boolean;
}

export interface UpdateExecutionDecision {
  readonly kind: 'reject' | 'manual-only' | 'auto-install-eligible';
  readonly reasons: readonly string[];
}

export interface UpdatePostInstallDecision {
  readonly kind: 'verified' | 'security-error';
  readonly reasons: readonly string[];
}

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  const major = a[0] - b[0];
  if (major !== 0) return Math.sign(major);
  const minor = a[1] - b[1];
  if (minor !== 0) return Math.sign(minor);
  return Math.sign(a[2] - b[2]);
}

function normalizedSha256(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function requiredPolicyIsPresent(policy: UpdateManifestPolicy): boolean {
  return policy.preserveUserData === true &&
    policy.preservePermissionProfile === true &&
    policy.fullControlSessionOnly === true &&
    policy.manualInstallerFallback === true &&
    policy.automaticExecutionRequiresImmutableRelease === true &&
    policy.automaticExecutionRequiresAuthenticode === true;
}
export function evaluateUpdateMetadata(
  currentVersion: string,
  release: ReleaseMetadata,
  manifest: UpdateManifest
): UpdateMetadataDecision {
  const reasons: string[] = [];
  const comparison = compareVersions(manifest.version, currentVersion);
  if (comparison === null) return { kind: 'reject', reasons: ['invalid-version'] };
  if (release.draft || release.prerelease) return { kind: 'reject', reasons: ['non-stable-release'] };
  if (manifest.product !== 'DeskMCP') return { kind: 'reject', reasons: ['wrong-product'] };
  if (manifest.channel !== 'stable') return { kind: 'reject', reasons: ['unsupported-channel'] };
  if (manifest.target !== 'win-x64') return { kind: 'manual-only', version: manifest.version, reasons: ['unsupported-target'] };
  if (release.tagName !== `v${manifest.version}`) return { kind: 'reject', reasons: ['tag-version-mismatch'] };
  if (release.asset.name !== manifest.artifact) return { kind: 'reject', reasons: ['artifact-name-mismatch'] };
  if (release.asset.size !== manifest.sizeBytes) return { kind: 'reject', reasons: ['artifact-size-mismatch'] };

  const manifestSha = normalizedSha256(manifest.sha256);
  const assetDigest = release.asset.digest?.toLowerCase();
  if (!manifestSha || assetDigest !== `sha256:${manifestSha}`) {
    return { kind: 'reject', reasons: ['artifact-digest-mismatch'] };
  }
  if (comparison <= 0) return { kind: 'up-to-date', version: manifest.version, reasons: [] };
  if (manifest.schemaVersion !== 2) reasons.push('unsupported-manifest-schema');
  if (!requiredPolicyIsPresent(manifest.updatePolicy)) reasons.push('unsafe-update-policy');
  if (!release.immutable) reasons.push('release-not-immutable');

  return reasons.length === 0
    ? { kind: 'verified-download-allowed', version: manifest.version, reasons: [] }
    : { kind: 'manual-only', version: manifest.version, reasons };
}
export function evaluateUpdateExecution(
  metadata: UpdateMetadataDecision,
  manifest: UpdateManifest,
  artifact: LocalArtifactTrust
): UpdateExecutionDecision {
  if (metadata.kind === 'reject') return { kind: 'reject', reasons: [...metadata.reasons] };
  if (metadata.kind !== 'verified-download-allowed') {
    return { kind: 'manual-only', reasons: [...metadata.reasons] };
  }

  const reasons: string[] = [];
  const manifestSha = normalizedSha256(manifest.sha256);
  const localSha = normalizedSha256(artifact.sha256);
  if (!manifestSha || localSha !== manifestSha) reasons.push('local-sha256-mismatch');
  if (artifact.sizeBytes !== manifest.sizeBytes) reasons.push('local-size-mismatch');
  if (!artifact.authenticodeValid) reasons.push('authenticode-invalid');
  if (!artifact.signerMatchesPinnedPublisher) reasons.push('publisher-mismatch');

  return reasons.length === 0
    ? { kind: 'auto-install-eligible', reasons: [] }
    : { kind: 'manual-only', reasons };
}

export function evaluatePostInstallState(
  expectedProfile: PersistedProfile,
  actualProfile: PersistedProfile
): UpdatePostInstallDecision {
  return expectedProfile === actualProfile
    ? { kind: 'verified', reasons: [] }
    : { kind: 'security-error', reasons: ['permission-profile-change'] };
}
