import { PolicyDeniedError } from './desktop-policy.js';
import type { DesktopBackendToolResult } from './desktop-backend-bridge.js';
import { extractListedProcessPids, type ProcessSessionRegistry } from './process-session-registry.js';

/**
 * Candidate-only check. Does NOT terminate running jobs or provide an OS sandbox.
 * Call only after the shared request-drain barrier is engaged.
 */
export interface OwnedProcessInventory {
  listProcessSessions(): Promise<DesktopBackendToolResult>;
}

export function createBrowserHandoffProcessPreflight(
  inventory: OwnedProcessInventory,
  processSessions: ProcessSessionRegistry
): (browserProcessSessionIds: readonly string[]) => Promise<void> {
  return async browserProcessSessionIds => {
    // No new process requests may be admitted while the caller holds the
    // shared handoff barrier, but a preexisting start reservation must not
    // become invisible just because it lacks a registered PID yet.
    if (processSessions.pendingSize() !== 0) {
      throw new PolicyDeniedError('Browser handoff blocked by pending owned-process startup.');
    }
    const before = processSessions.ownedSessions().filter(session => session.active);
    if (before.length === 0) return;
    const listing = await inventory.listProcessSessions();
    if (listing.isError) {
      throw new PolicyDeniedError('Browser handoff cannot verify owned-process liveness; human control was not transferred.');
    }
    const activePids = extractListedProcessPids(listing.text);
    if (activePids.length === 0 && listing.text.trim() !== 'No active process sessions.') {
      throw new PolicyDeniedError('Browser handoff rejected an unrecognized owned-process inventory response.');
    }
    // The registry is authoritative for ownership; the native host is
    // authoritative for liveness. Never accept unowned PIDs as exclusions.
    processSessions.reconcileActivePids(activePids);
    const allowed = new Set(browserProcessSessionIds);
    const blocked = processSessions.ownedSessions()
      .filter(session => session.active && !allowed.has(session.id));
    if (blocked.length > 0) {
      throw new PolicyDeniedError(
        'Browser handoff blocked by ' + blocked.length +
        ' active Gateway-owned non-browser process session(s). Finish or explicitly stop them before handoff.'
      );
    }
    if (processSessions.pendingSize() !== 0) {
      throw new PolicyDeniedError('Browser handoff blocked by pending owned-process startup.');
    }
  };
}
