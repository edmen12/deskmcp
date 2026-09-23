import { access } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/client';
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/client/stdio';
import {
  createNativeDirectory,
  editNativeTextFile,
  getNativeFileInfo,
  listNativeDirectory,
  moveNativeFile,
  readNativeTextFile,
  writeNativeFile
} from './native-file-backend.js';
import { NativeWindowsProcessBackend } from './native-process-backend.js';
import { PROJECT_ROOT } from './paths.js';

export interface DesktopBackendStartupTiming {
  readonly accessMs: number;
  readonly connectMs: number;
  readonly listToolsMs: number;
  readonly validationMs: number;
  readonly totalMs: number;
}

export interface DesktopBackendInfo {
  readonly ready: boolean;
  readonly backendConnected: boolean;
  readonly entry: string;
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly toolCount: number;
  readonly startupTiming?: DesktopBackendStartupTiming;
}

export interface DesktopBackendToolResult {
  readonly text: string;
  readonly isError: boolean;
}

const installedDesktopBackendEntry = path.join(
  PROJECT_ROOT, 'node_modules', '@wonderwhy-er',
  'desktop-commander', 'dist', 'index.js'
);
export const DEFAULT_DESKMCP_BACKEND_ENTRY = installedDesktopBackendEntry;

const defaultProcessHostEntry = path.basename(PROJECT_ROOT).toLowerCase() === 'gateway'
  ? path.resolve(PROJECT_ROOT, '..', 'DeskMCP.ProcessHost.exe')
  : path.join(
      PROJECT_ROOT,
      'runtime',
      'process-host',
      process.arch === 'arm64' ? 'win-arm64' : 'win-x64',
      'DeskMCP.ProcessHost.exe'
    );
