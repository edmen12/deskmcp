import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameFileWithRetry } from './fs-reliability.js';
import type { SecretStore } from './secure-secret-store.js';

const MAX_SECRET_BYTES = 1024 * 1024;
const HELPER_TIMEOUT_MS = 15_000;
const KEYCHAIN_SERVICE = 'com.deskmcp.oauth';
const ENTROPY = 'DeskMCP OAuth Secret Store v1';

function normalizedKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) throw new Error('Secret store key is required.');
  if (Buffer.byteLength(normalized, 'utf8') > 256) throw new Error('Secret store key is too long.');
  return normalized;
}

function idFor(key: string): string {
  return Buffer.from(normalizedKey(key), 'utf8').toString('base64url');
}

async function legacyIdFor(key: string): Promise<string> {
  const normalized = normalizedKey(key);
  if (process.platform === 'win32') {
    const script = [
      '$raw=[Console]::In.ReadToEnd();',
      '$bytes=[Text.Encoding]::UTF8.GetBytes($raw);',
      '$sha=[Security.Cryptography.SHA256]::Create();',
      '$hash=$null;',
      'try {$hash=$sha.ComputeHash($bytes);[Console]::Out.Write(($hash|ForEach-Object{$_.ToString("x2")}) -join "")} finally {',
      'if($hash){[Array]::Clear($hash,0,$hash.Length)};',
      'if($bytes){[Array]::Clear($bytes,0,$bytes.Length)};',
      '$sha.Dispose();',
      '}'
    ].join(' ');
    const result = await runHelper(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      normalized
    );
    if (!/^[0-9a-f]{64}$/u.test(result.stdout.trim())) throw new Error('Legacy OAuth secret id helper returned invalid output.');
    return result.stdout.trim();
  }
  if (process.platform === 'darwin') {
    const result = await runHelper('/usr/bin/shasum', ['-a', '256'], normalized);
    const digest = result.stdout.trim().split(/\s+/u)[0] ?? '';
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error('Legacy OAuth secret id helper returned invalid output.');
    return digest;
  }
  throw new Error(`Secure OAuth storage is unsupported on ${process.platform}.`);
}

async function runHelper(
  file: string,
  args: readonly string[],
  input: string,
  acceptedExitCodes: readonly number[] = [0]
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (error?: Error, code = -1) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) return reject(error);
      if (!acceptedExitCodes.includes(code)) {
        return reject(new Error(`${path.basename(file)} exited with code ${code}: ${stderr.trim() || 'unknown error'}`));
      }
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${path.basename(file)} timed out.`));
    }, HELPER_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_SECRET_BYTES * 2) {
        child.kill();
        finish(new Error('Secret helper output exceeded size limit.'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > 64 * 1024) {
        child.kill();
        finish(new Error('Secret helper error output exceeded size limit.'));
      }
    });
    child.once('error', error => finish(error));
    child.once('exit', code => finish(undefined, code ?? -1));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function dpapiScript(direction: 'protect' | 'unprotect'): string {
  const operation = direction === 'protect'
    ? '[Security.Cryptography.ProtectedData]::Protect($inputBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)'
    : '[Security.Cryptography.ProtectedData]::Unprotect($inputBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)';
  return [
    'Add-Type -AssemblyName System.Security;',
    '$raw=[Console]::In.ReadToEnd().Trim();',
    '$inputBytes=[Convert]::FromBase64String($raw);',
    `$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');`,
    '$outputBytes=$null;',
    'try {',
    `$outputBytes=${operation};`,
    '[Console]::Out.Write([Convert]::ToBase64String($outputBytes));',
    '} finally {',
    'if($inputBytes){[Array]::Clear($inputBytes,0,$inputBytes.Length)};',
    'if($outputBytes){[Array]::Clear($outputBytes,0,$outputBytes.Length)};',
    'if($entropy){[Array]::Clear($entropy,0,$entropy.Length)};',
    '}'
  ].join(' ');
}

