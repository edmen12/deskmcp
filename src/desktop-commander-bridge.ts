import { access } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/client';
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/client/stdio';
import { PROJECT_ROOT } from './paths.js';

export interface DesktopCommanderStartupTiming {
  readonly accessMs: number;
  readonly connectMs: number;
  readonly listToolsMs: number;
  readonly validationMs: number;
  readonly totalMs: number;
}

export interface DesktopCommanderInfo {
  readonly ready: boolean;
  readonly entry: string;
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly toolCount: number;
  readonly startupTiming?: DesktopCommanderStartupTiming;
}

export interface DesktopCommanderToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export type ProcessShell =
  | 'auto'
  | 'cmd'
  | 'cmd.exe'
  | 'powershell'
  | 'powershell.exe'
  | 'bash'
  | 'zsh'
  | 'sh'
  | 'fish';

type WindowsProcessShell = 'cmd.exe' | 'powershell.exe';
type PosixProcessShell = 'auto' | 'bash' | 'zsh' | 'sh' | 'fish';

export function buildDarwinPath(
  inheritedPath = '',
  home = process.env.HOME ?? ''
): string {
  const delimiter = ':';
  const preferred = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    ...(home ? [
      path.posix.join(home, '.local', 'bin'),
      path.posix.join(home, 'bin'),
      path.posix.join(home, '.cargo', 'bin'),
      path.posix.join(home, '.bun', 'bin')
    ] : []),
    ...inheritedPath.split(delimiter),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].filter(Boolean);
  return [...new Set(preferred)].join(delimiter);
}

export function buildDesktopCommanderEnvironment(
  baseEnvironment: Record<string, string> = getDefaultEnvironment(),
  platform = process.platform
): Record<string, string> {
  if (platform !== 'darwin') return { ...baseEnvironment };
  const environment = { ...baseEnvironment };
  environment.PATH = buildDarwinPath(
    environment.PATH ?? process.env.PATH ?? '',
    environment.HOME ?? process.env.HOME ?? ''
  );
  if (!environment.SHELL) environment.SHELL = process.env.SHELL ?? '/bin/zsh';
  return environment;
}

const installedDesktopCommanderEntry = path.join(
  PROJECT_ROOT, 'node_modules', '@wonderwhy-er',
  'desktop-commander', 'dist', 'index.js'
);
export const DEFAULT_DESKTOP_COMMANDER_ENTRY = installedDesktopCommanderEntry;

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

const defaultPosixProcessHostEntry = path.basename(PROJECT_ROOT).toLowerCase() === 'gateway'
  ? path.resolve(PROJECT_ROOT, '..', 'process-host', 'bin', 'DeskMCPProcessHost')
  : path.join(
      PROJECT_ROOT,
      'runtime',
      'process-host',
      process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64',
      'DeskMCPProcessHost'
    );
export const DEFAULT_POSIX_PROCESS_HOST_ENTRY = defaultPosixProcessHostEntry;

function normalizeWindowsShell(shell: ProcessShell): WindowsProcessShell {
  switch (shell) {
    case 'auto':
    case 'cmd':
    case 'cmd.exe':
      return 'cmd.exe';
    case 'powershell':
    case 'powershell.exe':
      return 'powershell.exe';
    default:
      throw new Error(`Shell '${shell}' is not supported by the Windows ProcessHost.`);
  }
}

function normalizePosixShell(shell: ProcessShell): PosixProcessShell {
  switch (shell) {
    case 'auto':
    case 'bash':
    case 'zsh':
    case 'sh':
    case 'fish':
      return shell;
    default:
      throw new Error(`Shell '${shell}' is not supported on macOS.`);
  }
}

function posixProcessHostShellEntry(
  processHostEntry: string,
  shell: PosixProcessShell
): string {
  return `${processHostEntry}-${shell}`;
}

