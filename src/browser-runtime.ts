import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  rm,
  stat
} from 'node:fs/promises';
import path from 'node:path';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import type { ArtifactInfo, ArtifactStore } from './artifact-store.js';
import {
  ChromeCdpDriver,
  type BrowserAction,
  type BrowserCdpDriver,
  type BrowserPageSummary,
  type BrowserSnapshotData,
  type BrowserSnapshotOptions
} from './browser-cdp.js';
import type { DesktopBackendBridge } from './desktop-backend-bridge.js';
import {
  extractListedProcessPids,
  extractStartedPid,
  type ProcessSessionRegistry
} from './process-session-registry.js';

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_START_TIMEOUT_MS = 15000;
const MAX_START_TIMEOUT_MS = 60000;
const SCREENSHOT_RETENTION_SECONDS = 60 * 60;

export interface BrowserProcessController {
  start(command: string): Promise<string>;
  active(processSessionId: string): Promise<boolean>;
  terminate(processSessionId: string): Promise<void>;
}

export interface BrowserRuntimeInfo {
  readonly configured: boolean;
  readonly process_ownership: 'deskmcp-job-object';
  readonly profile_isolation: true;
  readonly reuse_existing_cdp: false;
  readonly active_sessions: number;
}

export interface BrowserSessionSummary {
  readonly session_id: string;
  readonly profile_id: string;
  readonly persistent_profile: boolean;
  readonly headless: boolean;
  readonly agent_desktop: boolean;
  readonly created_at: string;
  readonly active: boolean;
  readonly pages?: readonly BrowserPageSummary[];
}

export interface BrowserStartOptions {
  readonly url?: string;
  readonly headless?: boolean;
  readonly profile_id?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly timeout_ms?: number;
  readonly agent_desktop_lease_id?: string;
}

export interface BrowserStartResult extends BrowserSessionSummary {
  readonly page_id: string;
  readonly url: string;
  readonly title: string;
  readonly pages: readonly BrowserPageSummary[];
}

export interface BrowserSnapshotResult extends Omit<BrowserSnapshotData, 'png'> {
  readonly session_id: string;
  readonly screenshot?: ArtifactInfo;
}

interface BrowserSessionRecord {
  readonly sessionId: string;
  readonly processSessionId: string;
  readonly profileId: string;
  readonly profileDir: string;
  readonly persistentProfile: boolean;
  readonly headless: boolean;
  readonly port: number;
  readonly browserProcessId?: number;
  readonly agentDesktopLeaseId?: string;
  readonly createdAt: string;
}

function normalizeTimeout(value: number | undefined): number {
  const selected = value ?? DEFAULT_START_TIMEOUT_MS;
  if (!Number.isInteger(selected) || selected < 1000 || selected > MAX_START_TIMEOUT_MS) {
    throw new Error(`Browser timeout_ms must be between 1000 and ${MAX_START_TIMEOUT_MS}.`);
  }
  return selected;
}

function normalizeViewport(value: BrowserStartOptions['viewport']): { width: number; height: number } {
  const width = value?.width ?? 1440;
  const height = value?.height ?? 900;
  if (!Number.isInteger(width) || width < 320 || width > 7680) throw new Error('Browser viewport width must be between 320 and 7680.');
  if (!Number.isInteger(height) || height < 240 || height > 4320) throw new Error('Browser viewport height must be between 240 and 4320.');
  return { width, height };
}

function normalizeProfileId(value: string | undefined): { id: string; persistent: boolean } {
  if (!value?.trim()) {
    return { id: `session-${randomUUID()}`, persistent: false };
  }
  const selected = value.trim();
  if (!PROFILE_ID_PATTERN.test(selected) || selected === '.' || selected === '..') {
    throw new Error('Browser profile_id must be 1-64 safe filename characters and cannot be dot segments.');
  }
  return { id: selected, persistent: true };
}

function normalizeInitialUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('Browser start URL is invalid.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Browser start URL only supports HTTP(S).');
  }
  return url.toString();
}

function psSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function browserLaunchCommand(
  executable: string,
  profileDir: string,
  headless: boolean,
  viewport: { width: number; height: number },
  agentDesktop: boolean
): string {
  const args = [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    `--window-size=${viewport.width},${viewport.height}`,
    ...(agentDesktop ? ['--start-minimized'] : []),
    ...(headless ? ['--headless=new'] : []),
    'about:blank'
  ];
  const processArgs = args.map(value => psSingleQuoted(`"${value}"`)).join(',');
  const pidFile = path.join(profileDir, 'BrowserProcessId');
  return `$browserArgs = @(${processArgs}); $browserProcess = Start-Process -FilePath ${psSingleQuoted(executable)} -ArgumentList $browserArgs -PassThru; [IO.File]::WriteAllText(${psSingleQuoted(pidFile)}, [string]$browserProcess.Id); $browserProcess.WaitForExit(); exit $browserProcess.ExitCode`;
}

