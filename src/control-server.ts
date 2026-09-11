import net, { type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { acquirePidDirectoryLock, type PidDirectoryLockLease } from './cross-process-lock.js';

export interface RunningControlServer {
  readonly pipeName: string;
  close(): Promise<void>;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid control port: ${port}`);
  }
}

function unixControlDirectory(): string {
  if (process.platform === 'win32') throw new Error('Unix control directory is unavailable on Windows.');
  if (typeof process.getuid !== 'function') throw new Error('DeskMCP cannot determine the current Unix user id.');
  return path.join(tmpdir(), `deskmcp-${process.getuid()}`);
}

async function ensureUnixControlDirectory(): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = unixControlDirectory();
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('DeskMCP Unix control directory is not a trusted directory.');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('DeskMCP Unix control directory is owned by another user.');
  }
  await chmod(directory, 0o700);
}

export function controlPipeName(port: number): string {
  validatePort(port);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\desktop-mcp-gateway-${port}`;
  }
  return path.join(unixControlDirectory(), `desktop-mcp-gateway-${port}.sock`);
}
function handleSocket(
  socket: Socket,
  onShutdown: () => void | Promise<void>
): void {
  socket.setEncoding('utf8');
  let buffer = '';
  let handled = false;

  socket.on('data', chunk => {
    if (handled) return;
    buffer += chunk;
    if (buffer.length > 128) {
      handled = true;
      socket.end('ERR invalid_request\n');
      return;
    }

    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    const command = buffer.slice(0, newline).trim();
    if (command !== 'shutdown') {
      socket.end('ERR unknown_command\n');
      return;
    }

    socket.end('OK shutdown\n');
    setImmediate(() => {
      void Promise.resolve(onShutdown()).catch(error => {
        console.error('[deskmcp] local control shutdown failed:', error);
      });
    });
  });
}
async function removeUnixSocket(pipeName: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await unlink(pipeName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function unixSocketIsLive(pipeName: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    let settled = false;
    const finish = (error: Error | undefined, live: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(live);
    };
    const timer = setTimeout(() => finish(new Error(`Timed out probing DeskMCP control socket: ${pipeName}`), false), 1000);
    timer.unref?.();
    socket.once('connect', () => finish(undefined, true));
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') finish(undefined, false);
      else finish(error, false);
    });
  });
}

async function acquireUnixStartupLock(pipeName: string): Promise<PidDirectoryLockLease | undefined> {
  if (process.platform === 'win32') return undefined;
  return acquirePidDirectoryLock(`${pipeName}.startup-lock`, {
    label: 'DeskMCP local control socket startup',
    timeoutMs: 5_000,
    initializationGraceMs: 5_000
  });
}

export async function startControlServer(
  port: number,
  onShutdown: () => void | Promise<void>
): Promise<RunningControlServer> {
  await ensureUnixControlDirectory();
  const pipeName = controlPipeName(port);
  const server: Server = net.createServer(socket => {
    handleSocket(socket, onShutdown);
  });
  let bound = false;
  const startupLock = await acquireUnixStartupLock(pipeName);
  try {
    if (process.platform !== 'win32') {
      if (await unixSocketIsLive(pipeName)) {
        throw new Error(`DeskMCP local control socket is already active: ${pipeName}`);
      }
      await removeUnixSocket(pipeName);
    }

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipeName, () => {
        server.off('error', reject);
        resolve();
      });
    });
    bound = true;
    if (process.platform !== 'win32') await chmod(pipeName, 0o600);
  } catch (error) {
    if (bound) {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await removeUnixSocket(pipeName).catch(() => undefined);
    }
    throw error;
  } finally {
    if (startupLock) await startupLock.release();
  }

  let closed = false;
  return {
    pipeName,
    async close() {
      if (closed) return;
      closed = true;
      const closeLock = await acquireUnixStartupLock(pipeName);
      try {
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
        await removeUnixSocket(pipeName);
      } finally {
        if (closeLock) await closeLock.release();
      }
    }
  };
}
export async function requestShutdown(
  port: number,
  timeoutMs = 3000
): Promise<string> {
  const pipeName = controlPipeName(port);
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    let response = '';

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to DeskMCP control pipe: ${pipeName}`));
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write('shutdown\n'));
    socket.on('data', chunk => {
      response += chunk;
      if (response.length > 256) socket.destroy(new Error('Control response too large.'));
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('end', () => {
      clearTimeout(timer);
      resolve(response.trim());
    });
  });
}
