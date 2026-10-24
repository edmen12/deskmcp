import type { ComputerWindow } from './computer-use-backend.js';
import type { Desktop2ComputerUseSession } from './desktop2-computer-use-session.js';
import type { Desktop2UiaAction, Desktop2SemanticControl } from './desktop2-direct-uia-lease.js';

// Candidate-owned real Win+Tab Desktop2 action facade. It cannot launch or move
// a window. Ownership must be attested independently by a trusted launcher,
// not inferred from a title, claimed PID, desktop number or caller input.
// No MCP route is exported until that launcher and the foreground monitor are
// admitted together. The verifier defaults to fail closed.
type Session = Pick<Desktop2ComputerUseSession,
  'start' | 'stop' | 'discoverWindows' | 'dispatch' |
  'snapshotNativeWindow' | 'snapshotNativeButtons' | 'snapshotNativeLists'>;
type Kind = 'edit' | 'button' | 'list';
type OwnedVerifier = (window: ComputerWindow) => Promise<boolean>;
type ActionTicket = {
  readonly windowId: string;
  readonly observationId: string;
  readonly kind: Kind;
  readonly automationIds: ReadonlySet<string>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class RealDesktop2OwnedControl {
  private session: Session | undefined;
  private leaseId: string | undefined;
  private readonly windows = new Map<string, ComputerWindow>();
  private readonly actions = new Map<string, ActionTicket>();
  private armedWindowId: string | undefined;
  private opening = false;
  private closing = false;
  private busy = false;

  constructor(
    private readonly createSession: (leaseId: string) => Session,
    private readonly assertTrustedOwnedWindow: OwnedVerifier = async () => false
  ) {}

  private checked(leaseId: string): Session {
    if (!this.session || !this.leaseId || leaseId.toLowerCase() !== this.leaseId ||
        this.closing || this.opening) {
      throw new Error('REAL_D2_OWNED_SESSION_NOT_ACTIVE_OR_LEASE_CHANGED');
    }
    return this.session;
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy || this.closing) throw new Error('REAL_D2_OWNED_OPERATION_BUSY');
    this.busy = true;
    try { return await work(); }
    finally { this.busy = false; }
  }

  async start(leaseId: string): Promise<void> {
    if (!UUID.test(leaseId) || this.session || this.opening || this.closing || this.busy)
      throw new Error('REAL_D2_OWNED_START_REQUIRES_FRESH_LEASE');
    this.opening = true;
    let next: Session | undefined;
    try {
      next = this.createSession(leaseId);
      // The session starts and validates the independent WinEvent/VDA watcher
      // before any window is exposed.
      await next.start();
      this.leaseId = leaseId.toLowerCase();
      this.session = next;
    } catch (error) {
      if (next) await next.stop().catch(() => undefined);
      throw error;
    } finally { this.opening = false; }
  }

  async list(leaseId: string): Promise<readonly {
    window_id: string; app: string; class_name: string;
  }[]> {
    return this.exclusive(async () => {
      const session = this.checked(leaseId);
      const found = await session.discoverWindows();
      if (found.length > 100) throw new Error('REAL_D2_UNBOUNDED_WINDOW_DISCOVERY');
      this.windows.clear();
      this.actions.clear();
      const accepted: {window_id:string;app:string;class_name:string}[] = [];
      for (const row of found) {
        if (!row || !UUID.test(row.windowId) ||
            !Number.isSafeInteger(row.window.processId) || row.window.processId < 1 ||
            !Number.isSafeInteger(row.window.hwnd) || row.window.hwnd < 1 ||
            row.window.title?.startsWith('DeskMCP Agent Desktop')) continue;
        if (await this.assertTrustedOwnedWindow(row.window) !== true) continue;
        if (this.windows.has(row.windowId)) throw new Error('REAL_D2_DUPLICATE_WINDOW_ID');
        this.windows.set(row.windowId, row.window);
        accepted.push({window_id: row.windowId, app: row.window.processName,
          class_name: row.window.className ?? ''});
      }
      return accepted;
    });
  }

  async snapshot(leaseId: string, windowId: string, kind: Kind): Promise<{
    computer_observation_id: string;
    controls: readonly Desktop2SemanticControl[];
    one_shot_native_permit: true;
  }> {
    return this.exclusive(async () => {
      const session = this.checked(leaseId);
      // A failed or partial refresh must never preserve the previous permit.
      this.actions.clear();
      const window = this.windows.get(windowId);
      if (!window || !(await this.assertTrustedOwnedWindow(window)))
        throw new Error('REAL_D2_WINDOW_NOT_ATTESTED');
      if (kind !== 'edit' && kind !== 'button' && kind !== 'list')
        throw new Error('REAL_D2_CONTROL_KIND_NOT_ACCEPTED');
      const fresh = await session.discoverWindows();
      const row = fresh.find(r => r.windowId === windowId &&
        r.window.hwnd === window.hwnd && r.window.processId === window.processId);
      if (!row) throw new Error('REAL_D2_WINDOW_IDENTITY_CHANGED');
      // Arm the independent foreground hook once per exact root HWND.
      // Re-arming the same watcher mid-session can discard its tripwire.
      if (this.armedWindowId && this.armedWindowId !== windowId)
        throw new Error('REAL_D2_NEW_TARGET_REQUIRES_FRESH_OBSERVER');
      if (!this.armedWindowId) {
        await session.dispatch({phase:'arm', windowId,
          computerObservationId:row.computerObservationId});
        this.armedWindowId = windowId;
      }
      const observed = kind === 'edit' ? await session.snapshotNativeWindow(windowId)
        : kind === 'button' ? await session.snapshotNativeButtons(windowId)
        : await session.snapshotNativeLists(windowId);
      if (!observed || !UUID.test(observed.computerObservationId) ||
          !Array.isArray(observed.controls) || observed.controls.length > 16)
        throw new Error('REAL_D2_UNTRUSTED_NATIVE_SNAPSHOT');
      const ids = new Set<string>();
      for (const c of observed.controls) {
        if (!c || typeof c.automationId !== 'string' ||
            ids.has(c.automationId) ||
            (kind === 'edit' && (c.controlType !== 'NativeWin32.Edit' ||
              c.canSetNativeValue !== true)) ||
            (kind === 'button' && (c.controlType !== 'NativeWin32.Button' ||
              c.canClickNative !== true)) ||
            (kind === 'list' && (c.controlType !== 'NativeWin32.ListBox' ||
              c.canScrollNativeList !== true))) {
          throw new Error('REAL_D2_NATIVE_CONTROL_PROVENANCE_REJECTED');
        }
        ids.add(c.automationId);
      }
      this.actions.clear();
      this.actions.set(observed.computerObservationId, {
        windowId, observationId:observed.computerObservationId, kind,
        automationIds:ids
      });
      return {computer_observation_id: observed.computerObservationId,
        controls: observed.controls, one_shot_native_permit:true};
    });
  }

  async perform(leaseId: string, windowId: string, observationId: string,
    action: Desktop2UiaAction): Promise<{
      dispatched: boolean;
      app_event_verified: false;
      business_outcome_verified: false;
    }> {
    return this.exclusive(async () => {
      const session = this.checked(leaseId);
      const capability = this.actions.get(observationId);
      // Burn BEFORE any async ownership/provider step, including an error.
      this.actions.delete(observationId);
      const window = this.windows.get(windowId);
      if (!capability || capability.windowId !== windowId ||
          capability.observationId !== observationId || !window)
        throw new Error('REAL_D2_ONESHOT_OBSERVATION_INVALID');
      if (!capability.automationIds.has(action.automationId))
        throw new Error('REAL_D2_UNOBSERVED_NATIVE_CONTROL');
      if ((capability.kind === 'edit' && action.type !== 'set_native_edit') ||
          (capability.kind === 'button' && action.type !== 'click_native_button') ||
          (capability.kind === 'list' && action.type !== 'scroll_native_list'))
        throw new Error('REAL_D2_UNSAFE_NATIVE_ACTION_KIND');
      if (!(await this.assertTrustedOwnedWindow(window)))
        throw new Error('REAL_D2_OWNERSHIP_REVOKED');
      // Underlying coordinator checks live VDA desktop GUID, HUD heartbeat,
      // observer health, HWND/PID and one-use native observation again.
      const result = await session.dispatch({phase:'perform', windowId,
        computerObservationId:observationId, action});
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error('REAL_D2_NATIVE_DISPATCH_UNCONFIRMED');
      const r = result as Record<string, unknown>;
      const delivered = action.type === 'set_native_edit'
        ? r.textReadbackConfirmed === true
        : action.type === 'click_native_button'
        ? r.messageDispatched === true
        : r.topIndexReadbackConfirmed === true;
      if (!delivered) throw new Error('REAL_D2_NATIVE_DISPATCH_UNCONFIRMED');
      // OS message delivery is deliberately not equated with an app callback.
      return {dispatched:true, app_event_verified:false,
        business_outcome_verified:false};
    });
  }

  async stop(leaseId: string): Promise<void> {
    const session = this.checked(leaseId);
    if (this.busy) throw new Error('REAL_D2_WAIT_FOR_INFLIGHT_OPERATION');
    this.closing = true;
    this.windows.clear();
    this.actions.clear();
    try { await session.stop(); }
    finally {
      this.session = undefined;
      this.leaseId = undefined;
      this.armedWindowId = undefined;
      this.closing = false;
    }
    // The HUD lease belongs to AgentDesktopManager, not this wrapper.
    // The caller must stop it AFTER the observer is gone.
  }
}
