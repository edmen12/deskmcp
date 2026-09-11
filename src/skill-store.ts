import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseDocument } from 'yaml';
import { acquirePidDirectoryLock, type PidDirectoryLockLease } from './cross-process-lock.js';

interface UnzipperEntry {
  readonly path: string;
  readonly type: 'File' | 'Directory';
  readonly versionMadeBy: number;
  readonly externalFileAttributes: number;
  readonly uncompressedSize: number;
  readonly flags: number;
  stream(): Readable;
}

interface UnzipperDirectory {
  readonly files: readonly UnzipperEntry[];
}

const require = createRequire(import.meta.url);
const unzipper = require('unzipper') as {
  readonly Open: { file(zipPath: string): Promise<UnzipperDirectory> };
};

const REGISTRY_SCHEMA_VERSION = 1;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_MD_BYTES = 512 * 1024;
const MAX_FILES = 512;
const MAX_DEPTH = 8;
const MAX_RESOURCE_READ_BYTES = 512 * 1024;
const SKILL_LOCK_TIMEOUT_MS = 60_000;
const SKILL_LOCK_INITIALIZATION_GRACE_MS = 5_000;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_ID_PATTERN = /^sha256-[0-9a-f]{16}$/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly allowed_tools?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SkillVersionRecord {
  readonly version_id: string;
  readonly declared_version?: string;
  readonly digest_sha256: string;
  readonly installed_at: string;
  readonly source: {
    readonly kind: 'local' | 'remote';
    readonly origin?: string;
  };
  readonly description: string;
  readonly file_count: number;
  readonly total_bytes: number;
}

export interface InstalledSkillRecord {
  readonly name: string;
  readonly active_version_id?: string;
  readonly previous_active_version_id?: string;
  readonly versions: readonly SkillVersionRecord[];
}

interface SkillRegistryFile {
  readonly schema_version: number;
  readonly skills: readonly InstalledSkillRecord[];
}

export interface SkillValidationResult {
  readonly metadata: SkillMetadata;
  readonly digest_sha256: string;
  readonly declared_version?: string;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly files: readonly string[];
}

export type SkillPackageSource =
  | { readonly kind: 'local'; readonly path: string; readonly expected_sha256?: string }
  | { readonly kind: 'remote'; readonly url: string; readonly expected_sha256: string };

export interface SkillInstallResult {
  readonly skill: InstalledSkillRecord;
  readonly installed_version: SkillVersionRecord;
  readonly already_installed: boolean;
  readonly activated: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function normalizeSkillName(value: string): string {
  const name = value.trim();
  if (!SKILL_NAME_PATTERN.test(name) || name.includes('--')) {
    throw new Error('Skill name must be 1-64 lowercase letters, numbers, or hyphens, without leading/trailing/consecutive hyphens.');
  }
  return name;
}

function normalizeSha256(value: string | undefined, required: boolean): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    if (required) throw new Error('Remote Skill packages require expected_sha256.');
    return undefined;
  }
  if (!SHA256_PATTERN.test(normalized)) throw new Error('expected_sha256 must be exactly 64 hexadecimal characters.');
  return normalized;
}

