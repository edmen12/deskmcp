import { PolicyDeniedError } from './desktop-policy.js';
import type { BrowserHandoffAgentPort } from './browser-handoff-boundary.js';

/**
 * Candidate in-process gate shared by the Browser Runtime and ALL generic
 * MCP tool registrars. No remote MCP action can open a handoff reservation.
 * Does not control OS-native operations outside this Gateway.
 */
export interface BrowserCrossToolGuard {
  assertNonBrowserToolAllowed(tool: string): void;
  runNonBrowserOperation<T>(tool: string, operation: () => Promise<T>): Promise<T>;
  /** Reserve immediately, then wait for already admitted operations to drain. */
  withHandoffBarrier<T>(request: () => Promise<T>, timeoutMs?: number): Promise<T>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

export function createBrowserCrossToolGuard(agentAuthority: BrowserHandoffAgentPort): BrowserCrossToolGuard {
  let admitted = 0;
  let handoffPending = false;
  const drained = new Set<() => void>();

  const assertAllowed = (tool: string): void => {
    if (handoffPending || agentAuthority.anySessionReserved()) {
      throw new PolicyDeniedError(
        'Browser human takeover quarantine: ' + tool +
        ' cannot access the filesystem, processes, or native desktop until trusted local handback.'
      );
    }
  };

  return Object.freeze({
    assertNonBrowserToolAllowed: assertAllowed,

    async runNonBrowserOperation<T>(tool: string, operation: () => Promise<T>): Promise<T> {
      // Admission is synchronous (before the first await) so a concurrent
      // handoff cannot slip between permission check and registration.
      assertAllowed(tool);
      admitted++;
      try {
        const result = await operation();
        // A separate local authority can revoke Agent access in parallel;
        // never return a late read as if it were still Agent-owned.
        assertAllowed(tool);
        return result;
      } finally {
        admitted--;
        if (admitted === 0) {
          for (const done of drained) done();
          drained.clear();
        }
      }
    },

    async withHandoffBarrier<T>(request: () => Promise<T>, timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<T> {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw new Error('Invalid local browser handoff drain deadline.');
      }
      if (handoffPending) throw new PolicyDeniedError('Another local browser handoff barrier is pending.');
      // Flip this BEFORE awaiting existing calls.
      handoffPending = true;
      try {
        if (admitted > 0) {
          await new Promise<void>((resolve, reject) => {
            const done = () => { clearTimeout(timer); drained.delete(done); resolve(); };
            const timer = setTimeout(() => {
              drained.delete(done);
              reject(new PolicyDeniedError('Browser handoff drain timed out; control has NOT been transferred.'));
            }, timeoutMs);
            drained.add(done);
          });
        }
        return await request();
      } finally {
        // On success boundary.anySessionReserved() stays true. On error the
        // temporary reservation clears and no browser ownership was changed.
        handoffPending = false;
      }
    }
  });
}
