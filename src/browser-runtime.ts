import { randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import type { ArtifactInfo, ArtifactStore } from './artifact-store.js';
import {
  ChromeCdpDriver,
  type BrowserAction,
  type BrowserCdpDriver,
  type BrowserFindData,
  type BrowserFindOptions,
  type BrowserPageSummary,
  type BrowserSnapshotData,
  type BrowserSnapshotOptions
} from './browser-cdp.js';
import { PlaywrightBrowserDriver } from './browser-playwright.js';
import { acquirePidDirectoryLock, inspectPidDirectoryLock, type PidDirectoryLockLease } from './cross-process-lock.js';
import type { DesktopBackendBridge } from './desktop-backend-bridge.js';
import {
  extractListedProcessPids,
  extractStartedPid,
  type ProcessSessionRegistry
} from './process-session-registry.js';

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EPHEMERAL_PROFILE_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_START_TIMEOUT_MS = 15000;
const MAX_START_TIMEOUT_MS = 60000;
const SCREENSHOT_RETENTION_SECONDS = 60 * 60;
const BROWSER_OBSERVATION_TTL_MS = 30_000;
const MAX_BROWSER_OBSERVATIONS = 1024;
const PROFILE_LOCK_INITIALIZATION_GRACE_MS = 5_000;
const PROFILE_LOCK_TIMEOUT_MS = 250;
const MAX_PERSISTENT_PROFILES = 32;
const MAX_BROWSER_DOWNLOAD_BYTES = 64 * 1024 * 1024;

function browserActionMutatesObservedState(action: BrowserAction): boolean {
  switch (action.type) {
    case 'wait':
    case 'wait_selector':
    case 'wait_url':
    case 'wait_text':
      return false;
    default:
      return true;
  }
}

export interface BrowserProcessController {
  start(command: string, agentDesktopLeaseId?: string): Promise<string>;
  active(processSessionId: string): Promise<boolean>;
  terminate(processSessionId: string): Promise<void>;
}

export interface BrowserRuntimeInfo {
  readonly configured: boolean;
  readonly engine: 'playwright' | 'legacy-cdp' | 'injected';
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

export interface BrowserProfileSummary {
  readonly profile_id: string;
  readonly in_use: boolean;
  readonly modified_at: string;
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

export interface BrowserSnapshotResult extends Omit<BrowserSnapshotData, 'png' | 'state_token'> {
  readonly session_id: string;
  readonly browser_observation_id: string;
  readonly screenshot?: ArtifactInfo;
  readonly download?: ArtifactInfo;
}

export interface BrowserFindResult extends Omit<BrowserFindData, 'state_token'> {
  readonly session_id: string;
  readonly browser_observation_id: string;
}

interface BrowserSessionRecord {
  readonly sessionId: string;
  readonly processSessionId: string;
  readonly profileId: string;
  readonly profileDir: string;
  readonly profileLock: PidDirectoryLockLease;
  readonly persistentProfile: boolean;
  readonly headless: boolean;
  readonly port: number;
  readonly agentDesktopLeaseId?: string;
  readonly createdAt: string;
}

interface BrowserObservationRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly pageId: string;
  readonly stateToken: string;
  readonly expiresAt: number;
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
  return `$browserArgs = @(${processArgs}); $browserProcess = Start-Process -FilePath ${psSingleQuoted(executable)} -ArgumentList $browserArgs -PassThru; $browserProcess.WaitForExit(); exit $browserProcess.ExitCode`;
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

export class OwnedBrowserProcessController implements BrowserProcessController {
  constructor(
    private readonly bridge: DesktopBackendBridge,
    private readonly sessions: ProcessSessionRegistry,
    private readonly agentDesktop?: AgentDesktopManager
  ) {}

  private async reconcile(): Promise<void> {
    const listed = await this.bridge.listProcessSessions();
    if (listed.isError) return;
    this.sessions.reconcileActivePids(extractListedProcessPids(listed.text));
  }

  async start(command: string, agentDesktopLeaseId?: string): Promise<string> {
    if (agentDesktopLeaseId) {
      if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable for browser process placement.');
      await this.agentDesktop.assertLease(agentDesktopLeaseId);
    }
    if (this.sessions.atCapacity()) await this.reconcile();
    const reservationId = this.sessions.reserveStart();
    let pid: number | undefined;
    let sessionId: string | undefined;
    try {
      const result = await this.bridge.startProcess(command, 3000, 'powershell.exe', 'hidden', 'standard');
      if (result.isError) throw new Error(`Browser process start failed: ${result.text}`);
      pid = extractStartedPid(result.text);
      sessionId = this.sessions.registerReserved(reservationId, pid, 'hidden');
      if (agentDesktopLeaseId) {
        await this.agentDesktop!.placeProcessTreeWindows(pid, agentDesktopLeaseId);
        await this.agentDesktop!.assertLease(agentDesktopLeaseId);
      }
      return sessionId;
    } catch (error) {
      this.sessions.releaseStart(reservationId);
      if (sessionId) this.sessions.forget(sessionId);
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
  private readonly observations = new Map<string, BrowserObservationRecord>();
  private readonly cdp: BrowserCdpDriver;
  private readonly browserEngine: BrowserRuntimeInfo['engine'];
  private mutationChain: Promise<void> = Promise.resolve();
  private leaseReaper: NodeJS.Timeout | undefined;

  constructor(
    readonly root: string,
    private readonly processController: BrowserProcessController,
    private readonly artifacts: ArtifactStore,
    cdp: BrowserCdpDriver | undefined = undefined,
    private readonly executablePath = process.env.DESKTOP_MCP_BROWSER_EXECUTABLE?.trim(),
    private readonly agentDesktop?: AgentDesktopManager
  ) {
    if (cdp) {
      this.cdp = cdp;
      this.browserEngine = 'injected';
      return;
    }
    const configuredEngine = (process.env.DESKTOP_MCP_BROWSER_ENGINE ?? 'playwright').trim().toLowerCase();
    if (configuredEngine === 'playwright') {
      this.cdp = new PlaywrightBrowserDriver();
      this.browserEngine = 'playwright';
      return;
    }
    if (configuredEngine === 'legacy-cdp') {
      this.cdp = new ChromeCdpDriver();
      this.browserEngine = 'legacy-cdp';
      return;
    }
    throw new Error('DESKTOP_MCP_BROWSER_ENGINE must be either playwright or legacy-cdp.');
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.root, 'profiles'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, 'profile-locks'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, 'downloads'), { recursive: true, mode: 0o700 });
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
      engine: this.browserEngine,
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

  private cleanupExpiredObservations(now = Date.now()): void {
    for (const [id, observation] of this.observations) {
      if (observation.expiresAt <= now) this.observations.delete(id);
    }
  }

  private issueObservation(sessionId: string, pageId: string, stateToken: string): string {
    this.cleanupExpiredObservations();
    const id = randomUUID();
    this.observations.set(id, {
      id,
      sessionId,
      pageId,
      stateToken,
      expiresAt: Date.now() + BROWSER_OBSERVATION_TTL_MS
    });
    while (this.observations.size > MAX_BROWSER_OBSERVATIONS) {
      const oldest = this.observations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.observations.delete(oldest);
    }
    return id;
  }

  private consumeObservation(
    sessionId: string,
    pageId: string | undefined,
    observationId: string
  ): BrowserObservationRecord {
    const normalized = observationId.trim();
    if (!SESSION_ID_PATTERN.test(normalized)) throw new Error('Invalid browser_observation_id.');
    this.cleanupExpiredObservations();
    const observation = this.observations.get(normalized);
    if (!observation) throw new Error('Unknown, expired, or already-consumed browser_observation_id. Take a fresh browser snapshot.');
    this.observations.delete(normalized);
    if (observation.sessionId !== sessionId) throw new Error('browser_observation_id does not belong to this browser session.');
    if (pageId && observation.pageId !== pageId) throw new Error('browser_observation_id does not belong to the requested browser page.');
    for (const [id, sibling] of this.observations) {
      if (sibling.sessionId === observation.sessionId && sibling.pageId === observation.pageId) this.observations.delete(id);
    }
    return observation;
  }

  private invalidateSessionObservations(sessionId: string): void {
    for (const [id, observation] of this.observations) {
      if (observation.sessionId === sessionId) this.observations.delete(id);
    }
  }

  private invalidatePageObservations(sessionId: string, pageId: string): void {
    for (const [id, observation] of this.observations) {
      if (observation.sessionId === sessionId && observation.pageId === pageId) this.observations.delete(id);
    }
  }

  private profileLockDir(profileId: string): string {
    return path.join(this.root, 'profile-locks', `${profileId}.lock`);
  }

  private async acquireProfileLock(profileId: string, sessionId: string): Promise<PidDirectoryLockLease> {
    try {
      return await acquirePidDirectoryLock(this.profileLockDir(profileId), {
        label: `Browser profile ${profileId}`,
        timeoutMs: PROFILE_LOCK_TIMEOUT_MS,
        initializationGraceMs: PROFILE_LOCK_INITIALIZATION_GRACE_MS,
        metadata: { session_id: sessionId, profile_id: profileId }
      });
    } catch (error) {
      if (error instanceof Error && /busy in another DeskMCP process/i.test(error.message)) {
        throw new Error(`Browser profile is already owned by another DeskMCP Gateway: ${profileId}.`);
      }
      throw error;
    }
  }

  private async persistentProfileNames(): Promise<string[]> {
    const entries = await readdir(path.join(this.root, 'profiles'), { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && PROFILE_ID_PATTERN.test(entry.name) && !EPHEMERAL_PROFILE_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async profileAppearsInUse(profileId: string): Promise<boolean> {
    if (this.profilesInUse.has(profileId)) return true;
    const state = await inspectPidDirectoryLock(this.profileLockDir(profileId), PROFILE_LOCK_INITIALIZATION_GRACE_MS);
    return state !== 'missing' && state !== 'stale';
  }

  private async ensureProfileDirectory(profile: { id: string; persistent: boolean }, profileDir: string): Promise<void> {
    const existing = await lstat(profileDir).catch(() => undefined);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Browser profile path is not a trusted directory: ${profile.id}.`);
      return;
    }
    if (!profile.persistent) {
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      return;
    }

    const catalogOwner = `catalog-${randomUUID()}`;
    const catalogLock = await this.acquireProfileLock('__catalog__', catalogOwner);
    try {
      const rechecked = await lstat(profileDir).catch(() => undefined);
      if (rechecked) {
        if (!rechecked.isDirectory() || rechecked.isSymbolicLink()) throw new Error(`Browser profile path is not a trusted directory: ${profile.id}.`);
        return;
      }
      const profiles = await this.persistentProfileNames();
      if (profiles.length >= MAX_PERSISTENT_PROFILES) {
        throw new Error(`DeskMCP allows at most ${MAX_PERSISTENT_PROFILES} persistent browser profiles. Delete an unused profile before creating another.`);
      }
      await mkdir(profileDir, { mode: 0o700 });
    } finally {
      await catalogLock.release();
    }
  }

  private async disposeRecord(record: BrowserSessionRecord): Promise<void> {
    // Do not relinquish the profile lock until the owned browser process is
    // confirmed terminated. If termination fails, keeping the session and lock
    // is safer than allowing a second browser to reuse a profile still in use.
    await this.processController.terminate(record.processSessionId);
    await record.profileLock.release();
    this.sessions.delete(record.sessionId);
    this.profilesInUse.delete(record.profileId);
    this.invalidateSessionObservations(record.sessionId);
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
      this.invalidateSessionObservations(sessionId);
      try {
        await record.profileLock.release();
      } finally {
        if (!record.persistentProfile) await rm(record.profileDir, { recursive: true, force: true }).catch(() => undefined);
      }
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
      await this.ensureProfileDirectory(profile, profileDir);
      const profileLock = await this.acquireProfileLock(profile.id, sessionId);
      this.profilesInUse.set(profile.id, sessionId);
      await rm(path.join(profileDir, 'DevToolsActivePort'), { force: true }).catch(() => undefined);

      let processSessionId: string | undefined;
      try {
        processSessionId = await this.processController.start(
          browserLaunchCommand(executable, profileDir, headless, viewport, agentDesktop),
          agentDesktopLeaseId
        );
        const port = await pollDevToolsActivePort(profileDir, timeout);
        if (agentDesktopLeaseId) await this.agentDesktop!.assertLease(agentDesktopLeaseId);
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
          profileLock,
          persistentProfile: profile.persistent,
          headless,
          port,
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
        try {
          await profileLock.release();
        } catch (lockError) {
          if (!profile.persistent) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
          throw new AggregateError([error, lockError], 'Browser start failed and profile lock release also failed.');
        }
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

  async listProfiles(): Promise<readonly BrowserProfileSummary[]> {
    await this.reconcile();
    const profiles: BrowserProfileSummary[] = [];
    for (const profileId of await this.persistentProfileNames()) {
      const profileDir = path.join(this.root, 'profiles', profileId);
      const info = await lstat(profileDir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Browser profile path is not a trusted directory: ${profileId}.`);
      profiles.push({
        profile_id: profileId,
        in_use: await this.profileAppearsInUse(profileId),
        modified_at: info.mtime.toISOString()
      });
    }
    return profiles;
  }

  async deleteProfile(profileId: string): Promise<{ readonly profile_id: string; readonly deleted: boolean }> {
    return this.serializeMutation(async () => {
      await this.reconcile();
      const profile = normalizeProfileId(profileId);
      const maintenanceOwner = `maintenance-${randomUUID()}`;
      const maintenanceLock = await this.acquireProfileLock(profile.id, maintenanceOwner);
      try {
        const profileDir = path.join(this.root, 'profiles', profile.id);
        const info = await lstat(profileDir).catch(() => undefined);
        if (!info) return { profile_id: profile.id, deleted: false };
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Browser profile path is not a trusted directory: ${profile.id}.`);
        await rm(profileDir, { recursive: true, force: true });
        return { profile_id: profile.id, deleted: true };
      } finally {
        await maintenanceLock.release();
      }
    });
  }

  async newPage(sessionId: string, url?: string, timeoutMs = 5000): Promise<{
    readonly session_id: string;
    readonly page_id: string;
    readonly pages: readonly BrowserPageSummary[];
  }> {
    return this.serializeMutation(async () => {
      await this.reconcile();
      const record = this.session(sessionId);
      if (record.agentDesktopLeaseId) {
        if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
        await this.agentDesktop.assertLease(record.agentDesktopLeaseId);
      }
      const pageId = await this.cdp.createPage(record.port, url, timeoutMs);
      this.invalidateSessionObservations(record.sessionId);
      if (record.agentDesktopLeaseId) await this.agentDesktop!.assertLease(record.agentDesktopLeaseId);
      return {
        session_id: record.sessionId,
        page_id: pageId,
        pages: await this.cdp.listPages(record.port, timeoutMs)
      };
    });
  }

  async selectPage(sessionId: string, pageId: string, timeoutMs = 5000): Promise<{
    readonly session_id: string;
    readonly page_id: string;
    readonly selected: true;
    readonly pages: readonly BrowserPageSummary[];
    readonly observation_required_before_next_action: true;
  }> {
    return this.serializeMutation(async () => {
      await this.reconcile();
      const record = this.session(sessionId);
      if (record.agentDesktopLeaseId) {
        if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
        await this.agentDesktop.assertLease(record.agentDesktopLeaseId);
      }
      const selectedId = await this.cdp.selectPage(record.port, pageId, timeoutMs);
      this.invalidateSessionObservations(record.sessionId);
      if (record.agentDesktopLeaseId) await this.agentDesktop!.assertLease(record.agentDesktopLeaseId);
      return {
        session_id: record.sessionId,
        page_id: selectedId,
        selected: true,
        pages: await this.cdp.listPages(record.port, timeoutMs),
        observation_required_before_next_action: true
      };
    });
  }

  async closePage(sessionId: string, pageId: string, timeoutMs = 5000): Promise<{
    readonly session_id: string;
    readonly page_id: string;
    readonly closed: true;
    readonly pages: readonly BrowserPageSummary[];
  }> {
    return this.serializeMutation(async () => {
      await this.reconcile();
      const record = this.session(sessionId);
      if (record.agentDesktopLeaseId) {
        if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
        await this.agentDesktop.assertLease(record.agentDesktopLeaseId);
      }
      await this.cdp.closePage(record.port, pageId, timeoutMs);
      this.invalidateSessionObservations(record.sessionId);
      if (record.agentDesktopLeaseId) await this.agentDesktop!.assertLease(record.agentDesktopLeaseId);
      return {
        session_id: record.sessionId,
        page_id: pageId,
        closed: true,
        pages: await this.cdp.listPages(record.port, timeoutMs)
      };
    });
  }

  async handleDialog(
    sessionId: string,
    pageId: string,
    accept: boolean,
    promptText?: string,
    timeoutMs = 5000
  ): Promise<{
    readonly session_id: string;
    readonly page_id: string;
    readonly handled: true;
    readonly observation_required_before_next_action: true;
  }> {
    return this.serializeMutation(async () => {
      await this.reconcile();
      const record = this.session(sessionId);
      if (record.agentDesktopLeaseId) {
        if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
        await this.agentDesktop.assertLease(record.agentDesktopLeaseId);
      }
      await this.cdp.handleDialog(record.port, pageId, accept, promptText, timeoutMs);
      this.invalidateSessionObservations(record.sessionId);
      if (record.agentDesktopLeaseId) await this.agentDesktop!.assertLease(record.agentDesktopLeaseId);
      return {
        session_id: record.sessionId,
        page_id: pageId,
        handled: true,
        observation_required_before_next_action: true
      };
    });
  }

  async find(sessionId: string, pageId: string | undefined, options: BrowserFindOptions): Promise<BrowserFindResult> {
    await this.reconcile();
    const record = this.session(sessionId);
    if (record.agentDesktopLeaseId) {
      if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
      await this.agentDesktop.assertLease(record.agentDesktopLeaseId);
    }
    const found = await this.cdp.find(record.port, pageId, options);
    if (record.agentDesktopLeaseId) await this.agentDesktop!.assertLease(record.agentDesktopLeaseId);
    const browserObservationId = this.issueObservation(record.sessionId, found.page_id, found.state_token);
    const { state_token: _stateToken, ...publicFind } = found;
    return {
      session_id: record.sessionId,
      browser_observation_id: browserObservationId,
      ...publicFind
    };
  }

  async snapshot(sessionId: string, pageId: string | undefined, options: BrowserSnapshotOptions = {}): Promise<BrowserSnapshotResult> {
    await this.reconcile();
    const record = this.session(sessionId);
    if (record.agentDesktopLeaseId) {
      if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
      await this.agentDesktop.assertLease(record.agentDesktopLeaseId);
    }
    const snapshot = await this.cdp.snapshot(record.port, pageId, options);
    if (record.agentDesktopLeaseId) await this.agentDesktop!.assertLease(record.agentDesktopLeaseId);
    let screenshot: ArtifactInfo | undefined;
    if (options.screenshot !== false && snapshot.png) {
      screenshot = await this.artifacts.publishBytes(
        `browser-${record.sessionId}-${Date.now()}.png`,
        snapshot.png,
        'image/png',
        { retention_seconds: SCREENSHOT_RETENTION_SECONDS }
      );
    }
    const browserObservationId = this.issueObservation(record.sessionId, snapshot.page_id, snapshot.state_token);
    const { png: _png, state_token: _stateToken, ...publicSnapshot } = snapshot;
    return {
      session_id: record.sessionId,
      browser_observation_id: browserObservationId,
      ...publicSnapshot,
      ...(screenshot ? { screenshot } : {})
    };
  }

  async download(
    sessionId: string,
    pageId: string | undefined,
    browserObservationId: string,
    selector: string | undefined,
    ref: string | undefined,
    options: BrowserSnapshotOptions = {}
  ): Promise<BrowserSnapshotResult> {
    await this.reconcile();
    const record = this.session(sessionId);
    const selectedSelector = selector?.trim();
    const selectedRef = ref?.trim();
    if (Boolean(selectedSelector) === Boolean(selectedRef)) {
      throw new Error('Browser download requires exactly one of selector or ref.');
    }
    const observation = this.consumeObservation(record.sessionId, pageId, browserObservationId);
    if (record.agentDesktopLeaseId) {
      if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
      await this.agentDesktop.assertLease(record.agentDesktopLeaseId);
    }
    const currentStateToken = await this.cdp.stateToken(record.port, observation.pageId, Math.min(options.timeout_ms ?? 5000, 10_000));
    if (currentStateToken !== observation.stateToken) {
      throw new Error('STALE browser observation: the page changed after the snapshot. Take a fresh browser snapshot before downloading.');
    }

    const downloadDir = path.join(this.root, 'downloads', record.sessionId);
    await mkdir(downloadDir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(downloadDir, `${randomUUID()}.download`);
    let artifact: ArtifactInfo;
    let effectivePageId = observation.pageId;
    try {
      const downloaded = await this.cdp.download(
        record.port,
        observation.pageId,
        selectedSelector,
        selectedRef,
        tempPath,
        options.timeout_ms ?? 15_000
      );
      effectivePageId = downloaded.page_id;
      if (path.resolve(downloaded.path) !== path.resolve(tempPath)) {
        throw new Error('Browser download engine returned an unexpected destination path.');
      }
      const info = await stat(tempPath);
      if (!info.isFile()) throw new Error('Browser download did not produce a regular file.');
      if (info.size <= 0) throw new Error('Browser download produced an empty file.');
      if (info.size > MAX_BROWSER_DOWNLOAD_BYTES) {
        throw new Error(`Browser download exceeds ${MAX_BROWSER_DOWNLOAD_BYTES} bytes.`);
      }
      const bytes = await readFile(tempPath);
      artifact = await this.artifacts.publishBytes(
        downloaded.suggested_filename,
        bytes,
        undefined,
        { retention_seconds: SCREENSHOT_RETENTION_SECONDS }
      );
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    if (record.agentDesktopLeaseId) await this.agentDesktop!.assertLease(record.agentDesktopLeaseId);
    const fresh = await this.snapshot(record.sessionId, effectivePageId, options);
    return { ...fresh, download: artifact };
  }

  async act(
    sessionId: string,
    pageId: string | undefined,
    browserObservationId: string,
    actions: readonly BrowserAction[],
    options: BrowserSnapshotOptions = {}
  ): Promise<BrowserSnapshotResult> {
    await this.reconcile();
    const record = this.session(sessionId);
    const mutatingActions = actions.filter(browserActionMutatesObservedState).length;
    if (mutatingActions > 1) {
      throw new Error('A browser observation may authorize at most one state-mutating action. Split the sequence and take a fresh browser snapshot before the next mutation.');
    }
    const observation = this.consumeObservation(record.sessionId, pageId, browserObservationId);
    if (record.agentDesktopLeaseId) {
      if (!this.agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
      await this.agentDesktop.assertLease(record.agentDesktopLeaseId);
    }
    const currentStateToken = await this.cdp.stateToken(record.port, observation.pageId, Math.min(options.timeout_ms ?? 5000, 10000));
    if (currentStateToken !== observation.stateToken) {
      throw new Error('STALE browser observation: the page changed after the snapshot. Take a fresh browser snapshot before acting.');
    }
    const effectivePageId = await this.cdp.act(record.port, observation.pageId, actions, options.timeout_ms ?? 15000);
    if (record.agentDesktopLeaseId) await this.agentDesktop!.assertLease(record.agentDesktopLeaseId);
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
