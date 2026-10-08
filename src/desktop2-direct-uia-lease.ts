import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import type { AgentDesktopNativeBridge } from './agent-desktop-native.js';

// Candidate-only. Not registered on the production Computer Use MCP route.
// A real virtual Desktop2 is NOT the private Win32 Desktop Object backend.
const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DESKTOP2 = 2;

export interface Desktop2UiaWindow {
  readonly hwnd: number;
  readonly processId: number;
}
export type Desktop2UiaAction =
  | { readonly type: 'set_value'; readonly automationId: string; readonly value: string }
  | { readonly type: 'scroll'; readonly automationId: string; readonly to: 'top' | 'bottom' };
export interface Desktop2UiaScope {
  readonly leaseId: string;
  readonly window: Desktop2UiaWindow;
  readonly observerReadyFile: string;
}
export interface Desktop2SemanticControl {
  readonly automationId: string;
  readonly controlType: string;
  readonly className: string;
  readonly canSetValue: boolean;
  readonly canScrollTopBottom: boolean;
}
export interface Desktop2UiaRequest {
  readonly action: 'inspect' | 'inspect-tree' | 'set-value' | 'scroll-top' | 'scroll-bottom';
  readonly hwnd: number;
  readonly processId: number;
  readonly desktopId: string;
  readonly automationId: string;
  readonly observerReady: string;
  readonly value?: string;
}
export interface Desktop2UiaInvoker {
  execute(mode: 'arm-target' | 'request', request: Desktop2UiaRequest): Promise<unknown>;
}
type Leases = Pick<AgentDesktopManager, 'assertLease' | 'assertWindowOnLease'>;
type Native = Pick<AgentDesktopNativeBridge, 'info' | 'desktopById' | 'windowInfo'>;
interface Proof {
  readonly desktopId: string;
  readonly generation: number;
  readonly leaseId: string;
}

/**
 * Accept only a window identity resolved by the MCP Computer Use observation
 * registry. Refuse arbitrary HWND discovery, global input and title matching.
 * Scope, active owner Desktop1, HUD heartbeat and generation must survive
 * BOTH the watcher arm and every native UIA action.
 */
export class Desktop2DirectUiaLeaseCoordinator {
  constructor(
    private readonly leases: Leases,
    private readonly native: Native,
    private readonly invoker: Desktop2UiaInvoker
  ) {}

  private async verify(scope: Desktop2UiaScope, old?: Proof): Promise<Proof> {
    if (!UUID.test(scope.leaseId)) throw new Error('Valid active Agent lease required.');
    if (!Number.isSafeInteger(scope.window.hwnd) || scope.window.hwnd < 1
        || !Number.isSafeInteger(scope.window.processId) || scope.window.processId < 1) {
      throw new Error('Observation-verified HWND/PID required.');
    }
    if (!path.isAbsolute(scope.observerReadyFile) || scope.observerReadyFile.includes('\0')) {
      throw new Error('Absolute observer readiness path required.');
    }
    // AgentDesktopManager.assertLease verifies the live HUD heartbeat.
    const { binding, control } = await this.leases.assertLease(scope.leaseId);
    if (!control.active || control.leaseId?.toLowerCase() !== scope.leaseId.toLowerCase()
        || !control.desktopId || binding.desktopId.toLowerCase() !== control.desktopId.toLowerCase()
        || control.desktopNumber !== DESKTOP2
        || !Number.isSafeInteger(control.generation)) {
      throw new Error('Lease does not own the real Windows Desktop2.');
    }
    const desktopId = binding.desktopId.toLowerCase();
    if (old && (old.desktopId !== desktopId || old.generation !== control.generation
        || old.leaseId !== scope.leaseId.toLowerCase())) {
      throw new Error('Lease generation or desktop changed during UIA operation.');
    }
    await this.leases.assertWindowOnLease(scope.window.hwnd, scope.leaseId);
    const [state, desktop, window] = await Promise.all([
      this.native.info(), this.native.desktopById(desktopId),
      this.native.windowInfo(scope.window.hwnd)
    ]);
    if (!state.virtualDesktopAccessor || state.currentDesktopNumber !== 1
        || desktop.present !== true || desktop.desktopId.toLowerCase() !== desktopId
        || desktop.desktopNumber !== DESKTOP2
        || window.desktopId.toLowerCase() !== desktopId
        || window.desktopNumber !== DESKTOP2 || window.onCurrentDesktop !== false) {
      throw new Error('Owner Desktop1, private Desktop2 window or desktop GUID cannot be verified.');
    }
    const checked = await this.leases.assertLease(scope.leaseId);
    if (!checked.control.active || checked.control.generation !== control.generation
        || checked.control.desktopId?.toLowerCase() !== desktopId) {
      throw new Error('Agent lease was revoked or replaced during checks.');
    }
    return { desktopId, generation: control.generation, leaseId: scope.leaseId.toLowerCase() };
  }

