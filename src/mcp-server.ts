import { McpServer } from '@modelcontextprotocol/server';
import type { AuditLogger } from './audit.js';
import { registerDesktopBackendBridgeTools } from './bridge-tools.js';
import { registerComputerUseTools } from './computer-use-tools.js';
import type { ComputerUseRuntime } from './computer-use-runtime.js';
import type { DesktopBackendBridge } from './desktop-backend-bridge.js';
import type { DesktopPolicy } from './desktop-policy.js';
import type { ObservationStore } from './observation-store.js';
import { registerProcessTools } from './process-tools.js';
import type { ProcessSessionRegistry } from './process-session-registry.js';
import { registerTestTools } from './test-tools.js';

export const SERVER_NAME = 'deskmcp-gateway';
export const SERVER_VERSION = '0.9.6';

export function createDesktopMcpServer(
  bridge?: DesktopBackendBridge,
  policy?: DesktopPolicy,
  audit?: AuditLogger,
  observations?: ObservationStore,
  processSessions?: ProcessSessionRegistry,
  computerUse?: ComputerUseRuntime
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  if (bridge) {
    if (!policy || !audit || !observations || !processSessions || !computerUse) {
      throw new Error('Desktop policy, audit logger, observation store, process registry, and computer-use runtime are required.');
    }
    registerDesktopBackendBridgeTools(server, bridge, policy, audit, observations);
    registerProcessTools(server, bridge, policy, audit, processSessions);
    registerComputerUseTools(server, policy, audit, computerUse);
  } else {
    registerTestTools(server);
  }
  return server;
}
