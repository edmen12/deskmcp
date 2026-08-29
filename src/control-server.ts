import net, { type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unlink } from 'node:fs/promises';

export interface RunningControlServer {
  readonly pipeName: string;
  close(): Promise<void>;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid control port: ${port}`);
  }
}

export function controlPipeName(port: number): string {
  validatePort(port);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\desktop-mcp-gateway-${port}`;
  }
  return path.join(tmpdir(), `desktop-mcp-gateway-${port}.sock`);
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

export async function startControlServer(
  port: number,
  onShutdown: () => void | Promise<void>
): Promise<RunningControlServer> {
  const pipeName = controlPipeName(port);
  await removeUnixSocket(pipeName);

  const server: Server = net.createServer(socket => {
    handleSocket(socket, onShutdown);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => {
      server.off('error', reject);
      resolve();
    });
  });

  let closed = false;
  return {
    pipeName,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      await removeUnixSocket(pipeName);
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
