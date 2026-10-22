import type { BrowserHandoffBoundary, BrowserHandoffStatus } from './browser-handoff-boundary.js';
import {
  BrowserHumanProofVerifier,
  type BrowserHumanAction,
  type BrowserHumanChallenge,
  type BrowserHumanResponse
} from './browser-human-proof.js';

/**
 * Candidate-only in-process coordinator. The signer MUST be a native
 * Windows Hello-brokered credential signer. Never implement it with a JS
 * software private key outside tests, nor expose this coordinator as an MCP tool.
 *
 * A Windows user/token or WPF Click event is NOT authentication by itself.
 */
export interface BrowserHumanNativeSigner {
  signChallenge(request: {
    readonly session_id: string;
    readonly lease_id: string;
    readonly action: BrowserHumanAction;
    readonly challenge: BrowserHumanChallenge;
  }): Promise<BrowserHumanResponse>;
}
export interface BrowserHumanLiveLeaseVerifier {
  assertLeaseForSession(sessionId: string, leaseId: string): Promise<void>;
}
export class BrowserHumanConsentCoordinator {
  constructor(
    private readonly boundary: BrowserHandoffBoundary,
    private readonly verifier: BrowserHumanProofVerifier,
    private readonly nativeSigner: BrowserHumanNativeSigner,
    private readonly leaseVerifier: BrowserHumanLiveLeaseVerifier
  ) {}

  async confirm(sessionId: string, leaseId: string, action: BrowserHumanAction): Promise<BrowserHandoffStatus> {
    const expected = action === 'accept' ? 'handoff-requested' : 'human';
    const state = this.boundary.agent.status(sessionId);
    if (state.state !== expected) throw new Error('Invalid browser handoff transition.');
    await this.leaseVerifier.assertLeaseForSession(sessionId, leaseId);
    // Recheck AFTER the await. An unrelated lease shutdown/revocation must
    // not leave a new authorization challenge for the wrong ownership epoch.
    if (this.boundary.agent.epoch(sessionId) !== state.epoch ||
      this.boundary.agent.status(sessionId).state !== expected) {
      throw new Error('Browser control changed while authorizing the local user.');
    }
    const challenge = this.verifier.issue(sessionId, leaseId, action, state.epoch);
    try {
      const proof = await this.nativeSigner.signChallenge({
        session_id: sessionId, lease_id: leaseId, action, challenge
      });
      await this.leaseVerifier.assertLeaseForSession(sessionId, leaseId);
      // No await between verified native lease and cryptographic transition.
      return action === 'accept'
        ? this.boundary.local.accept(sessionId, proof)
        : this.boundary.local.resume(sessionId, proof);
    } catch (error) {
      this.verifier.revokeSession(sessionId);
      // Native HUD or lease failure is not user rejection. Leave ownership
      // denied; the existing reaper/lease fault path will revoke it.
      throw error;
    }
  }
}
