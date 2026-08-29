import { AuditLogger } from './audit.js';
import {
  startControlServer,
  type RunningControlServer
} from './control-server.js';
import { DesktopCommanderBridge } from './desktop-commander-bridge.js';
import { DesktopPolicy } from './desktop-policy.js';
import { startHttpServer, type RunningHttpServer } from './http-server.js';
import { ObservationStore } from './observation-store.js';
import { ProcessSessionRegistry } from './process-session-registry.js';

const host = '127.0.0.1';
const rawPort = process.env.DESKTOP_MCP_PORT ?? '8765';
const port = Number.parseInt(rawPort, 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid DESKTOP_MCP_PORT: ${rawPort}`);
}

const audit = new AuditLogger();
await audit.init();
const policy = await DesktopPolicy.create();
const observations = new ObservationStore();
const processSessions = new ProcessSessionRegistry();
const bridge = new DesktopCommanderBridge();
await bridge.start();

let running: RunningHttpServer | null = null;
let control: RunningControlServer | null = null;
let shuttingDown = false;

async function cleanupOwnedProcesses(): Promise<void> {
  for (const session of processSessions.ownedSessions()) {
    let operation;
    try {
      operation = await audit.begin(
        'gateway_owned_process_cleanup',
        'process',
        policy.profile,
        session.id
      );
    } catch {
      operation = undefined;
    }

    try {
      const result = await bridge.forceTerminateProcess(session.pid);
      if (operation) {
        await audit.finish(
          operation,
          result.isError ? 'fail' : 'allow',
          result.isError ? new Error('DownstreamToolError') : undefined
        );
      }
    } catch (error) {
      if (operation) await audit.finish(operation, 'fail', error).catch(() => undefined);
      console.error(`[deskmcp] owned process cleanup failed for ${session.id}:`, error);
      process.exitCode = 1;
    } finally {
      processSessions.forget(session.id);
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[deskmcp] ${signal}: shutting down`);

  try {
    if (control) await control.close();
  } catch (error) {
    console.error('[deskmcp] local control shutdown failed:', error);
    process.exitCode = 1;
  }

  try {
    if (running) await running.close();
  } catch (error) {
    console.error('[deskmcp] HTTP shutdown failed:', error);
    process.exitCode = 1;
  }

  await cleanupOwnedProcesses();

  try {
    await bridge.close();
  } catch (error) {
    console.error('[deskmcp] Desktop Commander shutdown failed:', error);
    process.exitCode = 1;
  }
}

try {
  running = await startHttpServer(
    host,
    port,
    bridge,
    policy,
    audit,
    observations,
    processSessions
  );
  control = await startControlServer(port, () => shutdown('LOCAL_CONTROL'));
} catch (error) {
  await control?.close().catch(() => undefined);
  await running?.close().catch(() => undefined);
  await cleanupOwnedProcesses();
  await bridge.close().catch(() => undefined);
  throw error;
}

console.error(`[deskmcp] listening on ${running.url}/mcp`);
console.error(`[deskmcp] policy: ${JSON.stringify(policy.info())}`);
console.error('[deskmcp] audit: enabled');
console.error('[deskmcp] local control: enabled');
console.error(
  `[deskmcp] Desktop Commander connected: ${JSON.stringify(bridge.info())}`
);

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