function validateSessionId(value: string): string {
  const selected = value.trim();
  if (!SESSION_ID_PATTERN.test(selected)) throw new Error('Invalid browser session_id.');
  return selected;
}

async function pollDevToolsActivePort(profileDir: string, timeoutMs: number): Promise<number> {
  const activePortFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(activePortFile, 'utf8');
      const line = text.split(/\r?\n/u)[0]?.trim() ?? '';
      const port = Number.parseInt(line, 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
      lastError = new Error('DevToolsActivePort did not contain a valid port.');
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Browser did not publish a CDP port within ${timeoutMs}ms.${detail}`);
}

async function pollBrowserProcessId(profileDir: string, timeoutMs: number): Promise<number> {
  const pidFile = path.join(profileDir, 'BrowserProcessId');
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(pidFile, 'utf8');
      const pid = Number.parseInt(text.trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
      lastError = new Error('BrowserProcessId did not contain a valid process id.');
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Browser did not publish its process id within ${timeoutMs}ms.${detail}`);
}

export class OwnedBrowserProcessController implements BrowserProcessController {
  constructor(
    private readonly bridge: DesktopBackendBridge,
    private readonly sessions: ProcessSessionRegistry
  ) {}

  private async reconcile(): Promise<void> {
    const listed = await this.bridge.listProcessSessions();
    if (listed.isError) return;
    this.sessions.reconcileActivePids(extractListedProcessPids(listed.text));
  }

  async start(command: string): Promise<string> {
    if (this.sessions.atCapacity()) await this.reconcile();
    const reservationId = this.sessions.reserveStart();
    let pid: number | undefined;
    try {
      const result = await this.bridge.startProcess(command, 3000, 'powershell.exe', 'hidden', 'standard');
      if (result.isError) throw new Error(`Browser process start failed: ${result.text}`);
      pid = extractStartedPid(result.text);
      return this.sessions.registerReserved(reservationId, pid, 'hidden');
    } catch (error) {
      this.sessions.releaseStart(reservationId);
      if (pid !== undefined) await this.bridge.forceTerminateProcess(pid).catch(() => undefined);
      throw error;
    }
  }

  async active(processSessionId: string): Promise<boolean> {
    await this.reconcile();
    return this.sessions.isActive(processSessionId);
  }

  async terminate(processSessionId: string): Promise<void> {
    await this.reconcile();
    if (!this.sessions.has(processSessionId)) return;
    if (!this.sessions.isActive(processSessionId)) {
      this.sessions.forget(processSessionId);
      return;
    }
    const pid = this.sessions.resolve(processSessionId);
    const result = await this.bridge.forceTerminateProcess(pid);
    await this.reconcile();
    if (result.isError && this.sessions.isActive(processSessionId)) {
      throw new Error(`Browser process termination failed: ${result.text}`);
    }
    this.sessions.forget(processSessionId);
  }
}

export class BrowserRuntime {
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly profilesInUse = new Map<string, string>();
  private mutationChain: Promise<void> = Promise.resolve();
  private leaseReaper: NodeJS.Timeout | undefined;

  constructor(
    readonly root: string,
    private readonly processController: BrowserProcessController,
    private readonly artifacts: ArtifactStore,
    private readonly cdp: BrowserCdpDriver = new ChromeCdpDriver(),
    private readonly executablePath = process.env.DESKTOP_MCP_BROWSER_EXECUTABLE?.trim(),
    private readonly agentDesktop?: AgentDesktopManager
  ) {}

  async init(): Promise<void> {
    await mkdir(path.join(this.root, 'profiles'), { recursive: true, mode: 0o700 });
    if (this.agentDesktop && !this.leaseReaper) {
      this.leaseReaper = setInterval(() => {
        void this.reapRevokedAgentDesktopLeases().catch(() => undefined);
      }, 1000);
      this.leaseReaper.unref();
    }
  }

