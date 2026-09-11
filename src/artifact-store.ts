import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { acquirePidDirectoryLock, type PidDirectoryLockLease } from './cross-process-lock.js';
import { renameFileWithRetry } from './fs-reliability.js';
import type { DesktopPolicy } from './desktop-policy.js';

const DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;
const MAX_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_STORE_BYTES = 512 * 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const ARTIFACT_LOCK_TIMEOUT_MS = 5_000;
const ARTIFACT_LOCK_INITIALIZATION_GRACE_MS = 5_000;
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{32}$/u;

export interface ArtifactMetadata {
  readonly schema_version: 1;
  readonly artifact_id: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly source_path?: string;
}

export interface ArtifactInfo extends ArtifactMetadata {
  readonly url?: string;
  readonly url_scope?: 'configured' | 'local';
}

export interface ArtifactReadResult {
  readonly artifact: ArtifactInfo;
  readonly offset: number;
  readonly next_offset: number | null;
  readonly eof: boolean;
  readonly encoding: 'utf8' | 'base64';
  readonly data: string;
}

export interface PublishArtifactOptions {
  readonly retention_seconds?: number;
}

function safeFilename(value: string): string {
  const base = path.basename(value).trim();
  if (!base || base === '.' || base === '..' || /[\\/]/u.test(base)) return 'artifact.bin';
  return base.replace(/[\u0000-\u001f<>:"|?*]/gu, '_').slice(0, 240) || 'artifact.bin';
}

function mimeFromFilename(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.txt': return 'text/plain; charset=utf-8';
    case '.md': case '.markdown': return 'text/markdown; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.csv': return 'text/csv; charset=utf-8';
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.xml': return 'application/xml; charset=utf-8';
    case '.yaml': case '.yml': return 'application/yaml; charset=utf-8';
    case '.js': case '.mjs': case '.cjs': return 'text/javascript; charset=utf-8';
    case '.ts': case '.tsx': return 'text/plain; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.pdf': return 'application/pdf';
    case '.zip': return 'application/zip';
    case '.gz': return 'application/gzip';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    default: return 'application/octet-stream';
  }
}

function retentionSeconds(value: number | undefined): number {
  const selected = value ?? DEFAULT_RETENTION_SECONDS;
  if (!Number.isInteger(selected) || selected < 60 || selected > MAX_RETENTION_SECONDS) {
    throw new Error(`Artifact retention_seconds must be between 60 and ${MAX_RETENTION_SECONDS}.`);
  }
  return selected;
}

function validateArtifactId(id: string): string {
  const normalized = id.trim();
  if (!ARTIFACT_ID_PATTERN.test(normalized)) throw new Error('Invalid artifact id.');
  return normalized;
}

function newArtifactId(): string {
  return `art_${randomBytes(16).toString('hex')}`;
}

async function fileSha256(file: string): Promise<string> {
  const handle = await open(file, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function parseMetadata(value: unknown): ArtifactMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Artifact metadata is invalid.');
  }
  const meta = value as Partial<ArtifactMetadata>;
  if (meta.schema_version !== 1 || typeof meta.artifact_id !== 'string') {
    throw new Error('Artifact metadata schema is invalid.');
  }
  validateArtifactId(meta.artifact_id);
  if (
    typeof meta.filename !== 'string'
    || typeof meta.mime_type !== 'string'
    || typeof meta.size_bytes !== 'number'
    || typeof meta.sha256 !== 'string'
    || typeof meta.created_at !== 'string'
    || typeof meta.expires_at !== 'string'
  ) {
    throw new Error('Artifact metadata fields are invalid.');
  }
  return meta as ArtifactMetadata;
}

export class ArtifactExpiredError extends Error {
  constructor(readonly artifactId: string) {
    super(`Artifact expired: ${artifactId}.`);
    this.name = 'ArtifactExpiredError';
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  return Boolean(match && match.slice(1).every(part => Number(part) >= 0 && Number(part) <= 255));
}

function validateArtifactBaseUrl(value: string, label: string): string {
  const normalized = value.trim().replace(/\/+$/u, '');
  let parsed: URL;
  try { parsed = new URL(normalized); }
  catch { throw new Error(`${label} must be a valid HTTP(S) URL.`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain URL credentials.`);
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`${label} may use HTTP only for loopback hosts; remote artifact URLs require HTTPS.`);
  }
  return normalized;
}

export class ArtifactStore {
  private readonly signingSecret = randomBytes(32);
  private configuredBaseUrl: string | undefined;
  private localBaseUrl: string | undefined;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    configuredBaseUrl = process.env.DESKTOP_MCP_ARTIFACT_BASE_URL?.trim(),
    private readonly maxStoreBytes = DEFAULT_MAX_ARTIFACT_STORE_BYTES
  ) {
    if (!Number.isSafeInteger(maxStoreBytes) || maxStoreBytes < 1) {
      throw new Error('Artifact store byte budget must be a positive safe integer.');
    }
    if (configuredBaseUrl) {
      this.configuredBaseUrl = validateArtifactBaseUrl(configuredBaseUrl, 'DESKTOP_MCP_ARTIFACT_BASE_URL');
    }
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanup();
  }

  setLocalBaseUrl(value: string): void {
    this.localBaseUrl = validateArtifactBaseUrl(value, 'Artifact local base URL');
  }

  private artifactDir(id: string): string {
    return path.join(this.root, validateArtifactId(id));
  }

  private payloadPath(id: string): string {
    return path.join(this.artifactDir(id), 'payload');
  }

  private metadataPath(id: string): string {
    return path.join(this.artifactDir(id), 'metadata.json');
  }

  private get mutationLockPath(): string {
    return path.join(this.root, '.artifact-store.lock');
  }

  private async acquireMutationLock(): Promise<PidDirectoryLockLease> {
    return acquirePidDirectoryLock(this.mutationLockPath, {
      label: 'Artifact store',
      timeoutMs: ARTIFACT_LOCK_TIMEOUT_MS,
      initializationGraceMs: ARTIFACT_LOCK_INITIALIZATION_GRACE_MS
    });
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>(resolve => { release = resolve; });
    await previous;
    let lock: PidDirectoryLockLease | undefined;
    try {
      lock = await this.acquireMutationLock();
      return await operation();
    } finally {
      try {
        if (lock) await lock.release();
      } finally {
        release();
      }
    }
  }

  private urlBase(): { base: string; scope: 'configured' | 'local' } | undefined {
    if (this.configuredBaseUrl) return { base: this.configuredBaseUrl, scope: 'configured' };
    if (this.localBaseUrl) return { base: this.localBaseUrl, scope: 'local' };
    return undefined;
  }

  private sign(metadata: ArtifactMetadata, expiresUnix: number): string {
    return createHmac('sha256', this.signingSecret)
      .update(`${metadata.artifact_id}\n${metadata.filename}\n${expiresUnix}\n${metadata.sha256}`, 'utf8')
      .digest('hex');
  }

  private withUrl(metadata: ArtifactMetadata): ArtifactInfo {
    const base = this.urlBase();
    if (!base) return metadata;
    const expiresUnix = Math.floor(new Date(metadata.expires_at).getTime() / 1000);
    const signature = this.sign(metadata, expiresUnix);
    const url = `${base.base}/artifacts/public/${encodeURIComponent(metadata.artifact_id)}/${encodeURIComponent(metadata.filename)}?expires=${expiresUnix}&sig=${signature}`;
    return { ...metadata, url, url_scope: base.scope };
  }

  private async loadMetadata(id: string): Promise<ArtifactMetadata> {
    const normalized = validateArtifactId(id);
    let payload: string;
    try {
      payload = await readFile(this.metadataPath(normalized), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Artifact not found: ${normalized}.`);
      throw error;
    }
    const metadata = parseMetadata(JSON.parse(payload) as unknown);
    if (metadata.artifact_id !== normalized) throw new Error('Artifact metadata id mismatch.');
    return metadata;
  }

  private assertNotExpired(metadata: ArtifactMetadata, now = Date.now()): void {
    const expiresAt = Date.parse(metadata.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new ArtifactExpiredError(metadata.artifact_id);
    }
  }

  private async verifyPayload(metadata: ArtifactMetadata): Promise<string> {
    const payload = this.payloadPath(metadata.artifact_id);
    const metadataOnDisk = await stat(payload).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Artifact payload missing: ${metadata.artifact_id}.`);
      throw error;
    });
    if (!metadataOnDisk.isFile()) throw new Error(`Artifact payload is not a regular file: ${metadata.artifact_id}.`);
    if (metadataOnDisk.size !== metadata.size_bytes) throw new Error(`Artifact payload size mismatch: ${metadata.artifact_id}.`);
    const digest = await fileSha256(payload);
    if (digest !== metadata.sha256) throw new Error(`Artifact payload checksum mismatch: ${metadata.artifact_id}.`);
    return payload;
  }

  private async storedPayloadBytesLocked(): Promise<number> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !ARTIFACT_ID_PATTERN.test(entry.name)) continue;
      const payloadInfo = await stat(this.payloadPath(entry.name)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (!payloadInfo) continue;
      if (!payloadInfo.isFile()) throw new Error(`Artifact payload is not a regular file: ${entry.name}.`);
      total += payloadInfo.size;
      if (!Number.isSafeInteger(total)) throw new Error('Artifact store size exceeds safe integer range.');
    }
    return total;
  }

  private async assertCapacityLocked(additionalBytes: number): Promise<void> {
    const current = await this.storedPayloadBytesLocked();
    if (current + additionalBytes > this.maxStoreBytes) {
      throw new Error(`Artifact store byte budget exceeded (${current} + ${additionalBytes} > ${this.maxStoreBytes}). Delete artifacts or wait for expiry before publishing more.`);
    }
  }

  async publishFromPath(
    sourcePath: string,
    policy: DesktopPolicy,
    options: PublishArtifactOptions = {}
  ): Promise<ArtifactInfo> {
    return this.serializeMutation(async () => {
      await this.cleanupLocked();
      const canonical = await policy.resolveReadPath(sourcePath);
      const sourceStat = await stat(canonical);
      if (!sourceStat.isFile()) throw new Error('Artifact publishing currently supports regular files only.');
      if (sourceStat.size <= 0) throw new Error('Artifact source file is empty.');
      if (sourceStat.size > MAX_ARTIFACT_BYTES) {
        throw new Error(`Artifact source exceeds ${MAX_ARTIFACT_BYTES} bytes.`);
      }
      await this.assertCapacityLocked(sourceStat.size);
      const seconds = retentionSeconds(options.retention_seconds);
      const id = newArtifactId();
      const dir = this.artifactDir(id);
      await mkdir(dir, { recursive: false, mode: 0o700 });
      const payload = this.payloadPath(id);
      try {
        await copyFile(canonical, payload);
        const copiedStat = await stat(payload);
        if (copiedStat.size !== sourceStat.size) throw new Error('Artifact copy size mismatch.');
        const digest = await fileSha256(payload);
        const now = new Date();
        const filename = safeFilename(canonical);
        const metadata: ArtifactMetadata = {
          schema_version: 1,
          artifact_id: id,
          filename,
          mime_type: mimeFromFilename(filename),
          size_bytes: copiedStat.size,
          sha256: digest,
          created_at: now.toISOString(),
          expires_at: new Date(now.getTime() + seconds * 1000).toISOString(),
          source_path: canonical
        };
        const temp = path.join(dir, '.metadata.tmp');
        await writeFile(temp, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await renameFileWithRetry(temp, this.metadataPath(id));
        return this.withUrl(metadata);
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async publishBytes(
    filename: string,
    data: Uint8Array,
    mimeType?: string,
    options: PublishArtifactOptions = {}
  ): Promise<ArtifactInfo> {
    return this.serializeMutation(async () => {
      await this.cleanupLocked();
      if (data.byteLength <= 0) throw new Error('Artifact payload is empty.');
      if (data.byteLength > MAX_ARTIFACT_BYTES) throw new Error(`Artifact payload exceeds ${MAX_ARTIFACT_BYTES} bytes.`);
      await this.assertCapacityLocked(data.byteLength);
      const seconds = retentionSeconds(options.retention_seconds);
      const id = newArtifactId();
      const dir = this.artifactDir(id);
      await mkdir(dir, { recursive: false, mode: 0o700 });
      try {
        const payload = this.payloadPath(id);
        await writeFile(payload, data, { mode: 0o600, flag: 'wx' });
        const now = new Date();
        const safe = safeFilename(filename);
        const metadata: ArtifactMetadata = {
          schema_version: 1,
          artifact_id: id,
          filename: safe,
          mime_type: mimeType?.trim() || mimeFromFilename(safe),
          size_bytes: data.byteLength,
          sha256: createHash('sha256').update(data).digest('hex'),
          created_at: now.toISOString(),
          expires_at: new Date(now.getTime() + seconds * 1000).toISOString()
        };
        await writeFile(this.metadataPath(id), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return this.withUrl(metadata);
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async get(id: string): Promise<ArtifactInfo> {
    const metadata = await this.loadMetadata(id);
    this.assertNotExpired(metadata);
    await this.verifyPayload(metadata);
    return this.withUrl(metadata);
  }

  async list(limit = 50): Promise<ArtifactInfo[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Artifact list limit must be between 1 and 200.');
    await this.cleanup();
    const entries = await readdir(this.root, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const out: ArtifactInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ARTIFACT_ID_PATTERN.test(entry.name)) continue;
      try {
        const metadata = await this.loadMetadata(entry.name);
        this.assertNotExpired(metadata);
        out.push(this.withUrl(metadata));
      } catch {
        // Corrupt/expired entries are isolated and will be cleaned on a future pass.
      }
    }
    out.sort((left, right) => right.created_at.localeCompare(left.created_at));
    return out.slice(0, limit);
  }

  async read(
    id: string,
    offset = 0,
    length = 64 * 1024,
    encoding: 'utf8' | 'base64' = 'base64'
  ): Promise<ArtifactReadResult> {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Artifact read offset must be a non-negative integer.');
    if (!Number.isInteger(length) || length < 1 || length > MAX_READ_BYTES) {
      throw new Error(`Artifact read length must be between 1 and ${MAX_READ_BYTES}.`);
    }
    const metadata = await this.loadMetadata(id);
    this.assertNotExpired(metadata);
    const payload = await this.verifyPayload(metadata);
    if (offset > metadata.size_bytes) throw new Error('Artifact read offset is beyond end of file.');
    const bytesToRead = Math.min(length, Math.max(0, metadata.size_bytes - offset));
    const handle = await open(payload, 'r');
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(bytesToRead);
      if (bytesToRead > 0) {
        const result = await handle.read(chunk, 0, bytesToRead, offset);
        chunk = chunk.subarray(0, result.bytesRead);
      }
    } finally {
      await handle.close();
    }
    const nextOffset = offset + chunk.byteLength;
    return {
      artifact: this.withUrl(metadata),
      offset,
      next_offset: nextOffset < metadata.size_bytes ? nextOffset : null,
      eof: nextOffset >= metadata.size_bytes,
      encoding,
      data: encoding === 'base64' ? chunk.toString('base64') : chunk.toString('utf8')
    };
  }

  async delete(id: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      const normalized = validateArtifactId(id);
      try {
        await stat(this.artifactDir(normalized));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      await rm(this.artifactDir(normalized), { recursive: true, force: true });
      return true;
    });
  }

  async cleanup(now = Date.now()): Promise<void> {
    await this.serializeMutation(() => this.cleanupLocked(now));
  }

  private async cleanupLocked(now = Date.now()): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !ARTIFACT_ID_PATTERN.test(entry.name)) continue;
      try {
        const metadata = await this.loadMetadata(entry.name);
        const expiresAt = Date.parse(metadata.expires_at);
        if (!Number.isFinite(expiresAt) || expiresAt <= now) {
          await rm(this.artifactDir(entry.name), { recursive: true, force: true });
        }
      } catch {
        // Remove malformed entries rather than retaining unbounded opaque payloads.
        await rm(this.artifactDir(entry.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async resolveSignedDownload(
    artifactId: string,
    filename: string,
    expiresRaw: string | null,
    signature: string | null
  ): Promise<{ readonly metadata: ArtifactMetadata; readonly payload: string }> {
    const metadata = await this.loadMetadata(artifactId);
    this.assertNotExpired(metadata);
    if (filename !== metadata.filename) throw new Error('Artifact filename mismatch.');
    if (!expiresRaw || !/^\d+$/u.test(expiresRaw) || !signature || !/^[0-9a-f]{64}$/u.test(signature)) {
      throw new Error('Invalid artifact signature parameters.');
    }
    const expiresUnix = Number(expiresRaw);
    if (!Number.isSafeInteger(expiresUnix) || expiresUnix <= Math.floor(Date.now() / 1000)) {
      throw new ArtifactExpiredError(metadata.artifact_id);
    }
    const metadataExpires = Math.floor(Date.parse(metadata.expires_at) / 1000);
    if (expiresUnix !== metadataExpires) throw new Error('Artifact signature expiry mismatch.');
    const expected = Buffer.from(this.sign(metadata, expiresUnix), 'hex');
    const provided = Buffer.from(signature, 'hex');
    if (expected.byteLength !== provided.byteLength || !timingSafeEqual(expected, provided)) {
      throw new Error('Artifact signature mismatch.');
    }
    return { metadata, payload: await this.verifyPayload(metadata) };
  }
}
