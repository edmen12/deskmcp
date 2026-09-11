import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquirePidDirectoryLock, type PidDirectoryLockLease } from './cross-process-lock.js';

const REGISTRY_SCHEMA_VERSION = 1;
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_SERVERS = 64;
const MAX_TOOLS_PER_SERVER = 512;
const MAX_TOOL_NAME_BYTES = 512;
const MAX_TOOL_TITLE_BYTES = 2048;
const MAX_TOOL_DESCRIPTION_BYTES = 16 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 256 * 1024;
const MAX_TOOL_ANNOTATIONS_BYTES = 64 * 1024;
const MAX_TOOL_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_REFRESH_ALL_MS = 120_000;
const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const REGISTRY_LOCK_INITIALIZATION_GRACE_MS = 5_000;
const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const BLOCKED_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'mcp-protocol-version',
  'mcp-session-id',
  'transfer-encoding'
]);

export interface DynamicMcpToolSummary {
  readonly qualified_name: string;
  readonly server: string;
  readonly tool_name: string;
  readonly title?: string;
  readonly description?: string;
}

export interface DynamicMcpToolDefinition extends DynamicMcpToolSummary {
  readonly input_schema: unknown;
  readonly output_schema?: unknown;
  readonly annotations?: unknown;
}

export interface DynamicMcpServerConfig {
  readonly name: string;
  readonly description?: string;
  readonly transport: 'streamable_http';
  readonly url: string;
  readonly header_env: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly timeout_ms: number;
  readonly tools: readonly DynamicMcpToolDefinition[];
  readonly refreshed_at?: string;
  readonly server_info?: {
    readonly name: string;
    readonly version: string;
  };
}

interface RegistryFile {
  readonly schema_version: number;
  readonly servers: readonly DynamicMcpServerConfig[];
}

export interface AddDynamicMcpServerInput {
  readonly name: string;
  readonly description?: string;
  readonly url: string;
  readonly header_env?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
  readonly timeout_ms?: number;
}

export interface RefreshResult {
  readonly name: string;
  readonly ok: boolean;
  readonly tool_count?: number;
  readonly server_info?: DynamicMcpServerConfig['server_info'];
  readonly error?: string;
}

export interface DynamicMcpHubTestHooks {
  readonly beforePersistRefresh?: () => Promise<void> | void;
}

function sameRefreshTarget(left: DynamicMcpServerConfig, right: DynamicMcpServerConfig): boolean {
  if (left.url !== right.url || left.transport !== right.transport) return false;
  const leftHeaders = Object.entries(left.header_env).sort(([a], [b]) => a.localeCompare(b));
  const rightHeaders = Object.entries(right.header_env).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftHeaders) === JSON.stringify(rightHeaders);
}

function normalizeName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SERVER_NAME_PATTERN.test(normalized)) {
    throw new Error('Dynamic MCP server name must match [a-z0-9][a-z0-9_-]{0,63}.');
  }
  return normalized;
}

function normalizeDescription(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (Buffer.byteLength(normalized, 'utf8') > 1024) {
    throw new Error('Dynamic MCP description exceeds 1024 bytes.');
  }
  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

function normalizeUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.username || parsed.password) {
    throw new Error('Dynamic MCP URL must not contain embedded credentials.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new Error('Dynamic MCP remote URLs must use HTTPS; HTTP is allowed only for loopback servers.');
  }
  parsed.hash = '';
  return parsed.toString();
}

function normalizeTimeout(value: number | undefined): number {
  const selected = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(selected) || selected < 250 || selected > MAX_TIMEOUT_MS) {
    throw new Error(`Dynamic MCP timeout_ms must be between 250 and ${MAX_TIMEOUT_MS}.`);
  }
  return selected;
}

