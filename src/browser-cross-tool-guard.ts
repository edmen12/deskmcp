import { PolicyDeniedError } from './desktop-policy.js';
import type { BrowserHandoffAgentPort } from './browser-handoff-boundary.js';

/**
 * Fail-closed candidate quarantine for generic MCP tool families while any
 * Browser Session is awaiting or held in human control. This alone is NOT a
 * security boundary against arbitrary PowerShell, native code, another MCP
 * plugin, or already-running operations.
 */
export interface BrowserCrossToolGuard {
  assertNonBrowserToolAllowed(tool: string): void;
}

export function createBrowserCrossToolGuard(
  agentAuthority: BrowserHandoffAgentPort
): BrowserCrossToolGuard {
  return Object.freeze({
    assertNonBrowserToolAllowed(tool: string): void {
      if (agentAuthority.anySessionReserved()) {
        throw new PolicyDeniedError(
          'Browser human takeover quarantine: ' + tool +
          ' cannot access the filesystem, processes, or native desktop until trusted local handback.'
        );
      }
    }
  });
}