  info(): BrowserRuntimeInfo {
    return {
      configured: Boolean(this.executablePath),
      process_ownership: 'deskmcp-job-object',
      profile_isolation: true,
      reuse_existing_cdp: false,
      active_sessions: this.sessions.size
    };
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  private async disposeRecord(record: BrowserSessionRecord): Promise<void> {
    this.sessions.delete(record.sessionId);
    this.profilesInUse.delete(record.profileId);
    await this.processController.terminate(record.processSessionId).catch(() => undefined);
    if (!record.persistentProfile) await rm(record.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async reapRevokedAgentDesktopLeases(): Promise<void> {
    if (!this.agentDesktop) return;
    await this.serializeMutation(async () => {
      const leased = [...this.sessions.values()].filter(record => Boolean(record.agentDesktopLeaseId));
      for (const record of leased) {
        if (record.agentDesktopLeaseId && await this.agentDesktop!.isLeaseActive(record.agentDesktopLeaseId)) continue;
        await this.disposeRecord(record);
      }
    });
  }

  private async configuredExecutable(): Promise<string> {
    if (!this.executablePath) {
      throw new Error('Browser automation is not configured. Set DESKTOP_MCP_BROWSER_EXECUTABLE locally to a Chrome/Chromium/Edge executable.');
    }
    if (!path.isAbsolute(this.executablePath)) throw new Error('DESKTOP_MCP_BROWSER_EXECUTABLE must be an absolute path.');
    await access(this.executablePath);
    const info = await stat(this.executablePath);
    if (!info.isFile()) throw new Error('Configured browser executable is not a regular file.');
    return this.executablePath;
  }

  private async reconcile(): Promise<void> {
    for (const [sessionId, record] of [...this.sessions]) {
      let active = false;
      try { active = await this.processController.active(record.processSessionId); }
      catch { active = false; }
      if (active) continue;
      this.sessions.delete(sessionId);
      this.profilesInUse.delete(record.profileId);
      if (!record.persistentProfile) await rm(record.profileDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private session(sessionId: string): BrowserSessionRecord {
    const selected = this.sessions.get(validateSessionId(sessionId));
    if (!selected) throw new Error('Browser session not found or no longer active.');
    return selected;
  }

  async start(options: BrowserStartOptions = {}): Promise<BrowserStartResult> {
    return this.serializeMutation(async () => {
      await this.reconcile();
      const executable = await this.configuredExecutable();
      const profile = normalizeProfileId(options.profile_id);
      if (this.profilesInUse.has(profile.id)) throw new Error(`Browser profile is already in use: ${profile.id}.`);
      const viewport = normalizeViewport(options.viewport);
      const timeout = normalizeTimeout(options.timeout_ms);
      const initialUrl = normalizeInitialUrl(options.url);
      const agentDesktopLeaseId = options.agent_desktop_lease_id?.trim();
      const agentDesktop = Boolean(agentDesktopLeaseId);
      if (agentDesktop && !this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
      if (agentDesktopLeaseId) await this.agentDesktop!.assertLease(agentDesktopLeaseId);
      const headless = agentDesktop ? false : options.headless !== false;
      const sessionId = randomUUID();
      const profileDir = path.join(this.root, 'profiles', profile.id);
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      await Promise.all([
        rm(path.join(profileDir, 'DevToolsActivePort'), { force: true }).catch(() => undefined),
        rm(path.join(profileDir, 'BrowserProcessId'), { force: true }).catch(() => undefined)
      ]);
      this.profilesInUse.set(profile.id, sessionId);

      let processSessionId: string | undefined;
      try {
        processSessionId = await this.processController.start(browserLaunchCommand(executable, profileDir, headless, viewport, agentDesktop));
        const [port, browserProcessId] = await Promise.all([
          pollDevToolsActivePort(profileDir, timeout),
          agentDesktop ? pollBrowserProcessId(profileDir, timeout) : Promise.resolve(undefined)
        ]);
        if (agentDesktopLeaseId) {
          if (browserProcessId === undefined) throw new Error('Agent Desktop browser process id was not published.');
          await this.agentDesktop!.placeProcessWindows(browserProcessId, agentDesktopLeaseId);
        }
        const pages = await this.cdp.listPages(port, Math.min(timeout, 10000));
        if (pages.length === 0) throw new Error('Browser started but no controllable page was found.');
        const first = pages[0]!;
        if (initialUrl) {
          if (agentDesktopLeaseId) await this.agentDesktop!.assertLease(agentDesktopLeaseId);
          await this.cdp.act(port, first.page_id, [{ type: 'goto', url: initialUrl, wait_until: 'domcontentloaded', timeout_ms: timeout }], timeout);
        }
        const currentPages = await this.cdp.listPages(port, Math.min(timeout, 10000));
        const selected = currentPages.find(page => page.page_id === first.page_id) ?? currentPages[0]!;
        const record: BrowserSessionRecord = {
          sessionId,
          processSessionId,
          profileId: profile.id,
          profileDir,
          persistentProfile: profile.persistent,
          headless,
          port,
          ...(browserProcessId !== undefined ? { browserProcessId } : {}),
          ...(agentDesktopLeaseId ? { agentDesktopLeaseId } : {}),
          createdAt: new Date().toISOString()
        };
        this.sessions.set(sessionId, record);
        return {
          session_id: sessionId,
          profile_id: profile.id,
          persistent_profile: profile.persistent,
          headless,
          agent_desktop: agentDesktop,
          created_at: record.createdAt,
          active: true,
          page_id: selected.page_id,
          url: selected.url,
          title: selected.title,
          pages: currentPages
        };
      } catch (error) {
        this.profilesInUse.delete(profile.id);
        if (processSessionId) await this.processController.terminate(processSessionId).catch(() => undefined);
        if (!profile.persistent) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async list(): Promise<readonly BrowserSessionSummary[]> {
    await this.reconcile();
    const out: BrowserSessionSummary[] = [];
    for (const record of this.sessions.values()) {
      let pages: readonly BrowserPageSummary[] | undefined;
      try { pages = await this.cdp.listPages(record.port, 3000); } catch { }
      out.push({
        session_id: record.sessionId,
        profile_id: record.profileId,
        persistent_profile: record.persistentProfile,
        headless: record.headless,
        agent_desktop: Boolean(record.agentDesktopLeaseId),
        created_at: record.createdAt,
        active: true,
        ...(pages ? { pages } : {})
      });
    }
    return out;
  }

  async snapshot(sessionId: string, pageId: string | undefined, options: BrowserSnapshotOptions = {}): Promise<BrowserSnapshotResult> {
    await this.reconcile();
    const record = this.session(sessionId);
    const snapshot = await this.cdp.snapshot(record.port, pageId, options);
    let screenshot: ArtifactInfo | undefined;
    if (options.screenshot !== false && snapshot.png) {
      screenshot = await this.artifacts.publishBytes(
        `browser-${record.sessionId}-${Date.now()}.png`,
        snapshot.png,
        'image/png',
        { retention_seconds: SCREENSHOT_RETENTION_SECONDS }
      );
    }
    const { png: _png, ...publicSnapshot } = snapshot;
    return {
      session_id: record.sessionId,
      ...publicSnapshot,
      ...(screenshot ? { screenshot } : {})
    };
  }

  async act(
    sessionId: string,
    pageId: string | undefined,
    actions: readonly BrowserAction[],
    options: BrowserSnapshotOptions = {}
  ): Promise<BrowserSnapshotResult> {
    await this.reconcile();
    const record = this.session(sessionId);
    if (record.agentDesktopLeaseId) {
      if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
      await this.agentDesktop.assertLease(record.agentDesktopLeaseId);
    }
    const effectivePageId = await this.cdp.act(record.port, pageId, actions, options.timeout_ms ?? 15000);
    return this.snapshot(record.sessionId, effectivePageId, options);
  }

  async close(sessionId: string): Promise<{ session_id: string; closed: boolean }> {
    return this.serializeMutation(async () => {
      await this.reconcile();
      const normalized = validateSessionId(sessionId);
      const record = this.sessions.get(normalized);
      if (!record) return { session_id: normalized, closed: false };
      if (record.agentDesktopLeaseId) {
        throw new Error('Agent Desktop browser sessions stay open until their Agent Control lease exits. Exit Agent Control instead of closing this browser session directly.');
      }
      await this.disposeRecord(record);
      return { session_id: normalized, closed: true };
    });
  }

  async closeAgentDesktopLease(leaseId: string): Promise<{ lease_id: string; closed_sessions: number }> {
    const normalizedLeaseId = leaseId.trim();
    if (!SESSION_ID_PATTERN.test(normalizedLeaseId)) throw new Error('Invalid Agent Desktop lease id.');
    return this.serializeMutation(async () => {
      const records = [...this.sessions.values()].filter(record => record.agentDesktopLeaseId === normalizedLeaseId);
      for (const record of records) await this.disposeRecord(record);
      return { lease_id: normalizedLeaseId, closed_sessions: records.length };
    });
  }

  async closeAll(): Promise<void> {
    if (this.leaseReaper) {
      clearInterval(this.leaseReaper);
      this.leaseReaper = undefined;
    }
    await this.serializeMutation(async () => {
      const records = [...this.sessions.values()];
      for (const record of records) await this.disposeRecord(record);
    });
  }
}