function normalizeHeaderEnv(value: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawHeader, rawEnv] of Object.entries(value ?? {})) {
    const header = rawHeader.trim();
    const envName = rawEnv.trim();
    if (!HEADER_NAME_PATTERN.test(header)) throw new Error(`Invalid HTTP header name: ${rawHeader}.`);
    if (BLOCKED_HEADERS.has(header.toLowerCase())) throw new Error(`DeskMCP reserves HTTP header: ${header}.`);
    if (!ENV_NAME_PATTERN.test(envName)) throw new Error(`Invalid environment variable name for ${header}.`);
    out[header] = envName;
  }
  return out;
}

function publicConfig(server: DynamicMcpServerConfig) {
  return {
    name: server.name,
    ...(server.description ? { description: server.description } : {}),
    transport: server.transport,
    url: server.url,
    header_env: { ...server.header_env },
    enabled: server.enabled,
    timeout_ms: server.timeout_ms,
    tool_count: server.tools.length,
    ...(server.refreshed_at ? { refreshed_at: server.refreshed_at } : {}),
    ...(server.server_info ? { server_info: { ...server.server_info } } : {})
  };
}

function boundedUtf8(value: unknown, label: string, maxBytes: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== 'string' || (required && value.length === 0) || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${label} is invalid or exceeds ${maxBytes} bytes.`);
  }
  return value;
}

function assertJsonSize(value: unknown, label: string, maxBytes: number): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error(`${label} is not JSON serializable.`); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  }
}

function validateToolDefinition(serverName: string, raw: unknown): DynamicMcpToolDefinition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Dynamic MCP tool entry for ${serverName} is invalid.`);
  const tool = raw as Partial<DynamicMcpToolDefinition>;
  const toolName = boundedUtf8(tool.tool_name, `Dynamic MCP tool name for ${serverName}`, MAX_TOOL_NAME_BYTES, true)!;
  const qualifiedName = boundedUtf8(tool.qualified_name, `Dynamic MCP qualified tool name for ${serverName}`, MAX_TOOL_NAME_BYTES + 65, true)!;
  if (qualifiedName !== `${serverName}:${toolName}` || tool.server !== serverName) {
    throw new Error(`Dynamic MCP cached tool identity mismatch for ${serverName}:${toolName}.`);
  }
  const title = boundedUtf8(tool.title, `Dynamic MCP tool title for ${serverName}:${toolName}`, MAX_TOOL_TITLE_BYTES);
  const description = boundedUtf8(tool.description, `Dynamic MCP tool description for ${serverName}:${toolName}`, MAX_TOOL_DESCRIPTION_BYTES);
  assertJsonSize(tool.input_schema, `Dynamic MCP input schema for ${serverName}:${toolName}`, MAX_TOOL_SCHEMA_BYTES);
  if (tool.output_schema !== undefined) assertJsonSize(tool.output_schema, `Dynamic MCP output schema for ${serverName}:${toolName}`, MAX_TOOL_SCHEMA_BYTES);
  if (tool.annotations !== undefined) assertJsonSize(tool.annotations, `Dynamic MCP annotations for ${serverName}:${toolName}`, MAX_TOOL_ANNOTATIONS_BYTES);
  return {
    qualified_name: qualifiedName,
    server: serverName,
    tool_name: toolName,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    input_schema: tool.input_schema,
    ...(tool.output_schema !== undefined ? { output_schema: tool.output_schema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {})
  };
}

function toolToDefinition(serverName: string, tool: Tool): DynamicMcpToolDefinition {
  const definition = {
    qualified_name: `${serverName}:${tool.name}`,
    server: serverName,
    tool_name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { output_schema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {})
  } satisfies DynamicMcpToolDefinition;
  return validateToolDefinition(serverName, definition);
}

