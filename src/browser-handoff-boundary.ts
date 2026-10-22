/**
 * Candidate-only in-process browser handoff boundary.
 * The "local" port is a privileged object capability, NOT proof of user presence.
 * It must only be retained by a future authenticated native Control Panel adapter.
 * Never register local accept/resume methods as remote MCP tools.
 */
export type BrowserHandoffState = 'agent' | 'handoff-requested' | 'human';

export interface BrowserHandoffStatus {
  readonly state: BrowserHandoffState;
  readonly epoch: number;
}
export interface BrowserHandoffAgentPort {
  assertAgentAccess(sessionId: string): void;
  epoch(sessionId: string): number;
  request(sessionId: string): BrowserHandoffStatus;
  status(sessionId: string): BrowserHandoffStatus;
  /** Coarse fail-closed cross-tool quarantine during any pending/human ownership. */
  anySessionReserved(): boolean;
}
export interface BrowserHandoffLocalPort {
  accept(sessionId: string): BrowserHandoffStatus;
  reject(sessionId: string): BrowserHandoffStatus;
  resume(sessionId: string): BrowserHandoffStatus;
}

export interface BrowserHandoffBoundary {
  readonly agent: BrowserHandoffAgentPort;
  /**
   * Do not expose outside trusted native UI wiring.
   * A caller holding this port has the ability to resume agent control.
   */
  readonly local: BrowserHandoffLocalPort;
}

type MutableState = { state: BrowserHandoffState; epoch: number };

/**
 * The revocation callback must invalidate all outstanding browser observations
 * before any transition can enable Agent access.
 * If the callback fails, ownership stays denied.
 */
export function createBrowserHandoffBoundary(revokeObservations: (sessionId: string) => void): BrowserHandoffBoundary {
  const records = new Map<string, MutableState>();
  const agentStatus = (sessionId: string): BrowserHandoffStatus => {
    const row = records.get(sessionId);
    return row ? { state: row.state, epoch: row.epoch } : { state: 'agent', epoch: 0 };
  };
  const transition = (sessionId: string, expected: BrowserHandoffState, next: BrowserHandoffState): BrowserHandoffStatus => {
    if (!sessionId) throw new Error('Browser session id is required for handoff.');
    const current = agentStatus(sessionId);
    if (current.state !== expected) throw new Error('Invalid browser handoff transition.');
    // Revoke first. A failed revocation must never hand access back to Agent.
    if (next === 'agent') {
      revokeObservations(sessionId);
      records.set(sessionId, { state: next, epoch: current.epoch + 1 });
    } else {
      records.set(sessionId, { state: next, epoch: current.epoch + 1 });
      try {
        revokeObservations(sessionId);
      } catch (error) {
        // Remain denied even if the invalidation channel has failed.
        records.set(sessionId, { state: 'human', epoch: current.epoch + 2 });
        throw error;
      }
    }
    return agentStatus(sessionId);
  };
  const agent: BrowserHandoffAgentPort = Object.freeze({
    status: agentStatus,
    anySessionReserved: () => [...records.values()].some(value => value.state !== 'agent'),
    epoch: (sessionId: string) => agentStatus(sessionId).epoch,
    assertAgentAccess: (sessionId: string) => {
      if (agentStatus(sessionId).state !== 'agent') {
        throw new Error('Browser session is reserved for human control; agent reads and actions are denied.');
      }
    },
    request: (sessionId: string) => transition(sessionId, 'agent', 'handoff-requested')
  });
  const local: BrowserHandoffLocalPort = Object.freeze({
    accept: (sessionId: string) => transition(sessionId, 'handoff-requested', 'human'),
    reject: (sessionId: string) => transition(sessionId, 'handoff-requested', 'agent'),
    resume: (sessionId: string) => transition(sessionId, 'human', 'agent')
  });
  return Object.freeze({ agent, local });
}
