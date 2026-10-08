import type { ComputerWindow } from './computer-use-backend.js';
import type { ComputerUseRuntime } from './computer-use-runtime.js';
import type { Desktop2DirectUiaLeaseCoordinator, Desktop2UiaAction } from './desktop2-direct-uia-lease.js';

// Candidate handoff from the ACTUAL Computer Use one-time observation/window
// capability registries. Not registered as a production MCP tool.
// Live enumeration MUST be passive (do not call WinApp focus/activate paths).
type RegistryRuntime = Pick<ComputerUseRuntime, 'windows' | 'observations' | 'coordinator'>;
type LeaseNativeAdapter = Pick<Desktop2DirectUiaLeaseCoordinator, 'arm' | 'perform'>;
export interface Desktop2ComputerAction {
  readonly phase: 'arm' | 'perform';
  readonly windowId: string;
  readonly computerObservationId: string;
  readonly agentDesktopLeaseId: string;
  readonly observerReadyFile: string;
  readonly action?: Desktop2UiaAction;
}

export class Desktop2ComputerUseCandidate {
  constructor(
    private readonly runtime: RegistryRuntime,
    private readonly leaseNative: LeaseNativeAdapter,
    private readonly listLiveWindowsPassively: () => Promise<readonly ComputerWindow[]>
  ) {}

  async dispatch(input: Desktop2ComputerAction): Promise<unknown> {
    return this.runtime.coordinator.exclusive(async () => {
      // Require an explicit lease-bound Computer Use observation, never a bare
      // HWND or a user-desktop observation upgraded with a lease parameter.
      const observedLease = this.runtime.observations.peekLease(
        input.computerObservationId, input.windowId
      );
      if (!observedLease || observedLease.toLowerCase() !== input.agentDesktopLeaseId.toLowerCase()) {
        throw new Error('Real Desktop2 Computer Use requires a matching lease-bound observation.');
      }
      if (input.phase === 'arm' && input.action !== undefined) {
        throw new Error('Desktop2 watcher arming cannot execute a UI action.');
      }
      if (input.phase === 'perform' && !input.action) {
        throw new Error('Desktop2 mutation needs an explicit bounded semantic action.');
      }
      if (input.phase !== 'arm' && input.phase !== 'perform') {
        throw new Error('Unknown real Desktop2 action phase.');
      }

      // Window capability resolution is based on full HWND/PID/process/class
      // identity from a CURRENT inventory, not only the caller's HWND claim.
      const target = this.runtime.windows.resolve(
        input.windowId, await this.listLiveWindowsPassively()
      );
      if (target.title?.startsWith('DeskMCP Agent Desktop') === true) {
        throw new Error('Agent safety HUD is never a Computer Use target.');
      }

      const effectiveLease = this.runtime.observations.consume(
        input.computerObservationId, input.windowId, Date.now(), input.agentDesktopLeaseId
      );
      if (effectiveLease?.toLowerCase() !== input.agentDesktopLeaseId.toLowerCase()) {
        throw new Error('Lease-bound observation was revoked or changed.');
      }

      // Even a denied/partial native operation invalidates all other cached
      // observations of the target before the provider can have side effects.
      this.runtime.observations.advance(input.windowId, false);
      const scope = {
        leaseId: effectiveLease,
        window: { hwnd: target.hwnd, processId: target.processId },
        observerReadyFile: input.observerReadyFile
      };
      if (input.phase === 'arm') return this.leaseNative.arm(scope);
      return this.leaseNative.perform(scope, input.action!);
    });
  }
}
