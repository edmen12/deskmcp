import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.js';

export type PermissionProfile = 'read-only' | 'workspace-write' | 'full-control';

export class PolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}

export interface DesktopPolicyInfo {
  readonly profile: PermissionProfile;
  readonly allowedRoots: readonly string[];
  readonly processToolsEnabled: boolean;
  readonly writeEnabled: boolean;
  readonly allowSensitivePaths: boolean;
}

export interface DesktopPolicyOptions {
  readonly profile?: string;
  readonly allowedRoots?: readonly string[];
  readonly allowSensitivePaths?: boolean;
}interface AllowedRoot {
  readonly declared: string;
  readonly canonical: string;
}

function parseProfile(raw: string | undefined): PermissionProfile {
  const value = raw ?? 'read-only';
  if (value === 'read-only' || value === 'workspace-write' || value === 'full-control') {
    return value;
  }
  throw new Error(`Invalid DESKTOP_MCP_PROFILE: ${value}`);
}

function parseRoots(raw: string | undefined): string[] {
  if (!raw?.trim()) return [PROJECT_ROOT];
  const roots = raw.split(';').map(value => value.trim()).filter(Boolean);
  if (roots.length === 0) {
    throw new Error('DESKTOP_MCP_ALLOWED_ROOTS must not be empty.');
  }
  return roots;
}

function parseBoolean(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(
    comparisonPath(root),
    comparisonPath(candidate)
  );
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveInputPath(raw: string): string {
  if (!raw.trim()) throw new PolicyDeniedError('Path must not be empty.');
  return path.resolve(PROJECT_ROOT, raw);
}

function isSensitivePath(candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts.at(-1) ?? '';
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (['.npmrc', '.pypirc', '.netrc'].includes(basename)) return true;
  if (parts.includes('.ssh') || parts.includes('.gnupg')) return true;
  return parts.includes('.aws') && basename === 'credentials';
}export class DesktopPolicy {
  private constructor(
    readonly profile: PermissionProfile,
    private readonly roots: readonly AllowedRoot[],
    readonly allowSensitivePaths: boolean
  ) {}

  static async create(options: DesktopPolicyOptions = {}): Promise<DesktopPolicy> {
    const profile = parseProfile(options.profile ?? process.env.DESKTOP_MCP_PROFILE);
    const configured = options.allowedRoots
      ? [...options.allowedRoots]
      : parseRoots(process.env.DESKTOP_MCP_ALLOWED_ROOTS);
    const allowSensitivePaths = options.allowSensitivePaths
      ?? parseBoolean(process.env.DESKTOP_MCP_ALLOW_SENSITIVE_PATHS);

    if (configured.length === 0) {
      throw new Error('At least one allowed root is required.');
    }

    const roots: AllowedRoot[] = [];
    for (const root of configured) {
      const declared = path.resolve(PROJECT_ROOT, root);
      const metadata = await stat(declared);
      if (!metadata.isDirectory()) {
        throw new Error(`Allowed root is not a directory: ${declared}`);
      }
      roots.push({ declared, canonical: await realpath(declared) });
    }
    return new DesktopPolicy(profile, roots, allowSensitivePaths);
  }  get allowedRoots(): readonly string[] {
    return this.roots.map(root => root.canonical);
  }

  info(): DesktopPolicyInfo {
    return {
      profile: this.profile,
      allowedRoots: [...this.allowedRoots],
      processToolsEnabled: this.profile === 'full-control',
      writeEnabled: this.profile !== 'read-only',
      allowSensitivePaths: this.allowSensitivePaths
    };
  }

  canWrite(): boolean {
    return this.profile !== 'read-only';
  }

  assertCanWrite(): void {
    if (!this.canWrite()) {
      throw new PolicyDeniedError('Write denied by DESKTOP_MCP_PROFILE=read-only.');
    }
  }

  private assertSensitiveAllowed(candidate: string): void {
    if (!this.allowSensitivePaths && isSensitivePath(candidate)) {
      throw new PolicyDeniedError(
        'Sensitive path denied. Set DESKTOP_MCP_ALLOW_SENSITIVE_PATHS=true locally to allow it.'
      );
    }
  }  private assertLexicallyAllowed(candidate: string): void {
    if (!this.roots.some(root => isWithin(root.declared, candidate))) {
      throw new PolicyDeniedError(
        `Path is outside DESKTOP_MCP_ALLOWED_ROOTS: ${candidate}`
      );
    }
    this.assertSensitiveAllowed(candidate);
  }

  private assertCanonicallyAllowed(candidate: string): void {
    if (!this.roots.some(root => isWithin(root.canonical, candidate))) {
      throw new PolicyDeniedError(
        `Canonical path escapes DESKTOP_MCP_ALLOWED_ROOTS: ${candidate}`
      );
    }
    this.assertSensitiveAllowed(candidate);
  }

  async resolveReadPath(raw: string): Promise<string> {
    const candidate = resolveInputPath(raw);
    this.assertLexicallyAllowed(candidate);
    const canonical = await realpath(candidate);
    this.assertCanonicallyAllowed(canonical);
    return canonical;
  }

  async resolveWritePath(raw: string): Promise<string> {
    this.assertCanWrite();
    const candidate = resolveInputPath(raw);
    this.assertLexicallyAllowed(candidate);    try {
      const canonical = await realpath(candidate);
      this.assertCanonicallyAllowed(canonical);
      return canonical;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }

    const canonicalParent = await realpath(path.dirname(candidate));
    this.assertCanonicallyAllowed(canonicalParent);
    const target = path.join(canonicalParent, path.basename(candidate));
    this.assertSensitiveAllowed(target);
    return target;
  }

  async resolveNewWritePath(raw: string): Promise<string> {
    this.assertCanWrite();
    const candidate = resolveInputPath(raw);
    this.assertLexicallyAllowed(candidate);

    try {
      await realpath(candidate);
      throw new PolicyDeniedError(`Destination already exists: ${candidate}`);
    } catch (error) {
      if (error instanceof PolicyDeniedError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const canonicalParent = await realpath(path.dirname(candidate));
    this.assertCanonicallyAllowed(canonicalParent);
    const target = path.join(canonicalParent, path.basename(candidate));
    this.assertSensitiveAllowed(target);
    return target;
  }}
