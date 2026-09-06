import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT } from './paths.js';

export const WINAPP_VERSION = 'v0.5.0';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ComputerWindow {
  readonly hwnd: number;
  readonly processId: number;
  readonly processName: string;
  readonly title?: string;
  readonly className?: string;
  readonly width: number;
  readonly height: number;
  readonly isForeground: boolean;
}

export interface UiElementSummary {
  readonly type?: string;
  readonly name?: string;
  readonly automationId?: string;
  readonly className?: string;
  readonly isEnabled?: boolean;
  readonly isOffscreen?: boolean;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly selector?: string;
  readonly value?: string;
  readonly ancestorPath?: readonly string[];
  readonly expandState?: string;
  readonly toggleState?: string;
  readonly isSelected?: boolean;
  readonly isInvokable?: boolean;
}

export interface WindowInspection {
  readonly hwnd: number;
  readonly title?: string;
  readonly elements: readonly UiElementSummary[];
}

export interface ScreenshotResult {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly hwnd: number;
  readonly title?: string;
}

export type UiAction =
  | { readonly type: 'invoke'; readonly selector: string }
  | { readonly type: 'set_value'; readonly selector: string; readonly value: string }
  | { readonly type: 'click'; readonly selector: string; readonly button?: 'left' | 'right'; readonly double?: boolean }
  | { readonly type: 'hover'; readonly selector: string; readonly dwellMs?: number }
  | { readonly type: 'scroll'; readonly selector?: string; readonly direction?: 'up' | 'down' | 'left' | 'right'; readonly to?: 'top' | 'bottom'; readonly wheel?: number }
  | { readonly type: 'send_keys'; readonly keys: string; readonly selector?: string; readonly transport?: 'post-message' | 'send-input'; readonly verbatim?: boolean; readonly allowSystemKeys?: boolean }
  | { readonly type: 'drag'; readonly from: string; readonly to: string; readonly right?: boolean; readonly holdMs?: number; readonly dwellMs?: number }
  | { readonly type: 'wait'; readonly milliseconds: number };

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function extractJson(value: string): unknown {
  const cleaned = stripAnsi(value).trim();
  const objectAt = cleaned.indexOf('{');
  const arrayAt = cleaned.indexOf('[');
  const starts = [objectAt, arrayAt].filter(index => index >= 0);
  if (starts.length === 0) throw new Error('Computer backend returned no JSON payload.');
  const start = Math.min(...starts);
  try {
    return JSON.parse(cleaned.slice(start));
  } catch {
    throw new Error('Computer backend returned invalid JSON.');
  }
}

export function sanitizeUiElementForMcp(value: UiElementSummary): UiElementSummary {
  return {
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.automationId === 'string' ? { automationId: value.automationId } : {}),
    ...(typeof value.className === 'string' ? { className: value.className } : {}),
    ...(typeof value.isEnabled === 'boolean' ? { isEnabled: value.isEnabled } : {}),
    ...(typeof value.isOffscreen === 'boolean' ? { isOffscreen: value.isOffscreen } : {}),
    ...(typeof value.x === 'number' && Number.isFinite(value.x) ? { x: value.x } : {}),
    ...(typeof value.y === 'number' && Number.isFinite(value.y) ? { y: value.y } : {}),
    ...(typeof value.width === 'number' && Number.isFinite(value.width) ? { width: value.width } : {}),
    ...(typeof value.height === 'number' && Number.isFinite(value.height) ? { height: value.height } : {}),
    ...(typeof value.selector === 'string' ? { selector: value.selector } : {}),
    ...(typeof value.value === 'string' ? { value: value.value } : {}),
    ...(Array.isArray(value.ancestorPath) && value.ancestorPath.every(item => typeof item === 'string')
      ? { ancestorPath: [...value.ancestorPath] }
      : {}),
    ...(typeof value.expandState === 'string' ? { expandState: value.expandState } : {}),
    ...(typeof value.toggleState === 'string' ? { toggleState: value.toggleState } : {}),
    ...(typeof value.isSelected === 'boolean' ? { isSelected: value.isSelected } : {}),
    ...(typeof value.isInvokable === 'boolean' ? { isInvokable: value.isInvokable } : {})
  };
}

