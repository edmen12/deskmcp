import { McpServer } from '@modelcontextprotocol/server';
import type { AuditLogger } from './audit.js';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import { registerAgentDesktopTools } from './agent-desktop-tools.js';
import type { ArtifactStore } from './artifact-store.js';
import { registerArtifactTools } from './artifact-tools.js';
import type { BrowserRuntime } from './browser-runtime.js';
import { registerBrowserTools } from './browser-tools.js';
import { registerDesktopBackendBridgeTools } from './bridge-tools.js';
import { registerComputerUseTools } from './computer-use-tools.js';
import type { ComputerUseRuntime } from './computer-use-runtime.js';
import type { DesktopBackendBridge } from './desktop-backend-bridge.js';
import type { DesktopPolicy } from './desktop-policy.js';
import type { DynamicMcpHub } from './dynamic-mcp-hub.js';
import { registerDynamicMcpTools } from './dynamic-mcp-tools.js';
import type { ObservationStore } from './observation-store.js';
import { registerProcessTools } from './process-tools.js';
import type { ProcessSessionRegistry } from './process-session-registry.js';
import type { SkillStore } from './skill-store.js';
import { registerSkillTools } from './skill-tools.js';
import type { TaskContextStore } from './task-context.js';
import { registerTaskTools } from './task-tools.js';
import { registerTestTools } from './test-tools.js';

export const SERVER_NAME = 'deskmcp-gateway';
export const SERVER_VERSION = '0.9.10';

export function createDesktopMcpServer(
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
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  if (bridge) {
    if (!policy || !audit || !observations || !processSessions || !computerUse) {
      throw new Error('Desktop policy, audit logger, observation store, process registry, and computer-use runtime are required.');
    }
    registerDesktopBackendBridgeTools(server, bridge, policy, audit, observations);
    registerProcessTools(server, bridge, policy, audit, processSessions, agentDesktop);
    registerComputerUseTools(server, policy, audit, computerUse, agentDesktop);
    if (taskStore) registerTaskTools(server, policy, audit, taskStore, agentDesktop, browser);
    if (artifactStore) registerArtifactTools(server, policy, audit, artifactStore);
    if (dynamicMcpHub) registerDynamicMcpTools(server, policy, audit, dynamicMcpHub);
    if (agentDesktop) registerAgentDesktopTools(server, policy, audit, agentDesktop, taskStore, browser);
    if (browser) registerBrowserTools(server, policy, audit, browser);
    if (skillStore) registerSkillTools(server, policy, audit, skillStore);
  } else {
    registerTestTools(server);
  }
  return server;
}
