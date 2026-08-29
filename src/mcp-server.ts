import { McpServer } from '@modelcontextprotocol/server';
import type { AuditLogger } from './audit.js';
import { registerDesktopCommanderBridgeTools } from './bridge-tools.js';
import type { DesktopCommanderBridge } from './desktop-commander-bridge.js';
import type { DesktopPolicy } from './desktop-policy.js';
import type { ObservationStore } from './observation-store.js';
import { registerProcessTools } from './process-tools.js';
import type { ProcessSessionRegistry } from './process-session-registry.js';
import { registerTestTools } from './test-tools.js';

export const SERVER_NAME = 'deskmcp-gateway';
export const SERVER_VERSION = '0.9.1';

export function createDesktopMcpServer(
  bridge?: DesktopCommanderBridge,
  policy?: DesktopPolicy,
  audit?: AuditLogger,
  observations?: ObservationStore,
  processSessions?: ProcessSessionRegistry
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  if (bridge) {
    if (!policy || !audit || !observations || !processSessions) {
      throw new Error('Desktop policy, audit logger, observation store, and process registry are required.');
    }
    registerDesktopCommanderBridgeTools(server, bridge, policy, audit, observations);
    registerProcessTools(server, bridge, policy, audit, processSessions);
  } else {
    registerTestTools(server);
  }
  return server;
}