function normalizeTextField(value: unknown, name: string, maxChars: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Skill frontmatter requires ${name}.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`Skill frontmatter ${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw new Error(`Skill frontmatter ${name} must not be empty.`);
    return undefined;
  }
  if (normalized.length > maxChars) throw new Error(`Skill frontmatter ${name} exceeds ${maxChars} characters.`);
  return normalized;
}

function parseFrontmatter(skillMd: string, parentName?: string): SkillMetadata {
  const firstLineEnd = skillMd.indexOf('\n');
  const firstLine = (firstLineEnd >= 0 ? skillMd.slice(0, firstLineEnd) : skillMd).replace(/\r$/u, '');
  if (firstLine !== '---') throw new Error('SKILL.md must begin with YAML frontmatter delimited by --- lines.');

  const lines = skillMd.split(/\r?\n/u);
  let closing = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === '---' || lines[index] === '...') {
      closing = index;
      break;
    }
  }
  if (closing < 0) throw new Error('SKILL.md YAML frontmatter is not closed.');
  const yamlText = lines.slice(1, closing).join('\n');
  const document = parseDocument(yamlText, { prettyErrors: true, strict: true });
  if (document.errors.length > 0) throw new Error(`SKILL.md frontmatter YAML is invalid: ${document.errors[0]!.message}`);
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SKILL.md frontmatter must be a YAML mapping.');
  const object = value as Record<string, unknown>;
  const name = normalizeSkillName(normalizeTextField(object.name, 'name', 64, true)!);
  if (parentName && name !== parentName) throw new Error(`Skill name ${name} must match its parent directory name ${parentName}.`);
  const description = normalizeTextField(object.description, 'description', 1024, true)!;
  const license = normalizeTextField(object.license, 'license', 1024);
  const compatibility = normalizeTextField(object.compatibility, 'compatibility', 500);
  const allowedTools = normalizeTextField(object['allowed-tools'], 'allowed-tools', 2048);

  const metadataValue = object.metadata;
  const metadata: Record<string, string> = {};
  if (metadataValue !== undefined) {
    if (!metadataValue || typeof metadataValue !== 'object' || Array.isArray(metadataValue)) {
      throw new Error('Skill frontmatter metadata must be a mapping of string keys to string values.');
    }
    for (const [key, item] of Object.entries(metadataValue as Record<string, unknown>)) {
      if (!key.trim() || key.length > 128 || typeof item !== 'string' || item.length > 1024) {
        throw new Error('Skill metadata keys must be non-empty <=128 chars and values must be strings <=1024 chars.');
      }
      metadata[key] = item;
    }
  }

  return {
    name,
    description,
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(allowedTools ? { allowed_tools: allowedTools } : {}),
    metadata
  };
}

function normalizeRelativeResource(value: string | undefined): string {
  const normalized = safePackagePath(value?.trim() || 'SKILL.md', 'Skill resource path');
  if (normalized.split('/').filter(Boolean).length > MAX_DEPTH + 1) {
    throw new Error(`Skill resource path exceeds maximum depth ${MAX_DEPTH}.`);
  }
  return normalized;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await rename(temp, filePath); }
  catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseRegistry(value: unknown): SkillRegistryFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill registry is invalid.');
  const candidate = value as Partial<SkillRegistryFile>;
  if (candidate.schema_version !== REGISTRY_SCHEMA_VERSION || !Array.isArray(candidate.skills)) {
    throw new Error(`Unsupported Skill registry schema: ${String(candidate.schema_version)}.`);
  }
  const names = new Set<string>();
  const skills: InstalledSkillRecord[] = candidate.skills.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('Skill registry entry is invalid.');
    const entry = raw as Partial<InstalledSkillRecord>;
    if (typeof entry.name !== 'string' || !Array.isArray(entry.versions)) throw new Error('Skill registry entry is incomplete.');
    const name = normalizeSkillName(entry.name);
    if (names.has(name)) throw new Error(`Duplicate Skill registry entry: ${name}.`);
    names.add(name);
    const versions = entry.versions.map(version => {
      if (!version || typeof version !== 'object') throw new Error(`Skill ${name} has an invalid version entry.`);
      const item = version as Partial<SkillVersionRecord>;
      if (
        typeof item.version_id !== 'string'
        || !VERSION_ID_PATTERN.test(item.version_id)
        || typeof item.digest_sha256 !== 'string'
        || !SHA256_PATTERN.test(item.digest_sha256)
        || item.version_id !== `sha256-${item.digest_sha256.slice(0, 16)}`
        || typeof item.installed_at !== 'string'
        || typeof item.description !== 'string'
        || typeof item.file_count !== 'number'
        || !Number.isInteger(item.file_count)
        || item.file_count < 0
        || typeof item.total_bytes !== 'number'
        || !Number.isInteger(item.total_bytes)
        || item.total_bytes < 0
        || !item.source
        || (item.source.kind !== 'local' && item.source.kind !== 'remote')
      ) throw new Error(`Skill ${name} has an invalid version entry.`);
      const declaredVersion = typeof item.declared_version === 'string' ? item.declared_version.trim() : undefined;
      if (declaredVersion && declaredVersion.length > 128) throw new Error(`Skill ${name} has an invalid declared version.`);
      return {
        version_id: item.version_id,
        ...(declaredVersion ? { declared_version: declaredVersion } : {}),
        digest_sha256: item.digest_sha256,
        installed_at: item.installed_at,
        source: {
          kind: item.source.kind,
          ...(typeof item.source.origin === 'string' ? { origin: item.source.origin } : {})
        },
        description: item.description,
        file_count: item.file_count,
        total_bytes: item.total_bytes
      } satisfies SkillVersionRecord;
    });
    const versionIds = new Set(versions.map(item => item.version_id));
    if (versionIds.size !== versions.length) throw new Error(`Skill ${name} has duplicate version ids.`);
    const declaredVersions = new Map<string, string>();
    for (const version of versions) {
      if (!version.declared_version) continue;
      const existingDigest = declaredVersions.get(version.declared_version);
      if (existingDigest && existingDigest !== version.digest_sha256) {
        throw new Error(`Skill ${name} declared version ${version.declared_version} maps to multiple digests.`);
      }
      declaredVersions.set(version.declared_version, version.digest_sha256);
    }
    if (entry.active_version_id !== undefined && (typeof entry.active_version_id !== 'string' || !versionIds.has(entry.active_version_id))) {
      throw new Error(`Skill ${name} active version is invalid.`);
    }
    if (entry.previous_active_version_id !== undefined && (typeof entry.previous_active_version_id !== 'string' || !versionIds.has(entry.previous_active_version_id))) {
      throw new Error(`Skill ${name} previous active version is invalid.`);
    }
    return {
      name,
      ...(entry.active_version_id ? { active_version_id: entry.active_version_id } : {}),
      ...(entry.previous_active_version_id ? { previous_active_version_id: entry.previous_active_version_id } : {}),
      versions
    };
  });
  return { schema_version: REGISTRY_SCHEMA_VERSION, skills };
}

function validatePortableSegment(segment: string, label: string): void {
  if (!segment || segment === '.' || segment === '..') throw new Error(`${label} contains an unsafe path segment.`);
  if (segment.length > 255) throw new Error(`${label} contains a path segment longer than 255 characters.`);
  if (/[ -<>:"|?*]/u.test(segment)) throw new Error(`${label} contains characters unsafe on Windows.`);
  if (/[. ]$/u.test(segment)) throw new Error(`${label} contains a segment ending in a dot or space.`);
  if (WINDOWS_DEVICE_NAME_PATTERN.test(segment)) throw new Error(`${label} contains a reserved Windows device name.`);
}

function safePackagePath(value: string, label: string): string {
  const slash = value.replaceAll('\\', '/');
  if (!slash || slash.includes('\0') || slash.startsWith('/') || /^[A-Za-z]:\//u.test(slash)) {
    throw new Error(`${label} is not a safe relative package path.`);
  }
  const hasTrailingSlash = slash.endsWith('/');
  const rawSegments = slash.split('/');
  if (rawSegments.some((segment, index) => !segment && index !== rawSegments.length - 1)) {
    throw new Error(`${label} contains an empty path segment.`);
  }
  const segments = rawSegments.filter(Boolean);
  if (segments.length === 0 || segments.length > MAX_DEPTH + 2) {
    throw new Error(`${label} exceeds the package depth limit.`);
  }
  for (const segment of segments) validatePortableSegment(segment, label);
  const normalized = segments.join('/');
  if (normalized.length > 512) throw new Error(`${label} exceeds 512 characters.`);
  return hasTrailingSlash ? `${normalized}/` : normalized;
}

function isZipSymlink(entry: UnzipperEntry): boolean {
  const platform = entry.versionMadeBy >> 8;
  if (platform !== 3) return false;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
  const directory = await unzipper.Open.file(zipPath);
  if (directory.files.length > MAX_FILES + 128) throw new Error(`Skill ZIP has too many entries: ${directory.files.length}.`);
  let fileCount = 0;
  let totalBytes = 0;
  const resolvedDestination = path.resolve(destination);

  for (const entry of directory.files) {
    const relative = safePackagePath(entry.path, `ZIP entry ${JSON.stringify(entry.path)}`);
    if ((entry.flags & 0x1) !== 0) throw new Error(`Skill ZIP contains an encrypted entry: ${entry.path}.`);
    if (isZipSymlink(entry)) throw new Error(`Skill ZIP contains a symbolic link: ${entry.path}.`);
    const isDirectory = entry.type === 'Directory' || relative.endsWith('/');
    const target = path.join(destination, ...relative.split('/').filter(Boolean));
    const resolvedTarget = path.resolve(target);
    if (!isWithin(resolvedDestination, resolvedTarget)) throw new Error(`ZIP entry escapes extraction root: ${entry.path}.`);
    if (isDirectory) {
      await mkdir(resolvedTarget, { recursive: true, mode: 0o700 });
      continue;
    }

    const declaredSize = entry.uncompressedSize;
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) throw new Error(`Skill ZIP entry has an invalid size: ${entry.path}.`);
    fileCount += 1;
    totalBytes += declaredSize;
    if (fileCount > MAX_FILES) throw new Error(`Skill package exceeds ${MAX_FILES} files.`);
    if (declaredSize > MAX_FILE_BYTES) throw new Error(`Skill file exceeds ${MAX_FILE_BYTES} bytes: ${entry.path}.`);
    if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`Skill package exceeds ${MAX_PACKAGE_BYTES} uncompressed bytes.`);

    await mkdir(path.dirname(resolvedTarget), { recursive: true, mode: 0o700 });
    let written = 0;
    const source = entry.stream();
    const limiter = async function* () {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        written += buffer.length;
        if (written > declaredSize || written > MAX_FILE_BYTES) {
          throw new Error(`Skill ZIP entry expanded beyond its declared size: ${entry.path}.`);
        }
        yield buffer;
      }
    };
    try {
      await pipeline(Readable.from(limiter()), createWriteStream(resolvedTarget, { flags: 'wx', mode: 0o600 }));
      if (written !== declaredSize) throw new Error(`Skill ZIP entry size mismatch: ${entry.path}.`);
    } catch (error) {
      await rm(resolvedTarget, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function downloadHttpsZip(urlValue: string, destination: string, expectedSha256: string): Promise<string> {
  let url = new URL(urlValue.trim());
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Remote Skill source must be an HTTPS URL without embedded credentials.');
  }
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Remote Skill redirect did not include Location.');
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || next.username || next.password) throw new Error('Remote Skill redirect must remain HTTPS without embedded credentials.');
      url = next;
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Remote Skill download failed with HTTP ${response.status}.`);
    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) throw new Error(`Remote Skill archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
    const hash = createHash('sha256');
    let received = 0;
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
    const limiter = async function* () {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        received += buffer.length;
        if (received > MAX_ARCHIVE_BYTES) throw new Error(`Remote Skill archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
        hash.update(buffer);
        yield buffer;
      }
    };
    await pipeline(Readable.from(limiter()), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    const actual = hash.digest('hex');
    if (actual !== expectedSha256) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw new Error(`Remote Skill SHA-256 mismatch: expected ${expectedSha256}, got ${actual}.`);
    }
    return url.origin;
  }
  throw new Error('Remote Skill download exceeded 5 HTTPS redirects.');
}