  private static validateId(id: string): string {
    if (typeof id !== 'string' || id.length < 1 || id.length > 128 || id.includes('\0')) {
      throw new Error('Unique bounded UIA automationId is required.');
    }
    return id;
  }
  private static nativeAction(action: Desktop2UiaAction): Pick<Desktop2UiaRequest, 'action' | 'automationId' | 'value'> {
    const automationId = Desktop2DirectUiaLeaseCoordinator.validateId(action.automationId);
    if (action.type === 'set_value') {
      // A real protected WPF window stole the user's foreground on
      // 2026-10-09 during ValuePattern.SetValue despite WS_EX_NOACTIVATE.
      // Do not invoke this unsafe provider transport again.
      throw new Error('DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT');
    }
    if (action.type === 'scroll' && (action.to === 'top' || action.to === 'bottom')) {
      return { action: action.to === 'top' ? 'scroll-top' : 'scroll-bottom', automationId };
    }
    throw new Error('Unverified Desktop2 native Computer Use action.');
  }

  async arm(scope: Desktop2UiaScope): Promise<{ readonly armed: true; readonly desktopId: string }> {
    const proof = await this.verify(scope);
    const request: Desktop2UiaRequest = {
      action: 'inspect',
      hwnd: scope.window.hwnd, processId: scope.window.processId,
      desktopId: proof.desktopId, automationId: '__lease_arm_only__',
      observerReady: scope.observerReadyFile
    };
    const result = await this.invoker.execute('arm-target', request);
    await this.verify(scope, proof);
    if (!result || typeof result !== 'object' || (result as { armed?: unknown }).armed !== true) {
      throw new Error('Early foreground observer arm was not confirmed.');
    }
    return { armed: true, desktopId: proof.desktopId };
  }

