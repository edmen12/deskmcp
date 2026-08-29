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

const installedDesktopCommanderEntry = path.join(
  PROJECT_ROOT, 'node_modules', '@wonderwhy-er',
  'desktop-commander', 'dist', 'index.js'
);
export const DEFAULT_DESKTOP_COMMANDER_ENTRY = installedDesktopCommanderEntry;

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
      ?? DEFAULT_DESKTOP_COMMANDER_ENTRY
  ) {}

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
        ...getDefaultEnvironment(),
        DC_REMOTE_DEVICE: 'true'
      }
    });

    const client = new Client(
      { name: 'deskmcp-gateway', version: '0.9.1' },
      { versionNegotiation: { mode: 'legacy' } }
    );

    try {
      phaseStartedAt = performance.now();
      await client.connect(transport);
      const connectMs = elapsedMs(phaseStartedAt);
      phaseStartedAt = performance.now();
      const listed = await client.listTools();
      const listToolsMs = elapsedMs(phaseStartedAt);
      phaseStartedAt = performance.now();
      const required = ['read_file', 'list_directory', 'get_file_info', 'write_file', 'edit_block', 'create_directory', 'move_file', 'start_search', 'get_more_search_results', 'stop_search', 'start_process', 'read_process_output', 'interact_with_process', 'force_terminate'];
      for (const name of required) {
        if (!listed.tools.some(tool => tool.name === name)) {
          throw new Error(`Desktop Commander required tool unavailable: ${name}`);
        }
      }
      const validationMs = elapsedMs(phaseStartedAt);

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
      ready: this.client !== null,
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
    if (!this.client) throw new Error('Desktop Commander bridge is not started.');
    const result = await this.client.callTool({ name, arguments: args });
    const text = result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return {
      text: text || JSON.stringify(result.content),
      isError: result.isError === true
    };
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
    shell?: 'powershell.exe' | 'cmd.exe'
  ): Promise<DesktopCommanderToolResult> {
    return this.callTextTool('start_process', {
      command,
      timeout_ms: timeoutMs,
      ...(shell ? { shell } : {})
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

  async forceTerminateProcess(pid: number): Promise<DesktopCommanderToolResult> {
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
    if (client) await client.close();
  }
}