async function sha256File(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function copyAndValidateDirectory(
  sourceRoot: string,
  destination: string,
  parentNameOverride?: string
): Promise<SkillValidationResult> {
  const canonicalSource = await realpath(sourceRoot);
  const sourceInfo = await stat(canonicalSource);
  if (!sourceInfo.isDirectory()) throw new Error('Skill source must resolve to a directory.');
  const parentName = normalizeSkillName(parentNameOverride ?? path.basename(canonicalSource));
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const manifest: Array<{ relative: string; sha256: string; size: number }> = [];
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(current: string, relativeDir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error(`Skill package exceeds maximum directory depth ${MAX_DEPTH}.`);
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = safePackagePath(
        relativeDir ? `${relativeDir}/${entry.name}` : entry.name,
        `Skill package entry ${JSON.stringify(entry.name)}`
      );
      const sourcePath = path.join(current, entry.name);
      const entryInfo = await lstat(sourcePath);
      if (entryInfo.isSymbolicLink()) throw new Error(`Skill package contains a symbolic link: ${relative}.`);
      const canonical = await realpath(sourcePath);
      if (!isWithin(canonicalSource, canonical)) throw new Error(`Skill package entry escapes source root: ${relative}.`);
      const target = path.join(destination, ...relative.split('/'));
      if (entryInfo.isDirectory()) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        await walk(canonical, relative, depth + 1);
        continue;
      }
      if (!entryInfo.isFile()) throw new Error(`Skill package contains unsupported filesystem entry: ${relative}.`);
      fileCount += 1;
      totalBytes += entryInfo.size;
      if (fileCount > MAX_FILES) throw new Error(`Skill package exceeds ${MAX_FILES} files.`);
      if (entryInfo.size > MAX_FILE_BYTES) throw new Error(`Skill file exceeds ${MAX_FILE_BYTES} bytes: ${relative}.`);
      if (relative === 'SKILL.md' && entryInfo.size > MAX_SKILL_MD_BYTES) throw new Error(`SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes.`);
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`Skill package exceeds ${MAX_PACKAGE_BYTES} bytes.`);
      const bytes = await readFile(canonical);
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      manifest.push({ relative, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    }
  }

  await walk(canonicalSource, '', 0);
  const skillMdPath = path.join(destination, 'SKILL.md');
  const skillMdInfo = await stat(skillMdPath).catch(() => undefined);
  if (!skillMdInfo?.isFile()) throw new Error('Skill package is missing SKILL.md at its root.');
  const skillMd = await readFile(skillMdPath, 'utf8');
  const metadata = parseFrontmatter(skillMd, parentName);
  manifest.sort((a, b) => a.relative.localeCompare(b.relative));
  const digest = createHash('sha256');
  for (const item of manifest) digest.update(`${item.relative}\0${item.size}\0${item.sha256}\n`, 'utf8');
  const digestSha256 = digest.digest('hex');
  const declaredVersion = metadata.metadata.version?.trim() || undefined;
  if (declaredVersion && declaredVersion.length > 128) throw new Error('Skill metadata.version exceeds 128 characters.');
  return {
    metadata,
    digest_sha256: digestSha256,
    ...(declaredVersion ? { declared_version: declaredVersion } : {}),
    file_count: fileCount,
    total_bytes: totalBytes,
    files: manifest.map(item => item.relative)
  };
}

