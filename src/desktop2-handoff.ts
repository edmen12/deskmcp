import { randomUUID } from 'node:crypto';

/**
 * Agent Desktop 2 human-handoff policy.
 * This class NEVER performs a Windows desktop switch or injects input.
 * A future native Control Panel user gesture may call ownerAcceptHandoff()
 * and choose to show Desktop 2. Background Computer Use must call assertAutonomous().
 */
export type Desktop2HandoffReason = 'login' | 'verification' | 'permission' | 'manual_action';
export type Desktop2Phase = 'autonomous' | 'handoff_requested' | 'human_control' | 'revoked';

export interface Desktop2HandoffRequest {
  readonly requestId: string;
  readonly leaseId: string;
  readonly desktopId: string;
  readonly desktopNumber: number;
  readonly reason: Desktop2HandoffReason;
  readonly description: string;
}
export interface Desktop2HandoffStatus {
  readonly phase: Desktop2Phase;
  readonly request?: Desktop2HandoffRequest;
}

const GUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;
const REASONS: readonly Desktop2HandoffReason[] = ['login', 'verification', 'permission', 'manual_action'];

export class Desktop2HandoffController {
  private phase: Desktop2Phase = 'autonomous';
  private activeRequest: Desktop2HandoffRequest | undefined;

  constructor(
    readonly leaseId: string,
    readonly desktopId: string,
    readonly desktopNumber: number
  ) {
    if (!GUID.test(leaseId) || !GUID.test(desktopId) || !Number.isInteger(desktopNumber) || desktopNumber < 2) {
      throw new Error('Human handoff requires a valid Agent lease and the real Windows virtual Desktop 2+.');
    }
  }

  status(): Desktop2HandoffStatus {
    return {
      phase: this.phase,
      ...(this.activeRequest ? {request: this.activeRequest} : {})
    };
  }

  assertAutonomous(leaseId: string, actualTargetDesktopId: string): void {
    if (this.phase !== 'autonomous') {
      throw new Error('Agent GUI input paused: explicit human handoff is pending, active, or revoked.');
    }
    if (leaseId.toLowerCase() !== this.leaseId.toLowerCase()
      || actualTargetDesktopId.toLowerCase() !== this.desktopId.toLowerCase()) {
      throw new Error('Agent GUI input denied: handoff lease or target Desktop 2 is different.');
    }
  }

  requestHandoff(reason: Desktop2HandoffReason, description: string): Desktop2HandoffRequest {
    if (this.phase !== 'autonomous') throw new Error('A Desktop 2 handoff is already pending or active.');
    if (!REASONS.includes(reason)) throw new Error('Unsupported Desktop 2 handoff reason.');
    const note = description.trim();
    if (note.length < 5 || note.length > 220 || /[\x00-\x1F]/u.test(note)) {
      throw new Error('Handoff description must contain 5..220 readable characters.');
    }
    // Creating a request does not change the active desktop or manipulate the
    // human's mouse/keyboard. It first locks autonomous input.
    const request = Object.freeze({
      requestId: randomUUID(),
      leaseId: this.leaseId,
      desktopId: this.desktopId,
      desktopNumber: this.desktopNumber,
      reason,
      description: note
    });
    this.activeRequest = request;
    this.phase = 'handoff_requested';
    return request;
  }

  /**
   * Only wire this to an actual owner-triggered Control Panel interaction.
   * It does not switch desktops; a user-initiated viewer/desktop-navigation
   * action is separate. Never expose this transition to an Agent MCP action.
   */
  ownerAcceptHandoff(requestId: string): Desktop2HandoffStatus {
    this.assertRequest(requestId, 'handoff_requested');
    this.phase = 'human_control';
    return this.status();
  }

  /**
   * Only the owner-facing UI may mark manual operation complete. No automatic
   * timer or Agent call may use this to resume after login/OTP/permission.
   * NEVER auto-switch the owner back to Desktop 1.
   */
  ownerCompleteHandoff(requestId: string): Desktop2HandoffStatus {
    this.assertRequest(requestId, 'human_control');
    this.activeRequest = undefined;
    this.phase = 'autonomous';
    return this.status();
  }

  ownerDismissHandoff(requestId: string): Desktop2HandoffStatus {
    this.assertRequest(requestId, 'handoff_requested');
    this.activeRequest = undefined;
    this.phase = 'autonomous';
    return this.status();
  }

  revokeLease(): Desktop2HandoffStatus {
    this.phase = 'revoked';
    this.activeRequest = undefined;
    return this.status();
  }

  private assertRequest(requestId: string, expected: Desktop2Phase): void {
    if (this.phase !== expected || !this.activeRequest
      || this.activeRequest.requestId !== requestId) {
      throw new Error('Stale or unauthorized Desktop 2 handoff transition.');
    }
  }
}
