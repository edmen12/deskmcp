import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from './paths.js';
import { buildDesktop2BackgroundInputArgs, type Desktop2MessageAction } from './desktop2-background-input.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface AgentDesktopNativeInfo {
  readonly officialApi: boolean;
  readonly virtualDesktopAccessor: boolean;
  readonly currentDesktopNumber?: number | null;
  readonly desktopCount?: number | null;
}

export interface AgentDesktopDesktopInfo {
  readonly desktopId: string;
  readonly present: boolean;
  readonly desktopNumber?: number | null;
  readonly desktopCount?: number | null;
  readonly currentDesktopNumber?: number | null;
}

export interface AgentDesktopWindowInfo {
  readonly hwnd: string;
  readonly desktopId: string;
  readonly desktopNumber?: number | null;
  readonly onCurrentDesktop?: boolean;
  readonly isVisible?: boolean;
}

export interface AgentDesktopPassiveWindow {
  readonly hwnd: number;
  readonly processId: number;
  readonly processName: string;
  readonly title: string;
  readonly className: string;
  readonly width: number;
  readonly height: number;
  readonly isForeground: false;
  readonly desktopId: string;
  readonly desktopNumber: 2;
  readonly onCurrentDesktop: false;
}

export interface AgentDesktopPassiveInventory {
  readonly desktopId: string;
  readonly desktopNumber: 2;
  readonly currentDesktopNumber: 1;
  readonly windows: readonly AgentDesktopPassiveWindow[];
}

export interface AgentDesktopMoveProcessResult {
  readonly processId: number;
  readonly moved: number;
  readonly windows: ReadonlyArray<{
    readonly hwnd: string;
    readonly desktopId: string;
    readonly desktopNumber?: number | null;
  }>;
}

function targetName(): 'win-arm64' | 'win-x64' {
  return process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
}

export function resolveAgentDesktopHostPath(): string {
  const configured = process.env.DESKTOP_MCP_AGENT_DESKTOP_HOST_PATH?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (!existsSync(resolved)) throw new Error('Configured Agent Desktop native host does not exist.');
    return resolved;
  }

  const candidates = [
    path.resolve(PROJECT_ROOT, '..', 'DeskMCP.AgentDesktopHost.exe'),
    path.join(PROJECT_ROOT, 'runtime', 'agent-desktop-host', targetName(), 'DeskMCP.AgentDesktopHost.exe'),
    path.join(PROJECT_ROOT, 'agent-desktop-host', 'bin', 'Release', 'net10.0-windows', targetName(), 'DeskMCP.AgentDesktopHost.exe')
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error('DeskMCP Agent Desktop native host is unavailable. Build or reinstall DeskMCP.');
  return found;
}

function normalizeDesktopId(value: string): string {
  const selected = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(selected)) {
    throw new Error('Invalid Agent Desktop id.');
  }
  return selected;
}

function parseJson<T>(value: string): T {
  const text = value.trim();
  if (!text) throw new Error('Agent Desktop native host returned no output.');
  try { return JSON.parse(text) as T; }
  catch { throw new Error('Agent Desktop native host returned invalid JSON.'); }
}

export class AgentDesktopNativeBridge {
  constructor(private readonly executableResolver: () => string = resolveAgentDesktopHostPath) {}

  private async run<T>(args: readonly string[], timeoutMs = 8000): Promise<T> {
    if (process.platform !== 'win32') throw new Error('Agent Desktop is only available on Windows.');
    const executable = this.executableResolver();
    try {
      const { stdout } = await execFileAsync(executable, [...args], {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: process.env
      });
      return parseJson<T>(stdout);
    } catch (error) {
      const value = error as { stderr?: string; message?: string };
      const detail = value.stderr?.trim() || value.message || 'native host failed';
      throw new Error(`Agent Desktop native operation failed: ${detail.slice(0, 800)}`);
    }
  }

  info(): Promise<AgentDesktopNativeInfo> {
    return this.run<AgentDesktopNativeInfo>(['info']);
  }

  desktopById(desktopId: string): Promise<AgentDesktopDesktopInfo> {
    return this.run<AgentDesktopDesktopInfo>(['desktop-by-id', '--desktop-id', normalizeDesktopId(desktopId)]);
  }

  // Non-activating real Windows virtual Desktop2 inventory. The native
  // command only enumerates windows; never calls WinApp/activation/input.
  listVirtualWindows(desktopId: string): Promise<AgentDesktopPassiveInventory> {
    return this.run<AgentDesktopPassiveInventory>([
      'list-virtual-windows', '--desktop-id', normalizeDesktopId(desktopId)
    ]);
  }

  windowInfo(hwnd: number): Promise<AgentDesktopWindowInfo> {
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error('Invalid target HWND.');
    return this.run<AgentDesktopWindowInfo>(['window-info', '--hwnd', String(hwnd)]);
  }

