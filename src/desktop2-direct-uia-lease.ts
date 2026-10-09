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
  | { readonly type: 'set_native_edit'; readonly automationId: string; readonly value: string; readonly expectedPreviousValue: string }
  | { readonly type: 'click_native_button'; readonly automationId: string }
  | { readonly type: 'scroll_native_list'; readonly automationId: string; readonly topIndex: number; readonly expectedPreviousTopIndex: number }
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
  readonly canSetNativeValue?: boolean;
  readonly canClickNative?: boolean;
  readonly canScrollNativeList?: boolean;
}
export interface Desktop2UiaRequest {
  readonly action: 'inspect' | 'inspect-tree' | 'inspect-native-edits'
    | 'inspect-native-buttons' | 'click-native-button'
    | 'inspect-native-lists' | 'scroll-native-list'
    | 'set-value' | 'set-native-edit' | 'scroll-top' | 'scroll-bottom';
  readonly hwnd: number;
  readonly processId: number;
  readonly desktopId: string;
  readonly automationId: string;
  readonly observerReady: string;
  readonly value?: string;
  readonly expectedPreviousValue?: string;
  readonly topIndex?: number;
  readonly expectedPreviousTopIndex?: number;
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
  private static nativeAction(action: Desktop2UiaAction): Pick<Desktop2UiaRequest, 'action' | 'automationId' | 'value' | 'expectedPreviousValue' | 'topIndex' | 'expectedPreviousTopIndex'> {
    const automationId = Desktop2DirectUiaLeaseCoordinator.validateId(action.automationId);
    if (action.type === 'set_value') {
      // A real protected WPF window stole the user's foreground on
      // 2026-10-09 during ValuePattern.SetValue despite WS_EX_NOACTIVATE.
      // Do not invoke this unsafe provider transport again.
      throw new Error('DIRECT_UIA_VALUEPATTERN_QUARANTINED_AFTER_FOREGROUND_THEFT');
    }
    if (action.type === 'set_native_edit') {
      if (!/^native-edit:[1-9][0-9]{0,17}$/u.test(automationId)
          || !Number.isSafeInteger(Number(automationId.slice('native-edit:'.length)))
          || action.value.length > 512 || action.expectedPreviousValue.length > 512
          || /[\x00-\x1f\x7f]/u.test(action.value)
          || /[\x00-\x1f\x7f]/u.test(action.expectedPreviousValue)) {
        throw new Error('A bounded native Edit observation and exact prior value are required.');
      }
      return { action:'set-native-edit', automationId, value:action.value,
        expectedPreviousValue:action.expectedPreviousValue };
    }
    if (action.type === 'click_native_button') {
      if (!/^native-button:[1-9][0-9]{0,15}$/u.test(automationId)
          || !Number.isSafeInteger(Number(automationId.slice('native-button:'.length)))) {
        throw new Error('Verified native pushbutton HWND capability required.');
      }
      return { action:'click-native-button', automationId };
    }
    if (action.type === 'scroll_native_list') {
      if (!/^native-list:[1-9][0-9]{0,15}$/u.test(automationId)
          || !Number.isSafeInteger(Number(automationId.slice('native-list:'.length)))
          || !Number.isSafeInteger(action.topIndex) || action.topIndex < 0 || action.topIndex >= 512
          || !Number.isSafeInteger(action.expectedPreviousTopIndex)
          || action.expectedPreviousTopIndex < 0 || action.expectedPreviousTopIndex >= 512) {
        throw new Error('Verified native ListBox and bounded exact indices required.');
      }
      return { action:'scroll-native-list', automationId,
        topIndex:action.topIndex, expectedPreviousTopIndex:action.expectedPreviousTopIndex };
    }
    if (action.type === 'scroll') {
      // UIA ScrollPattern.SetScrollPercent has no real zero-foreground
      // Desktop2 acceptance. Native HWND ListBox scroll is separate.
      throw new Error('DIRECT_UIA_SCROLLPATTERN_NOT_LIVE_ACCEPTED');
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
          || c.canSetValue !== false || c.canScrollTopBottom !== false) {
        // The former ValuePattern mutation is quarantined after actual
        // Desktop1 foreground theft. Reject even a forged "canSetValue"
        // response instead of issuing a one-use mutation capability.
        throw new Error('Desktop2 UIA edit capability is quarantined or semantic control is invalid.');
      }
      seen.add(c.automationId);
      controls.push({
        automationId: c.automationId, controlType: c.controlType, className: c.className,
        canSetValue: c.canSetValue, canScrollTopBottom: c.canScrollTopBottom
      });
    }
    return controls;
  }

  /**
   * Native HWND-only inventory. Never enters the UIAutomation provider,
   * never reads user text, and cannot mint a WPF TextBox write permit.
   */
  async inspectNativeControls(scope: Desktop2UiaScope): Promise<readonly Desktop2SemanticControl[]> {
    const proof=await this.verify(scope);
    const raw=await this.invoker.execute('request',{
      action:'inspect-native-edits',hwnd:scope.window.hwnd,
      processId:scope.window.processId,desktopId:proof.desktopId,
      automationId:'__native_edit_snapshot__',observerReady:scope.observerReadyFile
    });
    await this.verify(scope,proof);
    if(!raw || typeof raw!=='object' || Array.isArray(raw))
      throw new Error('Invalid native Edit inventory');
    const r=raw as Record<string,unknown>;
    if(r.operation!=='inspect-native-edits' || r.hwnd!==scope.window.hwnd
       || r.processId!==scope.window.processId
       || r.uiaReadbackConfirmed!==false || r.appEventConfirmed!==false
       || !Number.isInteger(r.scannedNodes) || Number(r.scannedNodes)<0
       || Number(r.scannedNodes)>128 || !Array.isArray(r.controls)
       || r.controls.length>32 || r.controls.length>Number(r.scannedNodes))
      throw new Error('Native Edit snapshot does not match target identity');
    const seen=new Set<string>();
    return r.controls.map((entry:unknown)=>{
      if(!entry||typeof entry!=='object'||Array.isArray(entry))
        throw new Error('Invalid native Edit control');
      const c=entry as Record<string,unknown>;
      if(typeof c.automationId!=='string'
         || !/^native-edit:[1-9][0-9]{0,17}$/u.test(c.automationId)
         || !Number.isSafeInteger(Number(c.automationId.slice(12)))
         || seen.has(c.automationId)
         || c.controlType!=='NativeWin32.Edit'
         || typeof c.className!=='string'
         || (c.className.toLowerCase()!=='edit' && !c.className.toLowerCase().startsWith('windowsforms10.edit.'))
         || c.canSetValue!==false || c.canScrollTopBottom!==false
         || c.canSetNativeValue!==true)
         throw new Error('Forged or duplicate native HWND edit capability');
      seen.add(c.automationId);
      return {automationId:c.automationId,controlType:'NativeWin32.Edit',
        className:c.className,canSetValue:false,canScrollTopBottom:false,canSetNativeValue:true};
    });
  }

  /** Separate native HWND Button controls from unapproved UIA InvokePattern. */
  async inspectNativeButtons(scope:Desktop2UiaScope):Promise<readonly Desktop2SemanticControl[]> {
    const proof=await this.verify(scope);
    const raw=await this.invoker.execute('request',{
      action:'inspect-native-buttons',hwnd:scope.window.hwnd,
      processId:scope.window.processId,desktopId:proof.desktopId,
      automationId:'__native_button_snapshot__',observerReady:scope.observerReadyFile
    });
    await this.verify(scope,proof);
    if(!raw||typeof raw!=='object'||Array.isArray(raw))
      throw new Error('Native Button inventory missing.');
    const r=raw as Record<string,unknown>;
    if(r.operation!=='inspect-native-buttons'||r.hwnd!==scope.window.hwnd
       ||r.processId!==scope.window.processId||r.uiaReadbackConfirmed!==false
       ||r.appEventConfirmed!==false||!Number.isInteger(r.scannedNodes)
       ||Number(r.scannedNodes)<0||Number(r.scannedNodes)>128
       ||!Array.isArray(r.controls)||r.controls.length>32
       ||r.controls.length>Number(r.scannedNodes))
      throw new Error('Native Button inventory identity/size invalid.');
    const seen=new Set<string>();
    return r.controls.map((element:unknown)=>{
      if(!element||typeof element!=='object'||Array.isArray(element))
        throw new Error('Invalid native Button entry.');
      const c=element as Record<string,unknown>;
      if(typeof c.automationId!=='string'
        ||!/^native-button:[1-9][0-9]{0,15}$/u.test(c.automationId)
        ||!Number.isSafeInteger(Number(c.automationId.slice('native-button:'.length)))
        ||seen.has(c.automationId)
        ||c.controlType!=='NativeWin32.Button'
        ||typeof c.className!=='string'
        ||(c.className.toLowerCase()!=='button'
          &&!c.className.toLowerCase().startsWith('windowsforms10.button.'))
        ||c.canSetValue!==false||c.canScrollTopBottom!==false
        ||c.canSetNativeValue!==false||c.canClickNative!==true)
        throw new Error('Untrusted native Button capability.');
      seen.add(c.automationId);
      return {automationId:c.automationId,controlType:'NativeWin32.Button',
        className:c.className,canSetValue:false,canScrollTopBottom:false,
        canSetNativeValue:false,canClickNative:true};
    });
  }

  async inspectNativeLists(scope:Desktop2UiaScope):Promise<readonly Desktop2SemanticControl[]> {
    const proof=await this.verify(scope);
    const raw=await this.invoker.execute('request',{
      action:'inspect-native-lists',hwnd:scope.window.hwnd,
      processId:scope.window.processId,desktopId:proof.desktopId,
      automationId:'__native_list_snapshot__',observerReady:scope.observerReadyFile
    });
    await this.verify(scope,proof);
    if(!raw||typeof raw!=='object'||Array.isArray(raw))
      throw new Error('Native ListBox inventory missing.');
    const r=raw as Record<string,unknown>;
    if(r.operation!=='inspect-native-lists'||r.hwnd!==scope.window.hwnd
      ||r.processId!==scope.window.processId||r.uiaReadbackConfirmed!==false
      ||r.appEventConfirmed!==false||!Number.isInteger(r.scannedNodes)
      ||Number(r.scannedNodes)<0||Number(r.scannedNodes)>128
      ||!Array.isArray(r.controls)||r.controls.length>16
      ||r.controls.length>Number(r.scannedNodes))
      throw new Error('Native ListBox inventory identity/size invalid.');
    const seen=new Set<string>();
    return r.controls.map((row:unknown)=>{
      if(!row||typeof row!=='object'||Array.isArray(row))
        throw new Error('Invalid native ListBox row');
      const c=row as Record<string,unknown>;
      if(typeof c.automationId!=='string'
        || !/^native-list:[1-9][0-9]{0,15}$/u.test(c.automationId)
        || !Number.isSafeInteger(Number(c.automationId.slice('native-list:'.length)))
        || seen.has(c.automationId) || c.controlType!=='NativeWin32.ListBox'
        || typeof c.className!=='string'
        || (c.className.toLowerCase()!=='listbox'
          &&!c.className.toLowerCase().startsWith('windowsforms10.listbox.'))
        ||c.canSetValue!==false||c.canScrollTopBottom!==false
        ||c.canSetNativeValue!==false||c.canClickNative!==false
        ||c.canScrollNativeList!==true)
        throw new Error('Forged native ListBox capability');
      seen.add(c.automationId);
      return {automationId:c.automationId,controlType:'NativeWin32.ListBox',className:c.className,
        canSetValue:false,canScrollTopBottom:false,canSetNativeValue:false,
        canClickNative:false,canScrollNativeList:true};
    });
  }

  async perform(
    scope: Desktop2UiaScope,
    action: Desktop2UiaAction
  ): Promise<{ readonly uiaReadbackConfirmed: true; readonly appEventConfirmed: false }
    | { readonly textReadbackConfirmed: true; readonly appEventConfirmed: false; readonly foregroundSafetyUnproven: true }
    | { readonly messageDispatched: true; readonly appEventConfirmed: false; readonly foregroundSafetyUnproven: true }
    | { readonly topIndexReadbackConfirmed: true; readonly appEventConfirmed: false; readonly foregroundSafetyUnproven: true }> {
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
    if(action.type==='set_native_edit') {
      const native=result as {operation?:unknown;textReadbackConfirmed?:unknown;appEventConfirmed?:unknown;
        foregroundSafetyUnproven?:unknown}|null;
      if(!native || native.operation!=='set-native-edit' || native.textReadbackConfirmed!==true
          || native.appEventConfirmed!==false || native.foregroundSafetyUnproven!==true)
        throw new Error('Native HWND Edit write/readback not confirmed.');
      return {textReadbackConfirmed:true,appEventConfirmed:false,foregroundSafetyUnproven:true};
    }
    if(action.type==='scroll_native_list') {
      const state=result as {operation?:unknown;topIndexReadbackConfirmed?:unknown;
        appEventConfirmed?:unknown;foregroundSafetyUnproven?:unknown}|null;
      if(!state||state.operation!=='scroll-native-list'||state.topIndexReadbackConfirmed!==true
        ||state.appEventConfirmed!==false||state.foregroundSafetyUnproven!==true)
        throw new Error('Native ListBox top-index readback unconfirmed.');
      return {topIndexReadbackConfirmed:true,appEventConfirmed:false,foregroundSafetyUnproven:true};
    }
    if(action.type==='click_native_button') {
      const click=result as {operation?:unknown;messageDispatched?:unknown;appEventConfirmed?:unknown;
        foregroundSafetyUnproven?:unknown}|null;
      if(!click||click.operation!=='click-native-button'||click.messageDispatched!==true
        ||click.appEventConfirmed!==false||click.foregroundSafetyUnproven!==true)
        throw new Error('Native Button message dispatch unconfirmed.');
      return {messageDispatched:true,appEventConfirmed:false,foregroundSafetyUnproven:true};
    }
    // All approved mutation types have explicit native HWND acknowledgements
    // above. A future UIA response is NEVER an implicit success fallback.
    throw new Error('UNAPPROVED_UIA_MUTATION_RESULT');
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
