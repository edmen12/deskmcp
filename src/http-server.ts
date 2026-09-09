import { createReadStream } from 'node:fs';
import http, { type Server as HttpServer } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler
} from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AuditLogger } from './audit.js';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import { ArtifactExpiredError, type ArtifactStore } from './artifact-store.js';
import type { BrowserRuntime } from './browser-runtime.js';
import { resolveWinAppPath, WINAPP_VERSION } from './computer-use-backend.js';
import { createComputerUseRuntime, type ComputerUseRuntime } from './computer-use-runtime.js';
import { createDesktopMcpServer, SERVER_NAME, SERVER_VERSION } from './mcp-server.js';
import type { DesktopBackendBridge } from './desktop-backend-bridge.js';
import type { DesktopPolicy } from './desktop-policy.js';
import type { DynamicMcpHub } from './dynamic-mcp-hub.js';
import type { ObservationStore } from './observation-store.js';
import type { ProcessSessionRegistry } from './process-session-registry.js';
import type { SkillStore } from './skill-store.js';
import type { TaskContextStore } from './task-context.js';

export interface RunningHttpServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function publicDesktopRuntimeInfo(bridge?: DesktopBackendBridge) {
  if (!bridge) return null;
  const info = bridge.info();
  return {
    ready: info.ready,
    ...(info.serverName ? { serverName: info.serverName } : {}),
    ...(info.serverVersion ? { serverVersion: info.serverVersion } : {}),
    toolCount: info.toolCount,
    ...(info.startupTiming ? { startupTiming: { ...info.startupTiming } } : {})
  };
}

function publicPolicyInfo(policy?: DesktopPolicy) {
  if (!policy) return null;
  const info = policy.info();
  return {
    profile: info.profile,
    processToolsEnabled: info.processToolsEnabled,
    computerUseEnabled: info.computerUseEnabled,
    writeEnabled: info.writeEnabled,
    allowSensitivePaths: info.allowSensitivePaths,
    workspaceBoundaryEnforced: info.workspaceBoundaryEnforced,
    observationGuardsEnabled: info.observationGuardsEnabled
  };
}

function publicComputerUseInfo(runtime?: ComputerUseRuntime) {
  if (!runtime) return null;
  let available = false;
  try {
    resolveWinAppPath();
    available = process.platform === 'win32';
  } catch {
    available = false;
  }
  return {
    available,
    backend: 'microsoft-winappcli',
    backendVersion: WINAPP_VERSION,
    globalSerialization: true,
    freshObservationRequired: true
  };
}

function publicBrowserInfo(runtime?: BrowserRuntime) {
  if (!runtime) return null;
  return runtime.info();
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

function publicArtifactPath(pathname: string): { artifactId: string; filename: string } | undefined {
  const match = /^\/artifacts\/public\/([^/]+)\/([^/]+)$/u.exec(pathname);
  if (!match) return undefined;
  try {
    return {
      artifactId: decodeURIComponent(match[1]!),
      filename: decodeURIComponent(match[2]!)
    };
  } catch {
    return undefined;
  }
}

async function serveSignedArtifact(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: ArtifactStore,
  route: { artifactId: string; filename: string }
): Promise<void> {
  try {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const resolved = await store.resolveSignedDownload(
      route.artifactId,
      route.filename,
      parsed.searchParams.get('expires'),
      parsed.searchParams.get('sig')
    );
    res.writeHead(200, {
      'content-type': resolved.metadata.mime_type,
      'content-length': String(resolved.metadata.size_bytes),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(resolved.metadata.filename)}`,
      'cache-control': 'private, no-store, max-age=0',
      'x-content-type-options': 'nosniff'
    });
    const stream = createReadStream(resolved.payload);
    stream.once('error', error => {
      console.error('[deskmcp] artifact stream failed:', error);
      res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) {
    writeJson(res, error instanceof ArtifactExpiredError ? 410 : 403, { error: 'artifact_access_denied' });
  }
}

export async function startHttpServer(
  host = '127.0.0.1',
  port = 8765,
  bridge?: DesktopBackendBridge,
  policy?: DesktopPolicy,
  audit?: AuditLogger,
  observations?: ObservationStore,
  processSessions?: ProcessSessionRegistry,
  computerUse?: ComputerUseRuntime,
  taskStore?: TaskContextStore,
  artifactStore?: ArtifactStore,
  dynamicMcpHub?: DynamicMcpHub,
  browser?: BrowserRuntime,
  skillStore?: SkillStore,
  agentDesktop?: AgentDesktopManager
): Promise<RunningHttpServer> {
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('Gateway refuses non-loopback bind addresses.');
  }
  if (bridge && (!policy || !audit || !observations || !processSessions)) {
    throw new Error('Desktop policy, audit logger, observation store, and process registry are required when DeskMCP backend is enabled.');
  }
  const effectiveComputerUse = computerUse ?? (bridge ? createComputerUseRuntime() : undefined);

  const mcpHandler = createMcpHandler(() =>
    createDesktopMcpServer(
      bridge,
      policy,
      audit,
      observations,
      processSessions,
      effectiveComputerUse,
      taskStore,
      artifactStore,
      dynamicMcpHub,
      browser,
      skillStore,
      agentDesktop
    )
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror(error) {
      console.error('[deskmcp] MCP adapter error:', error);
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
        mode: bridge ? 'desktop-runtime' : 'safe-test',
        desktopRuntime: publicDesktopRuntimeInfo(bridge),
        policy: publicPolicyInfo(policy),
        computerUse: publicComputerUseInfo(effectiveComputerUse),
        recoverableTasksEnabled: Boolean(taskStore),
        artifactsEnabled: Boolean(artifactStore),
        dynamicMcpHubEnabled: Boolean(dynamicMcpHub),
        agentDesktopEnabled: Boolean(agentDesktop),
        browserAutomation: publicBrowserInfo(browser),
        skillsEnabled: Boolean(skillStore),
        auditEnabled: Boolean(audit),
        observationStoreEnabled: Boolean(observations)
      });
      return;
    }

    const artifactRoute = publicArtifactPath(pathname);
    if (artifactRoute) {
      if (!artifactStore || req.method !== 'GET') {
        writeJson(res, artifactStore ? 405 : 404, { error: artifactStore ? 'method_not_allowed' : 'not_found' });
        return;
      }
      void serveSignedArtifact(req, res, artifactStore, artifactRoute);
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
  const serverUrl = `http://${host}:${actualPort}`;
  artifactStore?.setLocalBaseUrl(serverUrl);
  return {
    host,
    port: actualPort,
    url: serverUrl,
    async close() {
      await mcpHandler.close();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  };
}
