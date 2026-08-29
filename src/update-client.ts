import { compareVersions, evaluateUpdateMetadata, type UpdateManifest } from './update-policy.js';

export interface UpdateCheckResult {
  kind: 'reject' | 'up-to-date' | 'manual-only' | 'verified-download-allowed';
  version?: string | undefined;
  reasons: string[];
  releaseUrl?: string;
  downloadUrl?: string;
  artifact?: string;
  sizeBytes?: number;
  sha256?: string;
  target: string;
}

interface GitHubAsset {
  name: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  immutable?: boolean;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function manifestAssetName(target: string): string {
  return target === 'win-x64' ? 'release-manifest.json' : `release-manifest-${target}.json`;
}
async function getJson<T>(url: string, fetchImpl: FetchLike): Promise<T> {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'DeskMCP-Updater'
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Update request failed: HTTP ${response.status}`);
  return await response.json() as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUpdateManifest(value: unknown): value is UpdateManifest {
  if (!isRecord(value) || !isRecord(value.updatePolicy)) return false;
  const policy = value.updatePolicy;
  const policyKeys = [
    'preserveUserData', 'preservePermissionProfile', 'fullControlSessionOnly',
    'manualInstallerFallback', 'automaticExecutionRequiresImmutableRelease',
    'automaticExecutionRequiresAuthenticode'
  ];
  return value.schemaVersion === 2 && typeof value.product === 'string' &&
    typeof value.version === 'string' && typeof value.channel === 'string' &&
    typeof value.target === 'string' && typeof value.artifact === 'string' &&
    Number.isSafeInteger(value.sizeBytes) && Number(value.sizeBytes) > 0 &&
    typeof value.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(value.sha256) &&
    policyKeys.every(key => typeof policy[key] === 'boolean');
}

export async function checkLatestUpdate(
  currentVersion: string,
  target: string,
  fetchImpl: FetchLike = fetch
): Promise<UpdateCheckResult> {
  const release = await getJson<GitHubRelease>(
    'https://api.github.com/repos/edmen12/deskmcp/releases/latest',
    fetchImpl
  );
  const latestVersion = release.tag_name.replace(/^v/, '');
  const comparison = compareVersions(latestVersion, currentVersion);
  if (comparison === null) {
    return { kind: 'reject', reasons: ['invalid-release-version'], releaseUrl: release.html_url, target };
  }
  if (comparison <= 0) {
    return { kind: 'up-to-date', version: latestVersion, reasons: [], releaseUrl: release.html_url, target };
  }

  const manifestAsset = release.assets.find(asset => asset.name === manifestAssetName(target));
  if (!manifestAsset) {
    return {
      kind: 'manual-only',
      version: release.tag_name.replace(/^v/, ''),
      reasons: ['release-manifest-missing'],
      releaseUrl: release.html_url,
      target
    };
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = await getJson<unknown>(manifestAsset.browser_download_url, fetchImpl);
  } catch {
    return {
      kind: 'manual-only', version: latestVersion,
      reasons: ['release-manifest-unavailable'], releaseUrl: release.html_url, target
    };
  }
  if (!isUpdateManifest(manifestRaw)) {
    const schema = isRecord(manifestRaw) ? manifestRaw.schemaVersion : undefined;
    return {
      kind: 'manual-only', version: latestVersion,
      reasons: [schema === 2 ? 'release-manifest-invalid' : 'unsupported-manifest-schema'],
      releaseUrl: release.html_url, target
    };
  }
  const manifest = manifestRaw;
  const setupAsset = release.assets.find(asset => asset.name === manifest.artifact);
  if (!setupAsset) {
    return {
      kind: 'manual-only', version: manifest.version,
      reasons: ['release-asset-missing'], releaseUrl: release.html_url, target
    };
  }
  const decision = evaluateUpdateMetadata(
    currentVersion,
    {
      tagName: release.tag_name,
      immutable: release.immutable === true,
      draft: release.draft === true,
      prerelease: release.prerelease === true,
      asset: {
        name: setupAsset.name,
        size: setupAsset.size,
        digest: setupAsset.digest ?? undefined
      }
    },
    manifest,
    target
  );
  return {
    kind: decision.kind,
    version: decision.version,
    reasons: [...decision.reasons],
    releaseUrl: release.html_url,
    downloadUrl: setupAsset.browser_download_url,
    artifact: setupAsset.name,
    sizeBytes: setupAsset.size,
    sha256: manifest.sha256,
    target
  };
}
