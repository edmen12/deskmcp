import type { BrowserHumanProofVerifier, BrowserHumanResponse, BrowserHumanAction } from './browser-human-proof.js';

/**
 * Candidate-only in-process browser handoff boundary.
 * Local accept/resume now require a scoped one-time signature from a pinned key.
 * This is NOT actual user attestation until the key is securely enrolled
 * and OS-brokered Windows Hello signing is connected to the native local UI.
 * Never register local accept/resume methods as remote MCP tools.
 */
export type BrowserHandoffState = 'agent' | 'handoff-requested' | 'human' | 'privacy-reset' | 'revoked' | 'retired';

export interface BrowserHandoffStatus {
  readonly state: BrowserHandoffState;
  readonly epoch: number;
}
export interface BrowserHandoffAgentPort {
  assertAgentAccess(sessionId: string): void;
  epoch(sessionId: string): number;
  request(sessionId: string): BrowserHandoffStatus;
  /** Irreversible tombstone after lease/HUD/browser ownership loss. Never a remote MCP action. */
  revokeIfReserved(sessionId: string): BrowserHandoffStatus;
  /** Runtime-only: call after verified process exit, successful lock and profile cleanup. */
  retireVerifiedClosed(sessionId: string): BrowserHandoffStatus;
  status(sessionId: string): BrowserHandoffStatus;
  /** Coarse fail-closed cross-tool quarantine during any pending/human ownership. */
  anySessionReserved(): boolean;
}
export interface BrowserHandoffLocalPort {
  accept(sessionId: string, proof: BrowserHumanResponse): BrowserHandoffStatus;
  reject(sessionId: string): BrowserHandoffStatus;
  /** Signed user verification triggers privacy reset, not instant Agent read access. */
  resume(sessionId: string, proof: BrowserHumanResponse): BrowserHandoffStatus;
}

/** Internal BrowserRuntime-only completion authority; never register as MCP tool. */
export interface BrowserHandoffRuntimePort {
  completePrivacyReset(sessionId: string): BrowserHandoffStatus;
}

export interface BrowserHandoffBoundary {
  readonly agent: BrowserHandoffAgentPort;
  readonly runtime: BrowserHandoffRuntimePort;
  /**
   * Do not expose outside trusted native UI wiring.
   * Holding this port alone cannot resume control; the signed local proof
   * and post-human privacy reset are still required.
   */
  readonly local: BrowserHandoffLocalPort;
}

type MutableState = { state: BrowserHandoffState; epoch: number };

/**
 * The revocation callback must invalidate all outstanding browser observations
 * before any transition can enable Agent access.
 * If the callback fails, ownership stays denied.
 */
export function createBrowserHandoffBoundary(
  revokeObservations: (sessionId: string) => void,
  proofVerifier: Pick<BrowserHumanProofVerifier, 'verify' | 'revokeSession'>
): BrowserHandoffBoundary {
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
    if (next === 'retired') {
      // Previously revoked, dead Session IDs must never be revived. There is
      // no live observation left to invalidate, and no local approval implied.
      records.set(sessionId, { state: next, epoch: current.epoch + 1 });
    } else if (next === 'agent') {
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
    proofVerifier.revokeSession(sessionId);
    return agentStatus(sessionId);
  };
  const requireProof = (sessionId: string, expected: BrowserHandoffState,
    action: BrowserHumanAction, proof: BrowserHumanResponse): void => {
    const current = agentStatus(sessionId);
    if (current.state !== expected) throw new Error('Invalid browser handoff transition.');
    proofVerifier.verify(sessionId, action, current.epoch, proof);
  };
  const agent: BrowserHandoffAgentPort = Object.freeze({
    status: agentStatus,
    anySessionReserved: () => [...records.values()].some(value =>
      value.state === 'handoff-requested' || value.state === 'human' || value.state === 'privacy-reset' || value.state === 'revoked'),
    epoch: (sessionId: string) => agentStatus(sessionId).epoch,
    assertAgentAccess: (sessionId: string) => {
      if (agentStatus(sessionId).state !== 'agent') {
        throw new Error('Browser session is reserved for human control; agent reads and actions are denied.');
      }
    },
    request: (sessionId: string) => transition(sessionId, 'agent', 'handoff-requested'),
    revokeIfReserved: (sessionId: string) => {
      const current = agentStatus(sessionId);
      if (current.state === 'agent' || current.state === 'revoked' || current.state === 'retired') return current;
      // Revoke first, even if invalidation callback raises. Never transition
      // back to agent from this state without a separate local recovery design.
      records.set(sessionId, { state: 'revoked', epoch: current.epoch + 1 });
      proofVerifier.revokeSession(sessionId);
      revokeObservations(sessionId);
      return agentStatus(sessionId);
    },
    retireVerifiedClosed: (sessionId: string) => transition(sessionId, 'revoked', 'retired')
  });
  const local: BrowserHandoffLocalPort = Object.freeze({
    accept: (sessionId: string, proof: BrowserHumanResponse) => {
      requireProof(sessionId, 'handoff-requested', 'accept', proof);
      return transition(sessionId, 'handoff-requested', 'human');
    },
    reject: (sessionId: string) => transition(sessionId, 'handoff-requested', 'agent'),
    resume: (sessionId: string, proof: BrowserHumanResponse) => {
      requireProof(sessionId, 'human', 'resume', proof);
      return transition(sessionId, 'human', 'privacy-reset');
    }
  });
  const runtime: BrowserHandoffRuntimePort = Object.freeze({
    completePrivacyReset: (sessionId: string) => transition(sessionId, 'privacy-reset', 'agent')
  });
  return Object.freeze({ agent, local, runtime });
}