export function flattenUiElementsForMcp(values: readonly unknown[], maxElements: number): UiElementSummary[] {
  const result: UiElementSummary[] = [];
  const limit = Math.max(0, Math.trunc(maxElements));

  const visit = (value: unknown, ancestors: readonly string[]): void => {
    if (result.length >= limit || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const projected = sanitizeUiElementForMcp(record as UiElementSummary);
    const withAncestors = projected.ancestorPath || ancestors.length === 0
      ? projected
      : { ...projected, ancestorPath: [...ancestors] };
    result.push(withAncestors);

    const nextAncestors = typeof projected.type === 'string'
      ? [...ancestors, projected.type]
      : ancestors;
    if (Array.isArray(record.children)) {
      for (const child of record.children) {
        visit(child, nextAncestors);
        if (result.length >= limit) break;
      }
    }
  };

  for (const value of values) {
    visit(value, []);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeExecutablePath(raw: string): string {
  const resolved = path.resolve(raw);
  if (!existsSync(resolved)) throw new Error('DeskMCP computer-use backend is not installed.');
  const skia = path.join(path.dirname(resolved), 'libSkiaSharp.dll');
  if (!existsSync(skia)) throw new Error('DeskMCP computer-use backend is incomplete: libSkiaSharp.dll is missing.');
  return resolved;
}

export function resolveWinAppPath(): string {
  const configured = process.env.DESKTOP_MCP_WINAPP_PATH?.trim();
  if (configured) return normalizeExecutablePath(configured);

  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = [
    path.join(PROJECT_ROOT, 'winapp', 'winapp.exe'),
    path.join(PROJECT_ROOT, 'runtime', 'downloads', 'winapp', WINAPP_VERSION, architecture, 'winapp.exe')
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error('DeskMCP computer-use backend is unavailable. Reinstall DeskMCP or set DESKTOP_MCP_WINAPP_PATH for development.');
  return normalizeExecutablePath(found);
}

export class WinAppComputerBackend {
  constructor(private readonly executableResolver: () => string = resolveWinAppPath) {}

  private async run(args: readonly string[], timeoutMs = 10_000): Promise<string> {
    if (process.platform !== 'win32') throw new Error('Windows computer use is only available on Windows.');
    const executable = this.executableResolver();

    return new Promise<string>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          WINAPP_CLI_TELEMETRY_OPTOUT: '1',
          NO_COLOR: '1'
        }
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (error?: Error, output?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(output ?? '');
      };

      const append = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(new Error('Computer backend output exceeded the DeskMCP safety limit.'));
          return;
        }
        target.push(chunk);
      };

      child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
      child.on('error', error => finish(new Error(`Computer backend failed to start: ${error.message}`)));
      child.on('close', code => {
        const output = Buffer.concat(stdout).toString('utf8');
        if (code === 0) return finish(undefined, output);
        const detail = stripAnsi(Buffer.concat(stderr).toString('utf8')).trim();
        const safeDetail = detail.length > 800 ? `${detail.slice(0, 800)}…` : detail;
        finish(new Error(safeDetail ? `Computer action failed: ${safeDetail}` : `Computer action failed with exit code ${code ?? 'unknown'}.`));
      });

      timer = setTimeout(() => {
        child.kill();
        finish(new Error('Computer action timed out.'));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private async runJson<T>(args: readonly string[], timeoutMs = 10_000): Promise<T> {
    return extractJson(await this.run([...args, '--json'], timeoutMs)) as T;
  }

  async listWindows(app?: string): Promise<ComputerWindow[]> {
    const args = ['ui', 'list-windows'];
    if (app) args.push('-a', app);
    const raw = await this.runJson<ComputerWindow[]>(args);
    return raw.filter(window => Number.isSafeInteger(window.hwnd) && window.hwnd > 0 && window.width > 0 && window.height > 0);
  }

  async inspect(hwnd: number, interactiveOnly = true, maxElements = 80): Promise<WindowInspection> {
    const args = ['ui', 'inspect', '-w', String(hwnd), '--depth', interactiveOnly ? '8' : '5'];
    if (interactiveOnly) args.push('--interactive');
    const raw = await this.runJson<{ windows?: Array<{ hwnd: number; title?: string; elements?: unknown[] }> }>(args, 12_000);
    const window = raw.windows?.find(item => item.hwnd === hwnd) ?? raw.windows?.[0];
    if (!window) throw new Error('Target window no longer exists.');
    return {
      hwnd: window.hwnd,
      ...(window.title ? { title: window.title } : {}),
      elements: flattenUiElementsForMcp(window.elements ?? [], maxElements)
    };
  }

  async screenshot(hwnd: number, options: { captureScreen?: boolean; focus?: boolean } = {}): Promise<ScreenshotResult> {
    const directory = path.join(os.tmpdir(), 'deskmcp-computer-use');
    await mkdir(directory, { recursive: true });
    const output = path.join(directory, `${randomUUID()}.png`);
    try {
      const args = ['ui', 'screenshot', '-w', String(hwnd), '--output', output];
      if (options.captureScreen) args.push('--capture-screen');
      else if (options.focus) args.push('--focus');
      const metadata = await this.runJson<{ width: number; height: number; hwnd: number; windowTitle?: string }>(args, 15_000);
      return {
        data: await readFile(output),
        width: metadata.width,
        height: metadata.height,
        hwnd: metadata.hwnd,
        ...(metadata.windowTitle ? { title: metadata.windowTitle } : {})
      };
    } finally {
      await rm(output, { force: true }).catch(() => undefined);
    }
  }

  async act(hwnd: number, action: UiAction): Promise<unknown> {
    if (action.type === 'wait') {
      await new Promise(resolve => setTimeout(resolve, action.milliseconds));
      return { waitedMs: action.milliseconds };
    }

    const target = ['-w', String(hwnd)];
    switch (action.type) {
      case 'invoke':
        return this.runJson(['ui', 'invoke', action.selector, ...target]);
      case 'set_value':
        return this.runJson(['ui', 'set-value', action.selector, action.value, ...target]);
      case 'click': {
        const args = ['ui', 'click', action.selector, ...target];
        if (action.double) args.push('--double');
        if (action.button === 'right') args.push('--right');
        return this.runJson(args);
      }
      case 'hover': {
        const args = ['ui', 'hover', action.selector, ...target];
        if (action.dwellMs !== undefined) args.push('--dwell-time', String(action.dwellMs));
        return this.runJson(args);
      }
      case 'scroll': {
        const args = ['ui', 'scroll'];
        if (action.selector) args.push(action.selector);
        args.push(...target);
        if (action.direction) args.push('--direction', action.direction);
        if (action.to) args.push('--to', action.to);
        if (action.wheel !== undefined) args.push('--wheel', String(action.wheel));
        return this.runJson(args);
      }
      case 'send_keys': {
        const args = ['ui', 'send-keys', action.keys, ...target, '--via', action.transport ?? 'send-input'];
        if (action.selector) args.push('--target', action.selector);
        if (action.verbatim) args.push('--verbatim');
        if (action.allowSystemKeys) args.push('--allow-system-keys');
        return this.runJson(args);
      }
      case 'drag': {
        const args = ['ui', 'drag', action.from, action.to, ...target];
        if (action.right) args.push('--right');
        if (action.holdMs !== undefined) args.push('--hold-ms', String(action.holdMs));
        if (action.dwellMs !== undefined) args.push('--dwell-ms', String(action.dwellMs));
        return this.runJson(args);
      }
    }
  }
}