export const DEFAULT_PROCESS_HOST_ENTRY = defaultProcessHostEntry;

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export class DesktopBackendBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private startPromise: Promise<void> | null = null;
  private available = false;
  private toolCount = 0;
  private serverName: string | undefined;
  private serverVersion: string | undefined;
  private startupTiming: DesktopBackendStartupTiming | undefined;
  private readonly nativeProcesses: NativeWindowsProcessBackend | undefined;

  constructor(
    readonly entry = process.env.DESKMCP_BACKEND_ENTRY
      ?? DEFAULT_DESKMCP_BACKEND_ENTRY,
    readonly processHostEntry = process.env.DESKTOP_MCP_PROCESS_HOST
      ?? DEFAULT_PROCESS_HOST_ENTRY
  ) {
    this.nativeProcesses = process.platform === 'win32'
      ? new NativeWindowsProcessBackend(this.processHostEntry)
      : undefined;
  }

  private invalidateConnection(
    client: Client,
    transport: StdioClientTransport
  ): void {
    if (this.client !== client || this.transport !== transport) return;
    this.client = null;
    this.transport = null;
    this.toolCount = 0;
    this.serverName = undefined;
    this.serverVersion = undefined;
    this.startupTiming = undefined;
  }

  async preflight(): Promise<void> {
    if (process.platform === 'win32') await access(this.processHostEntry);
    else await access(this.entry);
    this.available = true;
  }

  async start(): Promise<void> {
    if (!this.available) await this.preflight();
    if (this.client) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    const totalStartedAt = performance.now();
    let phaseStartedAt = performance.now();
    await access(this.entry);
    const accessMs = elapsedMs(phaseStartedAt);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.entry, '--no-onboarding'],
      cwd: path.dirname(this.entry),
      stderr: 'pipe',
      env: {
        ...getDefaultEnvironment(),
        DC_REMOTE_DEVICE: 'true'
      }
    });

    const client = new Client(
      { name: 'deskmcp-gateway', version: '0.9.16' },
      { versionNegotiation: { mode: 'legacy' } }
    );
    let closed = false;
    transport.onclose = () => {
      closed = true;
      this.invalidateConnection(client, transport);
    };

    try {
      phaseStartedAt = performance.now();
      await client.connect(transport);
      const connectMs = elapsedMs(phaseStartedAt);
      phaseStartedAt = performance.now();
      const listed = await client.listTools();
      const listToolsMs = elapsedMs(phaseStartedAt);
      phaseStartedAt = performance.now();
      const required = process.platform === 'win32'
        ? ['read_file']
        : ['read_file', 'start_process', 'read_process_output', 'interact_with_process', 'list_sessions', 'force_terminate'];
      for (const name of required) {
        if (!listed.tools.some(tool => tool.name === name)) {
          throw new Error(`DeskMCP backend required tool unavailable: ${name}`);
        }
      }
      const validationMs = elapsedMs(phaseStartedAt);
      if (closed) throw new Error('DeskMCP backend transport closed during startup.');

      const version = client.getServerVersion();
      this.toolCount = listed.tools.length;
      this.serverName = version?.name;
      this.serverVersion = version?.version;
      this.startupTiming = {
        accessMs,
        connectMs,
        listToolsMs,
        validationMs,
        totalMs: elapsedMs(totalStartedAt)
      };
      this.transport = transport;
      this.client = client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
  info(): DesktopBackendInfo {
    return {
      ready: this.available,
      backendConnected: this.client !== null && this.transport !== null,
      entry: this.entry,
      ...(this.serverName ? { serverName: this.serverName } : {}),
      ...(this.serverVersion ? { serverVersion: this.serverVersion } : {}),
      toolCount: this.toolCount,
      ...(this.startupTiming ? { startupTiming: { ...this.startupTiming } } : {})
    };
  }

  private async callTextTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<DesktopBackendToolResult> {
    await this.start();
    const client = this.client;
    const transport = this.transport;
    if (!client || !transport) throw new Error('DeskMCP backend bridge is not started.');
    try {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      return {
        text: text || JSON.stringify(result.content),
        isError: result.isError === true
      };
    } catch (error) {
      this.invalidateConnection(client, transport);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async readFile(filePath: string, offset = 0, length = 1000): Promise<DesktopBackendToolResult> {
    const native = await readNativeTextFile(filePath, offset, length);
    if (native) return native;
    return this.callTextTool('read_file', {
      path: filePath,
      isUrl: false,
      offset,
      length
    });
  }

  async listDirectory(directoryPath: string, depth = 2): Promise<DesktopBackendToolResult> {
    return listNativeDirectory(directoryPath, depth);
  }

  async getFileInfo(filePath: string): Promise<DesktopBackendToolResult> {
    return getNativeFileInfo(filePath);
  }

  async writeFile(
    filePath: string,
    content: string,
    mode: 'rewrite' | 'append'
  ): Promise<DesktopBackendToolResult> {
    return writeNativeFile(filePath, content, mode);
  }

  async editTextFile(
    filePath: string,
    oldString: string,
    newString: string,
    expectedReplacements = 1
  ): Promise<DesktopBackendToolResult> {
    return editNativeTextFile(filePath, oldString, newString, expectedReplacements);
  }

  async createDirectory(directoryPath: string): Promise<DesktopBackendToolResult> {
    return createNativeDirectory(directoryPath);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<DesktopBackendToolResult> {
    return moveNativeFile(sourcePath, destinationPath);
  }
  async startProcess(
    command: string,
    timeoutMs: number,
    shell?: 'powershell.exe' | 'cmd.exe',
    windowMode: 'hidden' | 'visible' = 'hidden',
    elevation: 'standard' | 'admin' = 'standard',
    lifetime: 'root' | 'job' = 'root',
    workingDirectory?: string,
    tempDirectory?: string
  ): Promise<DesktopBackendToolResult> {
    if (process.platform !== 'win32') {
      return this.callTextTool('start_process', {
        command,
        timeout_ms: timeoutMs,
        ...(shell ? { shell } : {}),
        ...(windowMode === 'visible' ? { window_mode: windowMode } : {}),
        ...(elevation === 'admin' ? { elevation } : {})
      });
    }

    await access(this.processHostEntry);
    return this.nativeProcesses!.start(
      command,
      timeoutMs,
      shell ?? 'cmd.exe',
      windowMode,
      elevation,
      lifetime,
      workingDirectory,
      tempDirectory
    );
  }

  async readProcessOutput(
    pid: number,
    timeoutMs: number,
    offset: number,
    length: number
  ): Promise<DesktopBackendToolResult> {
    if (this.nativeProcesses) {
      return this.nativeProcesses.read(pid, timeoutMs, offset, length);
    }
    return this.callTextTool('read_process_output', {
      pid,
      timeout_ms: timeoutMs,
      offset,
      length
    });
  }

  async interactWithProcess(
    pid: number,
    input: string,
    timeoutMs: number,
    waitForPrompt: boolean
  ): Promise<DesktopBackendToolResult> {
    if (this.nativeProcesses) {
      return this.nativeProcesses.interact(pid, input, timeoutMs, waitForPrompt);
    }
    return this.callTextTool('interact_with_process', {
      pid,
      input,
      timeout_ms: timeoutMs,
      wait_for_prompt: waitForPrompt
    });
  }

  async listProcessSessions(): Promise<DesktopBackendToolResult> {
    if (this.nativeProcesses) return this.nativeProcesses.list();
    return this.callTextTool('list_sessions', {});
  }

  async forceTerminateProcess(pid: number): Promise<DesktopBackendToolResult> {
    if (this.nativeProcesses) return this.nativeProcesses.terminate(pid);
    return this.callTextTool('force_terminate', { pid });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.toolCount = 0;
    this.serverName = undefined;
    this.serverVersion = undefined;
    this.startupTiming = undefined;
    await this.nativeProcesses?.close();
    if (client) await client.close();
  }
}
