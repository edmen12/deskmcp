import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from './paths.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface AgentDesktopNativeInfo {
  readonly officialApi: boolean;
  readonly virtualDesktopAccessor: boolean;
  readonly currentDesktopNumber?: number | null;
  readonly desktopCount?: number | null;
}

export interface AgentDesktopWindowInfo {
  readonly hwnd: string;
  readonly desktopId: string;
  readonly desktopNumber?: number | null;
  readonly onCurrentDesktop?: boolean;
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

  windowInfo(hwnd: number): Promise<AgentDesktopWindowInfo> {
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error('Invalid target HWND.');
    return this.run<AgentDesktopWindowInfo>(['window-info', '--hwnd', String(hwnd)]);
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
}