  // Candidate-only exact fresh Winver hidden placement. Unlike generic
  // moveWindow, the native host rejects wrong PID/creation time, visible,
  // foreground, shared, wrong-source or wrong-destination HWNDs. Not an
  // input permit and not a substitute for strict prelaunch watcher.
  async moveOwnedHiddenWinver(
    hwnd: number, processId: number, startedUtc: string, desktopId: string,
    observer: {readyFile:string;tripwireFile:string;exePath:string;pid:number}
  ): Promise<AgentDesktopWindowInfo & {readonly hiddenMoveVerified: boolean;readonly ownerProcessId:number}> {
    if(!Number.isSafeInteger(hwnd)||hwnd<=0
       ||!Number.isSafeInteger(processId)||processId<=0
       ||typeof startedUtc!=='string'||startedUtc.length<15||startedUtc.length>50
       ||!Number.isFinite(Date.parse(startedUtc))
       ||!observer||!Number.isSafeInteger(observer.pid)||observer.pid<=0
       ||!path.isAbsolute(observer.readyFile)
       ||!path.isAbsolute(observer.tripwireFile)
       ||!path.isAbsolute(observer.exePath))
      throw new Error('Owned hidden Winver PID/HWND/start-time required.');
    return this.run<AgentDesktopWindowInfo & {readonly hiddenMoveVerified:boolean;readonly ownerProcessId:number}>([
      'move-owned-hidden-winver','--hwnd',String(hwnd),
      '--pid',String(processId),'--started-utc',startedUtc,
      '--desktop-id',normalizeDesktopId(desktopId),
      '--observer-ready',observer.readyFile,
      '--observer-tripwire',observer.tripwireFile,
      '--observer-exe',observer.exePath,
      '--observer-pid',String(observer.pid)
    ]);
  }

  async moveWindow(
    hwnd: number,
    desktopId: string,
    options: { restore?: boolean; showNoActivate?: boolean } = {}
  ): Promise<AgentDesktopWindowInfo> {
    if (options.restore && options.showNoActivate) throw new Error('Agent Desktop move cannot combine restore and showNoActivate.');
    const args = ['move-window', '--hwnd', String(hwnd), '--desktop-id', normalizeDesktopId(desktopId)];
    if (options.restore) args.push('--restore');
    if (options.showNoActivate) args.push('--show-no-activate');
    return this.run<AgentDesktopWindowInfo>(args);
  }

  async moveProcessWindows(
    processId: number,
    desktopId: string,
    options: { timeoutMs?: number; restore?: boolean; showNoActivate?: boolean } = {}
  ): Promise<AgentDesktopMoveProcessResult> {
    if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Invalid Agent Desktop process id.');
    if (options.restore && options.showNoActivate) throw new Error('Agent Desktop move cannot combine restore and showNoActivate.');
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Invalid Agent Desktop move timeout.');
    const args = [
      'move-process', '--pid', String(processId),
      '--desktop-id', normalizeDesktopId(desktopId),
      '--timeout-ms', String(timeoutMs)
    ];
    if (options.restore) args.push('--restore');
    if (options.showNoActivate) args.push('--show-no-activate');
    return this.run<AgentDesktopMoveProcessResult>(args, timeoutMs + 3000);
  }

  async moveProcessTreeWindows(
    processId: number,
    desktopId: string,
    options: { timeoutMs?: number; restore?: boolean; showNoActivate?: boolean } = {}
  ): Promise<AgentDesktopMoveProcessResult> {
    if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Invalid Agent Desktop process-tree root id.');
    if (options.restore && options.showNoActivate) throw new Error('Agent Desktop move cannot combine restore and showNoActivate.');
    const timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Invalid Agent Desktop process-tree move timeout.');
    const args = [
      'move-process-tree', '--pid', String(processId),
      '--desktop-id', normalizeDesktopId(desktopId),
      '--timeout-ms', String(timeoutMs)
    ];
    if (options.restore) args.push('--restore');
    if (options.showNoActivate) args.push('--show-no-activate');
    return this.run<AgentDesktopMoveProcessResult>(args, timeoutMs + 3000);
  }

  // Candidate only: not exposed through MCP until genuine Desktop 2 GUI,
  // app-state readback, lease ownership, and no-focus tests are accepted.
  async backgroundWindowMessage(
    hwnd: number,
    expectedProcessId: number,
    desktopId: string,
    action: Desktop2MessageAction
  ): Promise<{
    readonly acceptedByWindowProcedure: boolean;
    readonly confirmedAppState: boolean;
    readonly desktopNumber: number;
    readonly hostInputWasNotUsed: boolean;
  }> {
    const args = buildDesktop2BackgroundInputArgs(hwnd, expectedProcessId, desktopId, action);
    const info = await this.windowInfo(hwnd);
    if (info.desktopId.toLowerCase() !== desktopId.toLowerCase() || info.desktopNumber == null || info.desktopNumber < 2) {
      throw new Error('Target HWND is not assigned to the requested Windows virtual Desktop 2+.');
    }
    const state = await this.info();
    if (!state.virtualDesktopAccessor || state.currentDesktopNumber === undefined || state.currentDesktopNumber === null) {
      throw new Error('Cannot verify the active Windows virtual desktop.');
    }
    // This bridge is for the REAL Windows virtual Desktop 2, not the
    // historical private Win32 Desktop Object. The owner must still be on
    // Desktop 1; entering Desktop 2 is manual human control, not Agent input.
    if (state.currentDesktopNumber !== 1) {
      throw new Error('Owner left Desktop 1; pause autonomous Desktop 2 native input.');
    }
    if (info.onCurrentDesktop === true) {
      throw new Error('Pinned/shared window is visible on Desktop 1; refusing Agent input.');
    }
    const result = await this.run<{
      readonly acceptedByWindowProcedure: boolean;
      readonly confirmedAppState: boolean;
      readonly desktopNumber: number;
      readonly hostInputWasNotUsed: boolean;
    }>(args);
    const after = await this.info();
    if (!after.virtualDesktopAccessor || after.currentDesktopNumber !== 1) {
      // This catches a visible switch at post-check. Fast switch/back still
      // requires the separate continuous event tripwire.
      throw new Error('Owner desktop changed or could not be checked after background input.');
    }
    return result;
  }
}