function parseRegistry(value: unknown): RegistryFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Dynamic MCP registry is invalid.');
  }
  const candidate = value as Partial<RegistryFile>;
  if (candidate.schema_version !== REGISTRY_SCHEMA_VERSION || !Array.isArray(candidate.servers)) {
    throw new Error(`Unsupported Dynamic MCP registry schema: ${String(candidate.schema_version)}.`);
  }
  if (candidate.servers.length > MAX_SERVERS) throw new Error(`Dynamic MCP registry exceeds ${MAX_SERVERS} servers.`);
  const servers = candidate.servers.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('Dynamic MCP server entry is invalid.');
    const entry = raw as Partial<DynamicMcpServerConfig>;
    if (typeof entry.name !== 'string' || typeof entry.url !== 'string') {
      throw new Error('Dynamic MCP server entry is missing name or URL.');
    }
    const name = normalizeName(entry.name);
    const description = normalizeDescription(entry.description);
    const url = normalizeUrl(entry.url);
    const headerEnv = normalizeHeaderEnv(entry.header_env);
    const timeout = normalizeTimeout(entry.timeout_ms);
    const enabled = entry.enabled !== false;
    const rawTools = Array.isArray(entry.tools) ? entry.tools : [];
    if (rawTools.length > MAX_TOOLS_PER_SERVER) {
      throw new Error(`Dynamic MCP server ${name} exceeds ${MAX_TOOLS_PER_SERVER} cached tools.`);
    }
    const tools = rawTools.map(tool => validateToolDefinition(name, tool));
    let serverInfo: DynamicMcpServerConfig['server_info'];
    if (entry.server_info !== undefined) {
      if (!entry.server_info || typeof entry.server_info !== 'object') throw new Error(`Dynamic MCP server_info for ${name} is invalid.`);
      const infoName = boundedUtf8(entry.server_info.name, `Dynamic MCP server_info name for ${name}`, 512, true)!;
      const infoVersion = boundedUtf8(entry.server_info.version, `Dynamic MCP server_info version for ${name}`, 512, true)!;
      serverInfo = { name: infoName, version: infoVersion };
    }
    const refreshedAt = entry.refreshed_at === undefined
      ? undefined
      : boundedUtf8(entry.refreshed_at, `Dynamic MCP refreshed_at for ${name}`, 128, true);
    return {
      name,
      ...(description ? { description } : {}),
      transport: 'streamable_http' as const,
      url,
      header_env: headerEnv,
      enabled,
      timeout_ms: timeout,
      tools,
      ...(refreshedAt ? { refreshed_at: refreshedAt } : {}),
      ...(serverInfo ? { server_info: serverInfo } : {})
    } satisfies DynamicMcpServerConfig;
  });
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) throw new Error(`Duplicate Dynamic MCP server: ${server.name}.`);
    names.add(server.name);
  }
  return { schema_version: REGISTRY_SCHEMA_VERSION, servers };
}

function qualifiedParts(value: string): { server: string; tool: string } {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('Dynamic MCP tool name must use <server>:<tool> format.');
  }
  return {
    server: normalizeName(value.slice(0, separator)),
    tool: value.slice(separator + 1)
  };
}

