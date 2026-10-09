import type { ComputerWindow } from './computer-use-backend.js';
import type { ComputerUseRuntime } from './computer-use-runtime.js';
import type { Desktop2DirectUiaLeaseCoordinator, Desktop2UiaAction, Desktop2SemanticControl } from './desktop2-direct-uia-lease.js';

// Candidate handoff from the ACTUAL Computer Use one-time observation/window
// capability registries. Not registered as a production MCP tool.
// Live enumeration MUST be passive (do not call WinApp focus/activate paths).
type RegistryRuntime = Pick<ComputerUseRuntime, 'windows' | 'observations' | 'coordinator'>;
type LeaseNativeAdapter = Pick<Desktop2DirectUiaLeaseCoordinator, 'arm' | 'perform'>
  & Partial<Pick<Desktop2DirectUiaLeaseCoordinator, 'inspectControls' | 'inspectNativeControls' | 'inspectNativeButtons'>>;
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

  // Called only through Desktop2ComputerUseSession after observer+lease
  // checks. Issue window capabilities from native passive enumeration; no
  // WinApp list/find or UIA provider calls occur in this bootstrap phase.
  async discoverWindows(agentDesktopLeaseId: string): Promise<readonly {
    windowId: string; computerObservationId: string; window: ComputerWindow;
  }[]> {
    return this.runtime.coordinator.exclusive(async () => {
      const windows = await this.listLiveWindowsPassively();
      if (windows.length > 100) throw new Error('Passive Desktop2 window inventory too large.');
      return windows.map(window => {
        const windowId = this.runtime.windows.issue(window);
        const computerObservationId = this.runtime.observations.issue(
          windowId, Date.now(), agentDesktopLeaseId
        );
        return { windowId, computerObservationId, window };
      });
    });
  }

  private readonly semanticObservations = new Map<string, {
    windowId: string; leaseId: string; observerReadyFile: string; controls: readonly Desktop2SemanticControl[];
  }>();

  /**
   * Called only after --arm-target succeeded. Unlike plain window discovery,
   * this issues an action token ONLY after a guarded, bounded UIA tree read.
   */
  async snapshotWindow(input: {
    windowId: string; agentDesktopLeaseId: string; observerReadyFile: string;
  }): Promise<{ readonly computerObservationId: string; readonly controls: readonly Desktop2SemanticControl[] }> {
    return this.runtime.coordinator.exclusive(async () => {
      if (!this.leaseNative.inspectControls)
        throw new Error('Protected Desktop2 semantic snapshot provider is unavailable.');
      const target = this.runtime.windows.resolve(
        input.windowId, await this.listLiveWindowsPassively()
      );
      if (target.title?.startsWith('DeskMCP Agent Desktop'))
        throw new Error('Cannot inspect Agent safety HUD.');
      const controls = await this.leaseNative.inspectControls({
        leaseId: input.agentDesktopLeaseId,
        window: { hwnd: target.hwnd, processId: target.processId },
        observerReadyFile: input.observerReadyFile
      });
      if (!Array.isArray(controls) || controls.length > 32) {
        throw new Error('Protected Desktop2 semantic snapshot was not bounded.');
      }
      const seen = new Set<string>();
      for (const item of controls) {
        if (!item || typeof item.automationId !== 'string'
            || item.automationId.length < 1 || item.automationId.length > 128
            || seen.has(item.automationId)
            || typeof item.canSetValue !== 'boolean'
            || typeof item.canScrollTopBottom !== 'boolean'
            || (!item.canSetValue && !item.canScrollTopBottom)) {
          throw new Error('Protected Desktop2 semantic snapshot is invalid.');
        }
        seen.add(item.automationId);
      }
      const computerObservationId = this.runtime.observations.issue(
        input.windowId, Date.now(), input.agentDesktopLeaseId
      );
      if (this.semanticObservations.size >= 128) {
        const oldest = this.semanticObservations.keys().next().value;
        if (oldest) this.semanticObservations.delete(oldest);
      }
      this.semanticObservations.set(computerObservationId, {
        windowId: input.windowId, leaseId: input.agentDesktopLeaseId.toLowerCase(),
        observerReadyFile: input.observerReadyFile,
        controls: controls.map(c => ({ ...c }))
      });
      return { computerObservationId, controls };
    });
  }

  /**
   * Separate capability provenance for REAL Win32 child Edit HWNDs.
   * No UIAutomation snapshot or synthetic input/keyboard fallback.
   */
  async snapshotNativeWindow(input:{
    windowId:string;agentDesktopLeaseId:string;observerReadyFile:string;
  }):Promise<{readonly computerObservationId:string;readonly controls:readonly Desktop2SemanticControl[]}> {
    return this.runtime.coordinator.exclusive(async()=>{
      if(!this.leaseNative.inspectNativeControls)
        throw new Error('Native Edit inventory provider unavailable');
      const target=this.runtime.windows.resolve(input.windowId,await this.listLiveWindowsPassively());
      if(target.title?.startsWith('DeskMCP Agent Desktop'))
        throw new Error('Cannot inspect safety HUD');
      const controls=await this.leaseNative.inspectNativeControls({
        leaseId:input.agentDesktopLeaseId,window:{hwnd:target.hwnd,processId:target.processId},
        observerReadyFile:input.observerReadyFile
      });
      if(!Array.isArray(controls)||controls.length>32)
        throw new Error('Unbounded native Edit inventory');
      const seen=new Set<string>();
      for(const row of controls){
        if(!row||typeof row.automationId!=='string'
          || !/^native-edit:[1-9][0-9]{0,17}$/u.test(row.automationId)
          || seen.has(row.automationId) || row.controlType!=='NativeWin32.Edit'
          || row.canSetValue!==false || row.canScrollTopBottom!==false
          || row.canSetNativeValue!==true)
          throw new Error('Invalid native HWND capability');
        seen.add(row.automationId);
      }
      const computerObservationId=this.runtime.observations.issue(
        input.windowId,Date.now(),input.agentDesktopLeaseId);
      if(this.semanticObservations.size>=128){
        const oldest=this.semanticObservations.keys().next().value;
        if(oldest)this.semanticObservations.delete(oldest);
      }
      this.semanticObservations.set(computerObservationId,{
        windowId:input.windowId,leaseId:input.agentDesktopLeaseId.toLowerCase(),
        observerReadyFile:input.observerReadyFile,controls:controls.map(c=>({...c}))
      });
      return {computerObservationId,controls};
    });
  }

  /** Distinct one-use native HWND PUSHBUTTON observation; no UIA Invoke. */
  async snapshotNativeButtons(input:{
    windowId:string;agentDesktopLeaseId:string;observerReadyFile:string;
  }):Promise<{readonly computerObservationId:string;readonly controls:readonly Desktop2SemanticControl[]}>{
    return this.runtime.coordinator.exclusive(async()=>{
      if(!this.leaseNative.inspectNativeButtons)
        throw new Error('Native HWND Button adapter unavailable.');
      const target=this.runtime.windows.resolve(input.windowId,await this.listLiveWindowsPassively());
      if(target.title?.startsWith('DeskMCP Agent Desktop'))
        throw new Error('Safety HUD is not a button target.');
      const controls=await this.leaseNative.inspectNativeButtons({
        leaseId:input.agentDesktopLeaseId,window:{hwnd:target.hwnd,processId:target.processId},
        observerReadyFile:input.observerReadyFile
      });
      if(!Array.isArray(controls)||controls.length>32)
        throw new Error('Native Button inventory exceeds limit.');
      const seen=new Set<string>();
      for(const control of controls){
        if(!control||typeof control.automationId!=='string'
          ||!/^native-button:[1-9][0-9]{0,15}$/u.test(control.automationId)
          ||seen.has(control.automationId)||control.controlType!=='NativeWin32.Button'
          ||control.canClickNative!==true||control.canSetValue!==false
          ||control.canScrollTopBottom!==false||control.canSetNativeValue!==false)
          throw new Error('Untrusted native Button control.');
        seen.add(control.automationId);
      }
      const computerObservationId=this.runtime.observations.issue(
        input.windowId,Date.now(),input.agentDesktopLeaseId);
      if(this.semanticObservations.size>=128){
        const oldest=this.semanticObservations.keys().next().value;
        if(oldest)this.semanticObservations.delete(oldest);
      }
      this.semanticObservations.set(computerObservationId,{
        windowId:input.windowId,leaseId:input.agentDesktopLeaseId.toLowerCase(),
        observerReadyFile:input.observerReadyFile,controls:controls.map(c=>({...c}))
      });
      return {computerObservationId,controls};
    });
  }

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

      if (input.phase === 'perform') {
        const observed = this.semanticObservations.get(input.computerObservationId);
        // Burn the snapshot permit even when the selector is untrusted. A
        // caller cannot re-guess IDs against a real Desktop2 UIA provider.
        this.semanticObservations.delete(input.computerObservationId);
        const action = input.action!;
        const allowed = observed?.controls.find(
          row => row.automationId === action.automationId
        );
        if (!observed || observed.windowId !== input.windowId
            || observed.leaseId !== input.agentDesktopLeaseId.toLowerCase()
            || observed.observerReadyFile !== input.observerReadyFile
            || !allowed
            || (action.type === 'set_value' && !allowed.canSetValue)
            || (action.type === 'scroll' && !allowed.canScrollTopBottom)
            || (action.type === 'set_native_edit' && !allowed.canSetNativeValue)
            || (action.type === 'click_native_button' && !allowed.canClickNative)
            || (action.type !== 'set_value' && action.type !== 'scroll'
                && action.type !== 'set_native_edit' && action.type !== 'click_native_button')) {
          throw new Error('Desktop2 action requires a fresh protected semantic control snapshot.');
        }
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