  /**
   * Only the native helper with an ALREADY armed target watch may inspect a
   * provider. Return capped metadata, never ValuePattern.Value or user text.
   */
  async inspectControls(scope: Desktop2UiaScope): Promise<readonly Desktop2SemanticControl[]> {
    const proof = await this.verify(scope);
    const request: Desktop2UiaRequest = {
      action: 'inspect-tree',
      hwnd: scope.window.hwnd, processId: scope.window.processId,
      desktopId: proof.desktopId, automationId: '__tree_snapshot__',
      observerReady: scope.observerReadyFile
    };
    const raw = await this.invoker.execute('request', request);
    await this.verify(scope, proof);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Untrusted Desktop2 semantic tree response.');
    const result = raw as Record<string, unknown>;
    if (result.operation !== 'inspect-tree'
        || result.hwnd !== scope.window.hwnd || result.processId !== scope.window.processId
        || result.uiaReadbackConfirmed !== false || result.appEventConfirmed !== false
        || !Number.isInteger(result.scannedNodes) || Number(result.scannedNodes) < 1
        || Number(result.scannedNodes) > 128 || !Array.isArray(result.controls)
        || result.controls.length > 32) {
      throw new Error('Desktop2 semantic snapshot does not match the verified window.');
    }
    const controls: Desktop2SemanticControl[] = [];
    const seen = new Set<string>();
    for (const row of result.controls) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new Error('Invalid Desktop2 semantic control.');
      const c = row as Record<string, unknown>;
      if (typeof c.automationId !== 'string' || c.automationId.length < 1
          || c.automationId.length > 128 || c.automationId.includes('\0')
          || seen.has(c.automationId)
          || typeof c.controlType !== 'string' || c.controlType.length > 90
          || typeof c.className !== 'string' || c.className.length > 260
          || typeof c.canSetValue !== 'boolean' || typeof c.canScrollTopBottom !== 'boolean'
          || (!c.canSetValue && !c.canScrollTopBottom)
          || (c.canSetValue && (c.controlType !== 'ControlType.Edit'
            || (c.className !== 'TextBox'
              && !c.className.startsWith('WindowsForms10.EDIT.'))))) {
        throw new Error('Desktop2 semantic snapshot contains duplicate or unauthorized control.');
      }
      seen.add(c.automationId);
      controls.push({
        automationId: c.automationId, controlType: c.controlType, className: c.className,
        canSetValue: c.canSetValue, canScrollTopBottom: c.canScrollTopBottom
      });
    }
    return controls;
  }

  async perform(
    scope: Desktop2UiaScope,
    action: Desktop2UiaAction
  ): Promise<{ readonly uiaReadbackConfirmed: true; readonly appEventConfirmed: false }> {
    const parsed = Desktop2DirectUiaLeaseCoordinator.nativeAction(action);
    const proof = await this.verify(scope);
    const request: Desktop2UiaRequest = {
      ...parsed, hwnd: scope.window.hwnd, processId: scope.window.processId,
      desktopId: proof.desktopId, observerReady: scope.observerReadyFile
    };
    // Native C# helper independently verifies observer target arm, desktop,
    // current Desktop1, protected window style and sticky switch tripwire.
    const result = await this.invoker.execute('request', request);
    await this.verify(scope, proof);
    if (!result || typeof result !== 'object'
        || (result as { uiaReadbackConfirmed?: unknown }).uiaReadbackConfirmed !== true
        || (result as { appEventConfirmed?: unknown }).appEventConfirmed !== false) {
      throw new Error('Native UIA readback not confirmed; app-level callback is not proven.');
    }
    return { uiaReadbackConfirmed: true, appEventConfirmed: false };
  }
}

/**
 * Windows-only helper invocation with a one-operation private request file.
 * This is deliberately NOT called by the production MCP Computer Use path.
 */
export class Desktop2DirectUiaProcessInvoker implements Desktop2UiaInvoker {
  constructor(
    private readonly executablePath: string,
    private readonly vdaDllPath: string
  ) {}

  async execute(mode: 'arm-target' | 'request', request: Desktop2UiaRequest): Promise<unknown> {
    if (process.platform !== 'win32') throw new Error('Direct UIA requires Windows.');
    if (!path.isAbsolute(this.executablePath)
        || path.basename(this.executablePath).toLowerCase() !== 'deskmcp.desktop2directuia.exe'
        || !path.isAbsolute(this.vdaDllPath)
        || path.basename(this.vdaDllPath).toLowerCase() !== 'virtualdesktopaccessor.dll') {
      throw new Error('Direct UIA executable/VDA DLL paths are not authorized.');
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-d2-uia-'));
    const filename = path.join(directory, randomUUID() + '.json');
    try {
      await writeFile(filename, JSON.stringify(request), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(this.executablePath, [
          mode === 'arm-target' ? '--arm-target' : '--request',
          filename, '--vda', this.vdaDllPath
        ], {
          shell: false, windowsHide: true, timeout: 8000, maxBuffer: 16384
        }));
      } catch {
        // Never leak the user-supplied text or native provider diagnostics.
        throw new Error('Direct Desktop2 UIA helper denied or failed.');
      }
      try { return JSON.parse(stdout) as unknown; }
      catch { throw new Error('Direct Desktop2 UIA helper returned invalid JSON.'); }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