async function verifyInstalledDirectory(
  installedRoot: string,
  expected: SkillVersionRecord
): Promise<Map<string, { readonly sha256: string; readonly size: number }>> {
  const installedInfo = await lstat(installedRoot).catch(() => {
    throw new Error(`Skill installed package integrity check failed: ${expected.version_id} is missing.`);
  });
  if (installedInfo.isSymbolicLink()) {
    throw new Error(`Skill installed package integrity check failed: ${expected.version_id} package root is a symbolic link.`);
  }
  if (!installedInfo.isDirectory()) {
    throw new Error(`Skill installed package integrity check failed: ${expected.version_id} is not a directory.`);
  }
  const canonicalRoot = await realpath(installedRoot);

  const manifest: Array<{ relative: string; sha256: string; size: number }> = [];
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(current: string, relativeDir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error(`Skill installed package integrity check failed: maximum directory depth exceeded.`);
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = safePackagePath(
        relativeDir ? `${relativeDir}/${entry.name}` : entry.name,
        `Installed Skill package entry ${JSON.stringify(entry.name)}`
      );
      const candidate = path.join(current, entry.name);
      const entryInfo = await lstat(candidate);
      if (entryInfo.isSymbolicLink()) throw new Error(`Skill installed package integrity check failed: symbolic link detected at ${relative}.`);
      const canonical = await realpath(candidate);
      if (!isWithin(canonicalRoot, canonical)) throw new Error(`Skill installed package integrity check failed: ${relative} escapes the package root.`);
      if (entryInfo.isDirectory()) {
        await walk(canonical, relative, depth + 1);
        continue;
      }
      if (!entryInfo.isFile()) throw new Error(`Skill installed package integrity check failed: unsupported entry ${relative}.`);
      fileCount += 1;
      totalBytes += entryInfo.size;
      if (fileCount > MAX_FILES || entryInfo.size > MAX_FILE_BYTES || totalBytes > MAX_PACKAGE_BYTES) {
        throw new Error(`Skill installed package integrity check failed: package safety limits were exceeded.`);
      }
      const bytes = await readFile(canonical);
      manifest.push({ relative, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    }
  }

  await walk(canonicalRoot, '', 0);
  if (!manifest.some(item => item.relative === 'SKILL.md')) {
    throw new Error(`Skill installed package integrity check failed: SKILL.md is missing.`);
  }
  manifest.sort((a, b) => a.relative.localeCompare(b.relative));
  const digest = createHash('sha256');
  for (const item of manifest) digest.update(`${item.relative}\0${item.size}\0${item.sha256}\n`, 'utf8');
  const digestSha256 = digest.digest('hex');
  if (
    digestSha256 !== expected.digest_sha256
    || fileCount !== expected.file_count
    || totalBytes !== expected.total_bytes
  ) {
    throw new Error(`Skill installed package integrity check failed for ${expected.version_id}: files changed after installation.`);
  }
  return new Map(manifest.map(item => [item.relative, { sha256: item.sha256, size: item.size }]));
}

async function chooseExtractedSkillRoot(extractedRoot: string): Promise<{ root: string; logicalName?: string }> {
  const direct = path.join(extractedRoot, 'SKILL.md');
  if ((await stat(direct).catch(() => undefined))?.isFile()) {
    const metadata = parseFrontmatter(await readFile(direct, 'utf8'));
    return { root: extractedRoot, logicalName: metadata.name };
  }
  const entries = (await readdir(extractedRoot, { withFileTypes: true })).filter(entry => entry.name !== '__MACOSX');
  const directories = entries.filter(entry => entry.isDirectory());
  const files = entries.filter(entry => !entry.isDirectory());
  if (files.length === 0 && directories.length === 1) {
    const candidate = path.join(extractedRoot, directories[0]!.name);
    if ((await stat(path.join(candidate, 'SKILL.md')).catch(() => undefined))?.isFile()) return { root: candidate };
  }
  throw new Error('Skill ZIP must contain SKILL.md at the archive root or inside exactly one top-level Skill directory.');
}

export class SkillStore {
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(readonly root: string) {}

  private get registryPath(): string { return path.join(this.root, 'registry.json'); }
  private get packagesRoot(): string { return path.join(this.root, 'packages'); }
  private get stagingRoot(): string { return path.join(this.root, '.staging'); }
  private get mutationLockPath(): string { return path.join(this.root, '.skills.lock'); }

  async init(): Promise<void> {
    await mkdir(this.packagesRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    await this.serializeMutation(async () => {
      try { await this.load(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await this.save({ schema_version: REGISTRY_SCHEMA_VERSION, skills: [] });
      }
      const stale = await readdir(this.stagingRoot).catch(() => [] as string[]);
      for (const entry of stale) await rm(path.join(this.stagingRoot, entry), { recursive: true, force: true }).catch(() => undefined);
    });
  }

  private async acquireMutationLock(): Promise<PidDirectoryLockLease> {
    return acquirePidDirectoryLock(this.mutationLockPath, {
      label: 'Skill store',
      timeoutMs: SKILL_LOCK_TIMEOUT_MS,
      initializationGraceMs: SKILL_LOCK_INITIALIZATION_GRACE_MS
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

  private async load(): Promise<SkillRegistryFile> {
    const info = await stat(this.registryPath);
    if (info.size > MAX_REGISTRY_BYTES) throw new Error('Skill registry exceeds maximum size.');
    return parseRegistry(JSON.parse(await readFile(this.registryPath, 'utf8')) as unknown);
  }

  private async save(registry: SkillRegistryFile): Promise<void> {
    await atomicWriteJson(this.registryPath, registry);
  }

  private versionPath(name: string, versionId: string): string {
    return path.join(this.packagesRoot, name, versionId);
  }

  private async assertVersionIntegrity(
    skillName: string,
    version: SkillVersionRecord
  ): Promise<Map<string, { readonly sha256: string; readonly size: number }>> {
    return verifyInstalledDirectory(this.versionPath(skillName, version.version_id), version);
  }

  private async prepareSource(source: SkillPackageSource): Promise<{
    root: string;
    logicalName?: string;
    origin?: string;
    cleanup: () => Promise<void>;
  }> {
    const tempRoot = path.join(this.stagingRoot, `source-${randomUUID()}`);
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    try {
      if (source.kind === 'remote') {
        const expected = normalizeSha256(source.expected_sha256, true)!;
        const zipPath = path.join(tempRoot, 'package.zip');
        const origin = await downloadHttpsZip(source.url, zipPath, expected);
        const extracted = path.join(tempRoot, 'extracted');
        await mkdir(extracted, { recursive: true, mode: 0o700 });
        await extractZip(zipPath, extracted);
        const chosen = await chooseExtractedSkillRoot(extracted);
        return { ...chosen, origin, cleanup: () => rm(tempRoot, { recursive: true, force: true }) };
      }

      const expected = normalizeSha256(source.expected_sha256, false);
      const info = await stat(source.path);
      if (info.isDirectory()) {
        return { root: source.path, cleanup: () => rm(tempRoot, { recursive: true, force: true }) };
      }
      if (!info.isFile()) throw new Error('Local Skill source must be a directory or ZIP file.');
      if (info.size > MAX_ARCHIVE_BYTES) throw new Error(`Local Skill ZIP exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
      if (expected) {
        const actual = await sha256File(source.path);
        if (actual !== expected) throw new Error(`Local Skill ZIP SHA-256 mismatch: expected ${expected}, got ${actual}.`);
      }
      const extracted = path.join(tempRoot, 'extracted');
      await mkdir(extracted, { recursive: true, mode: 0o700 });
      await extractZip(source.path, extracted);
      const chosen = await chooseExtractedSkillRoot(extracted);
      return { ...chosen, cleanup: () => rm(tempRoot, { recursive: true, force: true }) };
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async validate(source: SkillPackageSource): Promise<SkillValidationResult> {
    return this.serializeMutation(async () => {
      const prepared = await this.prepareSource(source);
      const validateRoot = path.join(this.stagingRoot, `validate-${randomUUID()}`);
      try {
        return await copyAndValidateDirectory(prepared.root, validateRoot, prepared.logicalName);
      } finally {
        await rm(validateRoot, { recursive: true, force: true }).catch(() => undefined);
        await prepared.cleanup().catch(() => undefined);
      }
    });
  }

  async install(source: SkillPackageSource, activate = true): Promise<SkillInstallResult> {
    return this.serializeMutation(async () => {
      const prepared = await this.prepareSource(source);
      const candidateRoot = path.join(this.stagingRoot, `install-${randomUUID()}`);
      try {
        const validation = await copyAndValidateDirectory(prepared.root, candidateRoot, prepared.logicalName);
        const registry = await this.load();
        const existing = registry.skills.find(skill => skill.name === validation.metadata.name);
        const mutableConflict = existing?.versions.find(version =>
          validation.declared_version
          && version.declared_version === validation.declared_version
          && version.digest_sha256 !== validation.digest_sha256
        );
        if (mutableConflict) {
          throw new Error(`Skill ${validation.metadata.name} version ${validation.declared_version} is already installed with a different digest.`);
        }
        const same = existing?.versions.find(version => version.digest_sha256 === validation.digest_sha256);
        if (same) {
          await this.assertVersionIntegrity(existing!.name, same);
          let skill = existing!;
          let activated = false;
          if (activate && skill.active_version_id !== same.version_id) {
            skill = {
              ...skill,
              ...(skill.active_version_id ? { previous_active_version_id: skill.active_version_id } : {}),
              active_version_id: same.version_id
            };
            await this.save({
              schema_version: REGISTRY_SCHEMA_VERSION,
              skills: registry.skills.map(item => item.name === skill.name ? skill : item)
            });
            activated = true;
          }
          return { skill, installed_version: same, already_installed: true, activated };
        }

        const versionId = `sha256-${validation.digest_sha256.slice(0, 16)}`;
        const targetRoot = this.versionPath(validation.metadata.name, versionId);
        await mkdir(path.dirname(targetRoot), { recursive: true, mode: 0o700 });
        if (await stat(targetRoot).catch(() => undefined)) throw new Error(`Skill package destination already exists: ${versionId}.`);
        await rename(candidateRoot, targetRoot);
        const installedVersion: SkillVersionRecord = {
          version_id: versionId,
          ...(validation.declared_version ? { declared_version: validation.declared_version } : {}),
          digest_sha256: validation.digest_sha256,
          installed_at: new Date().toISOString(),
          source: {
            kind: source.kind,
            ...(prepared.origin ? { origin: prepared.origin } : {})
          },
          description: validation.metadata.description,
          file_count: validation.file_count,
          total_bytes: validation.total_bytes
        };
        const nextSkill: InstalledSkillRecord = existing
          ? {
              ...existing,
              ...(activate && existing.active_version_id ? { previous_active_version_id: existing.active_version_id } : existing.previous_active_version_id ? { previous_active_version_id: existing.previous_active_version_id } : {}),
              ...(activate ? { active_version_id: versionId } : existing.active_version_id ? { active_version_id: existing.active_version_id } : {}),
              versions: [...existing.versions, installedVersion]
            }
          : {
              name: validation.metadata.name,
              ...(activate ? { active_version_id: versionId } : {}),
              versions: [installedVersion]
            };
        const nextRegistry: SkillRegistryFile = {
          schema_version: REGISTRY_SCHEMA_VERSION,
          skills: existing
            ? registry.skills.map(item => item.name === nextSkill.name ? nextSkill : item)
            : [...registry.skills, nextSkill].sort((a, b) => a.name.localeCompare(b.name))
        };
        try { await this.save(nextRegistry); }
        catch (error) {
          await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        return { skill: nextSkill, installed_version: installedVersion, already_installed: false, activated: activate };
      } finally {
        await rm(candidateRoot, { recursive: true, force: true }).catch(() => undefined);
        await prepared.cleanup().catch(() => undefined);
      }
    });
  }

  async list(): Promise<readonly InstalledSkillRecord[]> {
    return (await this.load()).skills;
  }

  async get(nameValue: string): Promise<InstalledSkillRecord> {
    const name = normalizeSkillName(nameValue);
    const skill = (await this.load()).skills.find(item => item.name === name);
    if (!skill) throw new Error(`Skill not installed: ${name}.`);
    return skill;
  }

  private resolveVersion(skill: InstalledSkillRecord, selector?: string): SkillVersionRecord {
    const selected = selector?.trim();
    if (!selected) {
      if (!skill.active_version_id) throw new Error(`Skill ${skill.name} has no active version.`);
      return skill.versions.find(version => version.version_id === skill.active_version_id)!;
    }
    const matches = skill.versions.filter(version => version.version_id === selected || version.declared_version === selected);
    if (matches.length === 0) throw new Error(`Skill ${skill.name} version not installed: ${selected}.`);
    if (matches.length > 1) throw new Error(`Skill ${skill.name} version selector is ambiguous: ${selected}.`);
    return matches[0]!;
  }

  async read(nameValue: string, resourcePath?: string, versionSelector?: string, maxChars = 100_000): Promise<{
    readonly name: string;
    readonly version: SkillVersionRecord;
    readonly resource_path: string;
    readonly content: string;
    readonly truncated: boolean;
  }> {
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200_000) throw new Error('Skill max_chars must be between 1 and 200000.');
    const skill = await this.get(nameValue);
    const version = this.resolveVersion(skill, versionSelector);
    const integrity = await this.assertVersionIntegrity(skill.name, version);
    const relative = normalizeRelativeResource(resourcePath);
    const root = this.versionPath(skill.name, version.version_id);
    const target = path.join(root, ...relative.split('/'));
    const canonicalRoot = await realpath(root);
    const canonicalTarget = await realpath(target);
    if (!isWithin(canonicalRoot, canonicalTarget)) throw new Error('Skill resource escapes installed package root.');
    const info = await stat(canonicalTarget);
    if (!info.isFile()) throw new Error(`Skill resource is not a file: ${relative}.`);
    if (info.size > MAX_RESOURCE_READ_BYTES) throw new Error(`Skill resource exceeds ${MAX_RESOURCE_READ_BYTES} bytes.`);
    const bytes = await readFile(canonicalTarget);
    const expectedResource = integrity.get(relative);
    const actualResourceSha = createHash('sha256').update(bytes).digest('hex');
    if (!expectedResource || expectedResource.size !== bytes.length || expectedResource.sha256 !== actualResourceSha) {
      throw new Error(`Skill installed package integrity check failed for ${version.version_id}: ${relative} changed during read.`);
    }
    if (bytes.includes(0)) throw new Error('Skill resource appears to be binary; use DeskMCP file/artifact tools for binary assets instead.');
    const text = bytes.toString('utf8');
    return {
      name: skill.name,
      version,
      resource_path: relative,
      content: text.slice(0, maxChars),
      truncated: text.length > maxChars
    };
  }

  async activate(nameValue: string, versionSelector: string): Promise<InstalledSkillRecord> {
    return this.serializeMutation(async () => {
      const registry = await this.load();
      const name = normalizeSkillName(nameValue);
      const skill = registry.skills.find(item => item.name === name);
      if (!skill) throw new Error(`Skill not installed: ${name}.`);
      const selected = this.resolveVersion(skill, versionSelector);
      await this.assertVersionIntegrity(skill.name, selected);
      if (skill.active_version_id === selected.version_id) return skill;
      const next: InstalledSkillRecord = {
        ...skill,
        ...(skill.active_version_id ? { previous_active_version_id: skill.active_version_id } : {}),
        active_version_id: selected.version_id
      };
      await this.save({ schema_version: REGISTRY_SCHEMA_VERSION, skills: registry.skills.map(item => item.name === name ? next : item) });
      return next;
    });
  }

  async rollback(nameValue: string): Promise<InstalledSkillRecord> {
    return this.serializeMutation(async () => {
      const registry = await this.load();
      const name = normalizeSkillName(nameValue);
      const skill = registry.skills.find(item => item.name === name);
      if (!skill) throw new Error(`Skill not installed: ${name}.`);
      if (!skill.previous_active_version_id) throw new Error(`Skill ${name} has no previous active version to roll back to.`);
      const previous = skill.versions.find(version => version.version_id === skill.previous_active_version_id);
      if (!previous) throw new Error(`Skill ${name} previous active version is no longer installed.`);
      await this.assertVersionIntegrity(skill.name, previous);
      const next: InstalledSkillRecord = {
        ...skill,
        active_version_id: skill.previous_active_version_id,
        ...(skill.active_version_id ? { previous_active_version_id: skill.active_version_id } : {})
      };
      await this.save({ schema_version: REGISTRY_SCHEMA_VERSION, skills: registry.skills.map(item => item.name === name ? next : item) });
      return next;
    });
  }
}