function shellDisplayName(shell: PosixProcessShell): string {
  return shell === 'auto' ? 'system shell' : shell;
}

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildProcessHostCommand(
  processHostEntry: string,
  shell: 'powershell.exe' | 'cmd.exe',
  command: string,
  windowMode: 'hidden' | 'visible' = 'hidden',
  elevation: 'standard' | 'admin' = 'standard'
): string {
  const command64 = Buffer.from(command, 'utf8').toString('base64');
  return `"${processHostEntry}" --shell ${shell} --command64 ${command64} --window-mode ${windowMode} --elevation ${elevation}`;
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export class DesktopCommanderBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private startPromise: Promise<void> | null = null;
  private toolCount = 0;
  private serverName: string | undefined;
  private serverVersion: string | undefined;
  private startupTiming: DesktopCommanderStartupTiming | undefined;

  constructor(
    readonly entry = process.env.DESKTOP_COMMANDER_ENTRY
      ?? DEFAULT_DESKTOP_COMMANDER_ENTRY,
    readonly processHostEntry = process.env.DESKTOP_MCP_PROCESS_HOST
      ?? DEFAULT_PROCESS_HOST_ENTRY,
    readonly posixProcessHostEntry = process.env.DESKTOP_MCP_POSIX_PROCESS_HOST
      ?? DEFAULT_POSIX_PROCESS_HOST_ENTRY
  ) {}

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

  async start(): Promise<void> {
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
        ...buildDesktopCommanderEnvironment(),
        DC_REMOTE_DEVICE: 'true'
      }
    });

    const client = new Client(
      { name: 'deskmcp-gateway', version: '0.9.4' },
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
      const required = ['read_file', 'list_directory', 'get_file_info', 'write_file', 'edit_block', 'create_directory', 'move_file', 'start_search', 'get_more_search_results', 'stop_search', 'start_process', 'read_process_output', 'interact_with_process', 'list_sessions', 'force_terminate'];
      for (const name of required) {
        if (!listed.tools.some(tool => tool.name === name)) {
          throw new Error(`Desktop Commander required tool unavailable: ${name}`);
        }
      }
      const validationMs = elapsedMs(phaseStartedAt);
      if (closed) throw new Error('Desktop Commander transport closed during startup.');

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
  info(): DesktopCommanderInfo {
    return {
      ready: this.client !== null && this.transport !== null,
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
  ): Promise<DesktopCommanderToolResult> {
    await this.start();
    const client = this.client;
    const transport = this.transport;
    if (!client || !transport) throw new Error('Desktop Commander bridge is not started.');
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

  async readFile(filePath: string, offset = 0, length = 1000): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('read_file', {
      path: filePath,
      isUrl: false,
      offset,
      length
    });
  }
  async listDirectory(directoryPath: string, depth = 2): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('list_directory', {
      path: directoryPath,
      depth
    });
  }

  async getFileInfo(filePath: string): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('get_file_info', { path: filePath });
  }

  async writeFile(
    filePath: string,
    content: string,
    mode: 'rewrite' | 'append'
  ): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('write_file', {
      path: filePath,
      content,
      mode
    });
  }

  async editTextFile(
    filePath: string,
    oldString: string,
    newString: string,
    expectedReplacements = 1
  ): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('edit_block', {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      expected_replacements: expectedReplacements
    });
  }
  async createDirectory(directoryPath: string): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('create_directory', { path: directoryPath });
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('move_file', {
      source: sourcePath,
      destination: destinationPath
    });
  }
  async startSearch(args: Record<string, unknown>): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('start_search', args);
  }

  async getSearchResults(
    sessionId: string,
    offset: number,
    length: number
  ): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('get_more_search_results', { sessionId, offset, length });
  }

  async stopSearch(sessionId: string): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('stop_search', { sessionId });
  }

  async startProcess(
    command: string,
    timeoutMs: number,
    shell: ProcessShell = 'auto',
    windowMode: 'hidden' | 'visible' = 'hidden',
    elevation: 'standard' | 'admin' = 'standard'
  ): Promise<DesktopCommanderToolResult> {
    if (process.platform === 'win32') {
      await access(this.processHostEntry);
      const ownedCommand = buildProcessHostCommand(
        this.processHostEntry,
        normalizeWindowsShell(shell),
        command,
        windowMode,
        elevation
      );
      return this.callTextTool('start_process', {
        command: ownedCommand,
        timeout_ms: timeoutMs,
        shell: 'cmd.exe'
      });
    }

    const posixShell = normalizePosixShell(shell);
    if (process.platform === 'darwin') {
      if (windowMode !== 'hidden' || elevation !== 'standard') {
        throw new Error('Visible console and privilege elevation modes are not available on macOS yet.');
      }
      const shellEntry = posixProcessHostShellEntry(this.posixProcessHostEntry, posixShell);
      await access(shellEntry);
      const result = await this.callTextTool('start_process', {
        command,
        timeout_ms: timeoutMs,
        shell: shellEntry
      });
      return {
        ...result,
        text: result.text.split(shellEntry).join(shellDisplayName(posixShell))
      };
    }

    return this.callTextTool('start_process', {
      command,
      timeout_ms: timeoutMs,
      ...(posixShell === 'auto' ? {} : { shell: posixShell })
    });
  }

  async readProcessOutput(
    pid: number,
    timeoutMs: number,
    offset: number,
    length: number
  ): Promise<DesktopCommanderToolResult> {
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
  ): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('interact_with_process', {
      pid,
      input,
      timeout_ms: timeoutMs,
      wait_for_prompt: waitForPrompt
    });
  }

  async listProcessSessions(): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('list_sessions', {});
  }

  async forceTerminateProcess(pid: number): Promise<DesktopCommanderToolResult> {
    if (process.platform !== 'darwin') {
      return this.callTextTool('force_terminate', { pid });
    }

    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (isMissingProcess(error)) {
        return { text: 'Owned macOS process group already exited.', isError: false };
      }
      throw error;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(50);
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (isMissingProcess(error)) {
          return { text: 'Owned macOS process group terminated.', isError: false };
        }
        throw error;
      }
    }

    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
    return { text: 'Owned macOS process group force-terminated.', isError: false };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.toolCount = 0;
    this.serverName = undefined;
    this.serverVersion = undefined;
    this.startupTiming = undefined;
    if (client) await client.close();
  }
}
