import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameFileWithRetry } from './fs-reliability.js';
import type { SecretStore } from './secure-secret-store.js';

const MAX_SECRET_BYTES = 1024 * 1024;
const HELPER_TIMEOUT_MS = 15_000;
const KEYCHAIN_SERVICE = 'com.deskmcp.oauth';
const ENTROPY = 'DeskMCP OAuth Secret Store v1';

function idFor(key: string): string {
  const normalized = key.trim();
  if (!normalized) throw new Error('Secret store key is required.');
  if (Buffer.byteLength(normalized, 'utf8') > 256) throw new Error('Secret store key is too long.');
  return Buffer.from(normalized, 'utf8').toString('base64url');
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

  private secretPath(key: string): string {
    return path.join(this.root, `${idFor(key)}.dpapi`);
  }

  private async getWindows(key: string): Promise<string | undefined> {
    let encrypted: string;
    try {
      encrypted = await readFile(this.secretPath(key), 'utf8');
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
    const result = await runHelper(
      '/usr/bin/security',
      ['find-generic-password', '-a', idFor(key), '-s', KEYCHAIN_SERVICE, '-w'],
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
    await runHelper(
      '/usr/bin/security',
      ['delete-generic-password', '-a', idFor(key), '-s', KEYCHAIN_SERVICE],
      '',
      [0, 44]
    );
  }
}