function timeoutPromise<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
    timer.unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export class DynamicMcpHub {
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly testHooks: DynamicMcpHubTestHooks = {}
  ) {}

  private get registryPath(): string {
    return path.join(this.root, 'servers.json');
  }

  private get registryLockPath(): string {
    return path.join(this.root, '.servers.lock');
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await this.load();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.serializeMutation(async () => {
        try { await this.load(); }
        catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code !== 'ENOENT') throw retryError;
          await this.save({ schema_version: REGISTRY_SCHEMA_VERSION, servers: [] });
        }
      });
    }
  }

  private async acquireRegistryLock(): Promise<PidDirectoryLockLease> {
    return acquirePidDirectoryLock(this.registryLockPath, {
      label: 'Dynamic MCP registry',
      timeoutMs: REGISTRY_LOCK_TIMEOUT_MS,
      initializationGraceMs: REGISTRY_LOCK_INITIALIZATION_GRACE_MS
    });
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>(resolve => { release = resolve; });
    await previous;
    let lock: PidDirectoryLockLease | undefined;
    try {
      lock = await this.acquireRegistryLock();
      return await operation();
    } finally {
      try {
        if (lock) await lock.release();
      } finally {
        release();
      }
    }
  }

  private async load(): Promise<RegistryFile> {
    const text = await readFile(this.registryPath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_BYTES) {
      throw new Error('Dynamic MCP registry exceeds size limit.');
    }
    return parseRegistry(JSON.parse(text) as unknown);
  }

  private async save(registry: RegistryFile): Promise<void> {
    const payload = `${JSON.stringify(registry, null, 2)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > MAX_REGISTRY_BYTES) {
      throw new Error('Dynamic MCP registry exceeds size limit.');
    }
    const temp = path.join(this.root, `.servers.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temp, this.registryPath);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['EACCES', 'EPERM', 'EBUSY'].includes(code ?? '') || attempt >= 5) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(25 * (2 ** attempt), 400)));
        }
      }
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async listServers(): Promise<unknown[]> {
    const registry = await this.load();
    return registry.servers.map(publicConfig);
  }

  async inspectServer(name: string): Promise<unknown> {
    const server = await this.requireServer(name);
    return {
      ...publicConfig(server),
      tools: server.tools.map(tool => ({
        qualified_name: tool.qualified_name,
        tool_name: tool.tool_name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {})
      }))
    };
  }

  async addServer(input: AddDynamicMcpServerInput): Promise<unknown> {
    return this.serializeMutation(async () => {
      const registry = await this.load();
      const name = normalizeName(input.name);
      if (registry.servers.some(server => server.name === name)) {
        throw new Error(`Dynamic MCP server already exists: ${name}.`);
      }
      if (registry.servers.length >= MAX_SERVERS) {
        throw new Error(`Dynamic MCP registry is limited to ${MAX_SERVERS} servers.`);
      }
      const description = normalizeDescription(input.description);
      const server: DynamicMcpServerConfig = {
        name,
        ...(description ? { description } : {}),
        transport: 'streamable_http',
        url: normalizeUrl(input.url),
        header_env: normalizeHeaderEnv(input.header_env),
        enabled: input.enabled !== false,
        timeout_ms: normalizeTimeout(input.timeout_ms),
        tools: []
      };
      await this.save({ ...registry, servers: [...registry.servers, server] });
      return publicConfig(server);
    });
  }

  async removeServer(name: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      const registry = await this.load();
      const normalized = normalizeName(name);
      const next = registry.servers.filter(server => server.name !== normalized);
      if (next.length === registry.servers.length) return false;
      await this.save({ ...registry, servers: next });
      return true;
    });
  }

  async setEnabled(name: string, enabled: boolean): Promise<unknown> {
    return this.serializeMutation(async () => {
      const registry = await this.load();
      const normalized = normalizeName(name);
      const index = registry.servers.findIndex(server => server.name === normalized);
      if (index < 0) throw new Error(`Dynamic MCP server not found: ${normalized}.`);
      const current = registry.servers[index]!;
      const updated: DynamicMcpServerConfig = { ...current, enabled };
      const servers = [...registry.servers];
      servers[index] = updated;
      await this.save({ ...registry, servers });
      return publicConfig(updated);
    });
  }

  private async requireServer(name: string): Promise<DynamicMcpServerConfig> {
    const normalized = normalizeName(name);
    const registry = await this.load();
    const server = registry.servers.find(item => item.name === normalized);
    if (!server) throw new Error(`Dynamic MCP server not found: ${normalized}.`);
    return server;
  }

  private requestHeaders(server: DynamicMcpServerConfig): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [header, envName] of Object.entries(server.header_env)) {
      const value = process.env[envName];
      if (!value) throw new Error(`Required environment variable is not configured: ${envName}.`);
      headers[header] = value;
    }
    return headers;
  }

  private async withClient<T>(
    server: DynamicMcpServerConfig,
    operation: (client: Client) => Promise<T>,
    totalTimeoutMs = server.timeout_ms
  ): Promise<T> {
    if (!server.enabled) throw new Error(`Dynamic MCP server is disabled: ${server.name}.`);
    const budgetMs = Math.max(1, Math.min(server.timeout_ms, totalTimeoutMs));
    const deadline = Date.now() + budgetMs;
    const remaining = (label: string): number => {
      const value = deadline - Date.now();
      if (value <= 0) throw new Error(`${label} exceeded the ${budgetMs} ms total timeout budget.`);
      return value;
    };
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: this.requestHeaders(server) }
    });
    const client = new Client({ name: 'deskmcp-mcp-hub', version: '0.9.10' });
    let connected = false;
    try {
      await timeoutPromise(client.connect(transport), remaining(`Connect to ${server.name}`), `Connect to ${server.name}`);
      connected = true;
      return await timeoutPromise(operation(client), remaining(`MCP operation on ${server.name}`), `MCP operation on ${server.name}`);
    } finally {
      if (connected) await client.close().catch(() => undefined);
      else await transport.close().catch(() => undefined);
    }
  }

  async refresh(name?: string): Promise<RefreshResult[]> {
    const registry = await this.load();
    const normalized = name ? normalizeName(name) : undefined;
    const targets = normalized
      ? registry.servers.filter(server => server.name === normalized)
      : registry.servers.filter(server => server.enabled);
    if (normalized && targets.length === 0) throw new Error(`Dynamic MCP server not found: ${normalized}.`);

    const results: RefreshResult[] = [];
    const targetConfigs = new Map(targets.map(server => [server.name, server] as const));
    const updates = new Map<string, {
      tools: readonly DynamicMcpToolDefinition[];
      refreshed_at: string;
      server_info?: DynamicMcpServerConfig['server_info'];
    }>();
    const batchDeadline = normalized ? undefined : Date.now() + MAX_REFRESH_ALL_MS;
    for (let index = 0; index < targets.length; index++) {
      const server = targets[index]!;
      if (batchDeadline !== undefined && Date.now() >= batchDeadline) {
        for (const remaining of targets.slice(index)) {
          results.push({ name: remaining.name, ok: false, error: `Batch refresh exceeded ${MAX_REFRESH_ALL_MS} ms total deadline.` });
        }
        break;
      }
      try {
        const remainingBatchMs = batchDeadline === undefined ? server.timeout_ms : Math.max(1, batchDeadline - Date.now());
        const discovered = await this.withClient(server, async client => {
          const listed = await client.listTools(undefined, { cacheMode: 'refresh' });
          if (listed.tools.length > MAX_TOOLS_PER_SERVER) {
            throw new Error(`Dynamic MCP server ${server.name} exposed more than ${MAX_TOOLS_PER_SERVER} tools.`);
          }
          const serverInfo = client.getServerVersion();
          let validatedServerInfo: DynamicMcpServerConfig['server_info'];
          if (serverInfo) {
            validatedServerInfo = {
              name: boundedUtf8(serverInfo.name, `Dynamic MCP server name for ${server.name}`, 512, true)!,
              version: boundedUtf8(serverInfo.version, `Dynamic MCP server version for ${server.name}`, 512, true)!
            };
          }
          return {
            tools: listed.tools.map(tool => toolToDefinition(server.name, tool)),
            ...(validatedServerInfo ? { serverInfo: validatedServerInfo } : {})
          };
        }, Math.min(server.timeout_ms, remainingBatchMs));
        const discoveryUpdate = {
          tools: discovered.tools,
          refreshed_at: new Date().toISOString(),
          ...(discovered.serverInfo ? { server_info: discovered.serverInfo } : {})
        };
        updates.set(server.name, discoveryUpdate);
        results.push({
          name: server.name,
          ok: true,
          tool_count: discoveryUpdate.tools.length,
          ...(discoveryUpdate.server_info ? { server_info: discoveryUpdate.server_info } : {})
        });
      } catch (error) {
        results.push({
          name: server.name,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (updates.size > 0) {
      await this.testHooks.beforePersistRefresh?.();
      const staleResults = new Set<string>();
      await this.serializeMutation(async () => {
        const latest = await this.load();
        const latestByName = new Map(latest.servers.map(server => [server.name, server] as const));
        for (const serverName of updates.keys()) {
          const expected = targetConfigs.get(serverName);
          const current = latestByName.get(serverName);
          if (!expected || !current || !sameRefreshTarget(expected, current)) staleResults.add(serverName);
        }
        if (staleResults.size === updates.size) return;
        const servers = latest.servers.map(server => {
          const discovery = updates.get(server.name);
          if (!discovery || staleResults.has(server.name)) return server;
          return discovery.server_info
            ? {
                ...server,
                tools: discovery.tools,
                refreshed_at: discovery.refreshed_at,
                server_info: discovery.server_info
              }
            : {
                ...server,
                tools: discovery.tools,
                refreshed_at: discovery.refreshed_at
              };
        });
        await this.save({ ...latest, servers });
      });
      for (let index = 0; index < results.length; index++) {
        const result = results[index]!;
        if (!staleResults.has(result.name) || !result.ok) continue;
        results[index] = {
          name: result.name,
          ok: false,
          error: 'Dynamic MCP server configuration changed while refresh was in progress; stale discovery was not persisted.'
        };
      }
    }
    return results;
  }

  async searchTools(query: string, serverName?: string, limit = 10): Promise<DynamicMcpToolSummary[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) throw new Error('Dynamic MCP tool search query is required.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Dynamic MCP search limit must be between 1 and 100.');
    const serverFilter = serverName ? normalizeName(serverName) : undefined;
    const registry = await this.load();
    const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
    const scored: Array<{ score: number; tool: DynamicMcpToolSummary }> = [];
    for (const server of registry.servers) {
      if (!server.enabled || (serverFilter && server.name !== serverFilter)) continue;
      for (const tool of server.tools) {
        const haystack = `${tool.qualified_name} ${tool.title ?? ''} ${tool.description ?? ''}`.toLowerCase();
        if (!tokens.every(token => haystack.includes(token))) continue;
        const score = tokens.reduce((total, token) => {
          if (tool.tool_name.toLowerCase() === token) return total + 100;
          if (tool.tool_name.toLowerCase().includes(token)) return total + 20;
          if (tool.title?.toLowerCase().includes(token)) return total + 10;
          return total + 1;
        }, 0);
        scored.push({
          score,
          tool: {
            qualified_name: tool.qualified_name,
            server: tool.server,
            tool_name: tool.tool_name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {})
          }
        });
      }
    }
    scored.sort((left, right) => right.score - left.score || left.tool.qualified_name.localeCompare(right.tool.qualified_name));
    return scored.slice(0, limit).map(item => item.tool);
  }

  async inspectTool(qualifiedName: string): Promise<DynamicMcpToolDefinition> {
    const parts = qualifiedParts(qualifiedName);
    const server = await this.requireServer(parts.server);
    const tool = server.tools.find(item => item.tool_name === parts.tool);
    if (!tool) throw new Error(`Dynamic MCP tool not found in cached registry: ${qualifiedName}. Run refresh first.`);
    return structuredClone(tool);
  }

  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<unknown> {
    const parts = qualifiedParts(qualifiedName);
    const server = await this.requireServer(parts.server);
    return this.withClient(server, async client => {
      const listed = await client.listTools(undefined, { cacheMode: 'refresh' });
      if (listed.tools.length > MAX_TOOLS_PER_SERVER) {
        throw new Error(`Dynamic MCP server ${server.name} exposed more than ${MAX_TOOLS_PER_SERVER} tools.`);
      }
      const tool = listed.tools.find(item => item.name === parts.tool);
      if (!tool) throw new Error(`Dynamic MCP tool no longer exists: ${qualifiedName}.`);
      toolToDefinition(server.name, tool);
      const result = await client.callTool(
        { name: tool.name, arguments: args },
        { toolDefinition: tool }
      );
      assertJsonSize(result, `Dynamic MCP tool result for ${qualifiedName}`, MAX_TOOL_RESULT_BYTES);
      return {
        name: `${server.name}:${tool.name}`,
        result
      };
    });
  }
}
