import http, { type Server as HttpServer } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler
} from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AuditLogger } from './audit.js';
import { createDesktopMcpServer, SERVER_NAME, SERVER_VERSION } from './mcp-server.js';
import type { DesktopCommanderBridge } from './desktop-commander-bridge.js';
import type { DesktopPolicy } from './desktop-policy.js';
import type { ObservationStore } from './observation-store.js';
import type { ProcessSessionRegistry } from './process-session-registry.js';

export interface RunningHttpServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function publicDesktopCommanderInfo(bridge?: DesktopCommanderBridge) {
  if (!bridge) return null;
  const info = bridge.info();
  return {
    ready: info.ready,
    ...(info.serverName ? { serverName: info.serverName } : {}),
    ...(info.serverVersion ? { serverVersion: info.serverVersion } : {}),
    toolCount: info.toolCount
  };
}

function publicPolicyInfo(policy?: DesktopPolicy) {
  if (!policy) return null;
  const info = policy.info();
  return {
    profile: info.profile,
    processToolsEnabled: info.processToolsEnabled,
    writeEnabled: info.writeEnabled,
    allowSensitivePaths: info.allowSensitivePaths
  };
}
function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  res.end(payload);
}
export async function startHttpServer(
  host = '127.0.0.1',
  port = 8765,
  bridge?: DesktopCommanderBridge,
  policy?: DesktopPolicy,
  audit?: AuditLogger,
  observations?: ObservationStore,
  processSessions?: ProcessSessionRegistry
): Promise<RunningHttpServer> {
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('Gateway refuses non-loopback bind addresses.');
  }
  if (bridge && (!policy || !audit || !observations || !processSessions)) {
    throw new Error('Desktop policy, audit logger, observation store, and process registry are required when Desktop Commander is enabled.');
  }

  const mcpHandler = createMcpHandler(() =>
    createDesktopMcpServer(bridge, policy, audit, observations, processSessions)
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror(error) {
      console.error('[desktop-mcp] MCP adapter error:', error);
    }
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server: HttpServer = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?', 1)[0] ?? '/';
    if (!req.method) {
      writeJson(res, 400, { error: 'missing_method' });
      return;
    }

    if (pathname === '/health' && req.method === 'GET') {
      writeJson(res, 200, {
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        mode: bridge ? 'desktop-commander' : 'safe-test',
        desktopCommander: publicDesktopCommanderInfo(bridge),
        policy: publicPolicyInfo(policy),
        auditEnabled: Boolean(audit),
        observationStoreEnabled: Boolean(observations)
      });
      return;
    }

    if (pathname !== '/mcp') {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }

    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to resolve listening TCP address.');
  }

  const actualPort = address.port;
  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    async close() {
      await mcpHandler.close();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  };
}