export class PlatformSecretStore implements SecretStore {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    if (process.platform === 'win32') {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await chmod(this.root, 0o700).catch(() => undefined);
      return;
    }
    if (process.platform === 'darwin') return;
    throw new Error(`Secure OAuth storage is unsupported on ${process.platform}.`);
  }

  async get(key: string): Promise<string | undefined> {
    if (process.platform === 'win32') return this.getWindows(key);
    if (process.platform === 'darwin') return this.getMac(key);
    throw new Error(`Secure OAuth storage is unsupported on ${process.platform}.`);
  }

  async set(key: string, value: string): Promise<void> {
    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) throw new Error('OAuth secret exceeds size limit.');
    if (process.platform === 'win32') return this.setWindows(key, value);
    if (process.platform === 'darwin') return this.setMac(key, value);
    throw new Error(`Secure OAuth storage is unsupported on ${process.platform}.`);
  }

  async delete(key: string): Promise<void> {
    if (process.platform === 'win32') return rm(this.secretPath(key), { force: true });
    if (process.platform === 'darwin') return this.deleteMac(key);
    throw new Error(`Secure OAuth storage is unsupported on ${process.platform}.`);
  }

  async getLegacy(key: string): Promise<string | undefined> {
    const legacyId = await legacyIdFor(key);
    if (process.platform === 'win32') return this.readWindowsSecret(path.join(this.root, `${legacyId}.dpapi`));
    if (process.platform === 'darwin') return this.getMacById(legacyId);
    throw new Error(`Secure OAuth storage is unsupported on ${process.platform}.`);
  }

  async deleteLegacy(key: string): Promise<void> {
    const legacyId = await legacyIdFor(key);
    if (process.platform === 'win32') return rm(path.join(this.root, `${legacyId}.dpapi`), { force: true });
    if (process.platform === 'darwin') return this.deleteMacById(legacyId);
    throw new Error(`Secure OAuth storage is unsupported on ${process.platform}.`);
  }

  async listLegacyCandidates(): Promise<readonly { id: string; value: string }[]> {
    if (process.platform === 'darwin') return [];
    if (process.platform !== 'win32') {
      throw new Error(`Secure OAuth storage is unsupported on ${process.platform}.`);
    }
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const candidates: Array<{ id: string; value: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.dpapi$/u.test(entry.name)) continue;
      const value = await this.readWindowsSecret(path.join(this.root, entry.name)).catch(() => undefined);
      if (value !== undefined) candidates.push({ id: entry.name, value });
    }
    return candidates;
  }

  async deleteLegacyCandidate(id: string): Promise<void> {
    if (!/^[0-9a-f]{64}\.dpapi$/u.test(id)) throw new Error('Invalid legacy OAuth secret id.');
    if (process.platform === 'win32') return rm(path.join(this.root, id), { force: true });
    if (process.platform === 'darwin') return;
    throw new Error(`Secure OAuth storage is unsupported on ${process.platform}.`);
  }

  private secretPath(key: string): string {
    return path.join(this.root, `${idFor(key)}.dpapi`);
  }

  private async getWindows(key: string): Promise<string | undefined> {
    return this.readWindowsSecret(this.secretPath(key));
  }

  private async readWindowsSecret(secretPath: string): Promise<string | undefined> {
    let encrypted: string;
    try {
      encrypted = await readFile(secretPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const result = await runHelper(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', dpapiScript('unprotect')],
      encrypted.trim()
    );
    const plain = Buffer.from(result.stdout.trim(), 'base64');
    if (plain.byteLength > MAX_SECRET_BYTES) {
      plain.fill(0);
      throw new Error('Decrypted OAuth secret exceeds size limit.');
    }
    try {
      return plain.toString('utf8');
    } finally {
      plain.fill(0);
    }
  }

  private async setWindows(key: string, value: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const plain = Buffer.from(value, 'utf8');
    try {
      const result = await runHelper(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', dpapiScript('protect')],
        plain.toString('base64')
      );
      const target = this.secretPath(key);
      const temp = path.join(this.root, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(temp, `${result.stdout.trim()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try {
        await renameFileWithRetry(temp, target);
        await chmod(target, 0o600).catch(() => undefined);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    } finally {
      plain.fill(0);
    }
  }

  private async getMac(key: string): Promise<string | undefined> {
    return this.getMacById(idFor(key));
  }

  private async getMacById(accountId: string): Promise<string | undefined> {
    const result = await runHelper(
      '/usr/bin/security',
      ['find-generic-password', '-a', accountId, '-s', KEYCHAIN_SERVICE, '-w'],
      '',
      [0, 44]
    );
    return result.code === 44 ? undefined : result.stdout.replace(/[\r\n]+$/u, '');
  }

  private async setMac(key: string, value: string): Promise<void> {
    await runHelper(
      '/usr/bin/security',
      ['add-generic-password', '-a', idFor(key), '-s', KEYCHAIN_SERVICE, '-U', '-w'],
      `${value}\n`
    );
  }

  private async deleteMac(key: string): Promise<void> {
    return this.deleteMacById(idFor(key));
  }

  private async deleteMacById(accountId: string): Promise<void> {
    await runHelper(
      '/usr/bin/security',
      ['delete-generic-password', '-a', accountId, '-s', KEYCHAIN_SERVICE],
      '',
      [0, 44]
    );
  }
}
