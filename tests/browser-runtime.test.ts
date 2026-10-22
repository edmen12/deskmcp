import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import { createBrowserHandoffBoundary } from '../src/browser-handoff-boundary.js';
import { ArtifactStore } from '../src/artifact-store.js';
import type {
  BrowserAction,
  BrowserCdpDriver,
  BrowserFindData,
  BrowserFindOptions,
  BrowserPageSummary,
  BrowserSnapshotData,
  BrowserSnapshotOptions
} from '../src/browser-cdp.js';
import {
  BrowserRuntime,
  OwnedBrowserProcessController,
  type BrowserProcessController,
  type BrowserProcessPlacementResult
} from '../src/browser-runtime.js';
import type { DesktopBackendBridge } from '../src/desktop-backend-bridge.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';

async function tempRoot(): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'deskmcp-browser-test-')));
}

class FakeProcessController implements BrowserProcessController {
  readonly starts: string[] = [];
  readonly leaseIds: Array<string | undefined> = [];
  readonly terminated: string[] = [];
  readonly activeIds = new Set<string>();
  readonly placements: Array<{ processSessionId: string; leaseId: string; timeoutMs: number; reconcile: boolean }> = [];
  placementWindows: number[] = [];
  placementErrors: Array<Error | undefined> = [];
  failTerminate = false;
  private next = 1;

  constructor(private readonly runtimeRoot: string) {}

  async start(command: string, agentDesktopLeaseId?: string): Promise<string> {
    this.starts.push(command);
    this.leaseIds.push(agentDesktopLeaseId);
    const match = command.match(/'"--user-data-dir=([^"]+)"'/u);
    if (!match?.[1]) throw new Error('Test browser command did not contain a user-data-dir.');
    const profileDir = match[1].replaceAll("''", "'");
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'DevToolsActivePort'), '43210\n/devtools/browser/test\n', 'utf8');
    assert.ok(profileDir.startsWith(path.join(this.runtimeRoot, 'profiles')));
    const id = `process-${this.next++}`;
    this.activeIds.add(id);
    return id;
  }

  async active(processSessionId: string): Promise<boolean> {
    return this.activeIds.has(processSessionId);
  }

  async place(processSessionId: string, leaseId: string, timeoutMs = 250, reconcile = true) {
    this.placements.push({ processSessionId, leaseId, timeoutMs, reconcile });
    const placementError = this.placementErrors.length > 0 ? this.placementErrors.shift() : undefined;
    if (placementError) throw placementError;
    const windows = this.placementWindows.length > 0 ? this.placementWindows.shift()! : 1;
    return { moved: windows, windows };
  }

  async terminate(processSessionId: string): Promise<void> {
    this.terminated.push(processSessionId);
    if (this.failTerminate) throw new Error('INJECTED_BROWSER_TERMINATION_FAILURE');
    this.activeIds.delete(processSessionId);
  }
}

class EarlyExitProcessController implements BrowserProcessController {
  readonly terminated: string[] = [];

  async start(): Promise<string> {
    return 'early-exit-process';
  }

  async active(): Promise<boolean> {
    return false;
  }

  async diagnostics(): Promise<string | undefined> {
    return 'Start-Process : The application has failed to start because its side-by-side configuration is incorrect.';
  }

  async place(): Promise<BrowserProcessPlacementResult> {
    throw new Error('placement should not run for an early-exit browser process');
  }

  async terminate(processSessionId: string): Promise<void> {
    this.terminated.push(processSessionId);
  }
}

class FakeCdpDriver implements BrowserCdpDriver {
  readonly actions: BrowserAction[][] = [];
  readonly dialogs: Array<{ pageId: string | undefined; accept: boolean; promptText?: string }> = [];
  downloadCalls = 0;
  stateTokenValue = 'state-1';
  readonly pages: BrowserPageSummary[] = [{
    page_id: 'page-1',
    url: 'about:blank',
    title: '',
    active: true
  }];

  private nextPage = 2;

  async listPages(port: number): Promise<readonly BrowserPageSummary[]> {
    assert.equal(port, 43210);
    return this.pages.map(page => ({ ...page }));
  }

  async createPage(port: number, url?: string): Promise<string> {
    assert.equal(port, 43210);
    const pageId = `page-${this.nextPage++}`;
    this.pages.push({ page_id: pageId, url: url ?? 'about:blank', title: '', active: false });
    return pageId;
  }

  async selectPage(port: number, pageId: string): Promise<string> {
    assert.equal(port, 43210);
    if (!this.pages.some(page => page.page_id === pageId)) throw new Error(`Browser page not found: ${pageId}.`);
    for (let index = 0; index < this.pages.length; index++) {
      const page = this.pages[index]!;
      this.pages[index] = { ...page, active: page.page_id === pageId };
    }
    return pageId;
  }

  async closePage(port: number, pageId: string): Promise<void> {
    assert.equal(port, 43210);
    if (this.pages.length <= 1) throw new Error('Cannot close the last controllable browser page; close the browser session instead.');
    const index = this.pages.findIndex(page => page.page_id === pageId);
    if (index < 0) throw new Error(`Browser page not found: ${pageId}.`);
    this.pages.splice(index, 1);
  }

  async handleDialog(port: number, pageId: string | undefined, accept: boolean, promptText?: string): Promise<void> {
    assert.equal(port, 43210);
    this.dialogs.push({ pageId, accept, ...(promptText !== undefined ? { promptText } : {}) });
  }

  async download(port: number, pageId: string | undefined, selector: string | undefined, ref: string | undefined, destinationPath: string) {
    this.downloadCalls += 1;
    assert.equal(port, 43210);
    assert.equal(pageId ?? 'page-1', 'page-1');
    assert.equal(Boolean(selector), !Boolean(ref));
    await writeFile(destinationPath, 'DESKMCP_BROWSER_DOWNLOAD_TEST', 'utf8');
    return { page_id: 'page-1', suggested_filename: 'download.txt', path: destinationPath };
  }

  async find(port: number, pageId: string | undefined, options: BrowserFindOptions): Promise<BrowserFindData> {
    assert.equal(port, 43210);
    const selectedPageId = pageId ?? this.pages.find(page => page.active)?.page_id ?? 'page-1';
    const selected = this.pages.find(page => page.page_id === selectedPageId);
    if (!selected) throw new Error(`Browser page not found: ${selectedPageId}.`);
    return {
      page_id: selectedPageId,
      pages: this.pages,
      url: selected.url,
      title: selected.title,
      matches: [{ path: 'document > button "Submit" [ref=e2]', snippet: `button | ${options.query} | ref=e2`, ref: 'e2', role: 'button', name: 'Submit' }].slice(0, options.max_results ?? 20),
      state_token: this.stateTokenValue
    };
  }

  async snapshot(port: number, pageId: string | undefined, _options?: BrowserSnapshotOptions): Promise<BrowserSnapshotData> {
    assert.equal(port, 43210);
    assert.equal(pageId ?? 'page-1', 'page-1');
    return {
      page_id: 'page-1',
      pages: this.pages,
      url: 'https://example.com/',
      title: 'Example',
      text: 'Browser snapshot text',
      viewport: { width: 1440, height: 900 },
      page_size: { width: 1440, height: 1200 },
      interactive_elements: [{ tag: 'a', text: 'Example link', href: 'https://example.com/', selector: '#link' }],
      state_token: this.stateTokenValue,
      png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    };
  }

  async stateToken(port: number, pageId: string | undefined): Promise<string> {
    assert.equal(port, 43210);
    assert.equal(pageId ?? 'page-1', 'page-1');
    return this.stateTokenValue;
  }

  async act(port: number, pageId: string | undefined, actions: readonly BrowserAction[]): Promise<string> {
    assert.equal(port, 43210);
    assert.equal(pageId ?? 'page-1', 'page-1');
    this.actions.push(actions.map(action => ({ ...action })) as BrowserAction[]);
    const goto = actions.find(action => action.type === 'goto');
    if (goto?.type === 'goto') {
      this.pages[0] = { ...this.pages[0]!, url: goto.url, title: 'Example' };
    }
    return 'page-1';
  }
}

class DelayedReadyCdpDriver extends FakeCdpDriver {
  refusedAttempts = 0;
  constructor(private failuresRemaining = 2) { super(); }

  async listPages(port: number): Promise<readonly BrowserPageSummary[]> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      this.refusedAttempts += 1;
      throw new Error('browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:43210');
    }
    return await super.listPages(port);
  }
}

async function configuredRuntime(
  root: string,
  profileController?: FakeProcessController,
  cdpDriver?: FakeCdpDriver
) {
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const controller = profileController ?? new FakeProcessController(path.join(root, 'browser'));
  const cdp = cdpDriver ?? new FakeCdpDriver();
  const browser = new BrowserRuntime(path.join(root, 'browser'), controller, artifacts, cdp, executable);
  await browser.init();
  return { browser, controller, cdp, artifacts };
}

test('browser start surfaces early owned-process diagnostics before CDP timeout', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const controller = new EarlyExitProcessController();
  const browser = new BrowserRuntime(
    path.join(root, 'browser'),
    controller,
    artifacts,
    new FakeCdpDriver(),
    executable
  );
  await browser.init();

  const startedAt = Date.now();
  await assert.rejects(
    browser.start({ profile_id: 'early-exit-diagnostics', timeout_ms: 5000 }),
    error => {
      assert.match(String(error), /exited before publishing a CDP port/i);
      assert.match(String(error), /side-by-side configuration is incorrect/i);
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 2000, 'Early browser exit should fail before the CDP timeout.');
  assert.deepEqual(controller.terminated, ['early-exit-process']);
  await browser.closeAll();
});

test('browser start waits for CDP readiness after DevToolsActivePort is published', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const cdp = new DelayedReadyCdpDriver(2);
  const { browser, controller } = await configuredRuntime(root, undefined, cdp);

  const started = await browser.start({ profile_id: 'cdp-readiness-race', timeout_ms: 1000 });
  assert.equal(started.active, true);
  assert.equal(cdp.refusedAttempts, 2);
  assert.deepEqual(controller.terminated, []);
  await browser.close(started.session_id);
});
test('owned browser process controller constrains the whole process tree to an Agent Desktop lease', async () => {
  const leaseId = '44444444-4444-4444-8444-444444444444';
  const placements: Array<{ pid: number; leaseId: string; timeoutMs?: number }> = [];
  const asserted: string[] = [];
  const startCalls: unknown[][] = [];
  let listedText = '';
  let listCalls = 0;
  const bridge = {
    async startProcess(...args: unknown[]) { startCalls.push(args); return { isError: false, text: 'Process started with PID 4242' }; },
    async listProcessSessions() { listCalls += 1; return { isError: false, text: listedText }; },
    async forceTerminateProcess() { return { isError: false, text: 'terminated' }; }
  } as unknown as DesktopBackendBridge;
  const agentDesktop = {
    async assertLease(id: string) { asserted.push(id); return {}; },
    async placeProcessTreeWindows(pid: number, id: string, options: { timeoutMs?: number } = {}) {
      placements.push({ pid, leaseId: id, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
      return { processId: pid, moved: 1, windows: [{ hwnd: '1', desktopId: 'desktop-2' }] };
    }
  } as unknown as AgentDesktopManager;
  const controller = new OwnedBrowserProcessController(bridge, new ProcessSessionRegistry(), agentDesktop);

  const sessionId = await controller.start('Write-Output test', leaseId);
  assert.match(sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0]?.[5], 'job');
  assert.deepEqual(placements, []);
  const placedDuringStartup = await controller.place(sessionId, leaseId, 250, false);
  assert.deepEqual(placedDuringStartup, { moved: 1, windows: 1 });
  assert.equal(listCalls, 0, 'startup placement must not reconcile against eventually-consistent backend session listing');
  listedText = 'PID: 4242';
  const placedAfterStartup = await controller.place(sessionId, leaseId, 250);
  assert.deepEqual(placedAfterStartup, { moved: 1, windows: 1 });
  assert.equal(listCalls, 1);
  assert.deepEqual(placements, [
    { pid: 4242, leaseId, timeoutMs: 250 },
    { pid: 4242, leaseId, timeoutMs: 250 }
  ]);
  assert.deepEqual(asserted, [leaseId, leaseId, leaseId, leaseId, leaseId, leaseId]);
});

test('browser runtime is disabled until an executable is configured locally', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const browserRoot = path.join(root, 'browser');
  const controller = new FakeProcessController(browserRoot);
  const browser = new BrowserRuntime(browserRoot, controller, artifacts, new FakeCdpDriver(), '');
  await browser.init();
  assert.equal(browser.info().configured, false);
  await assert.rejects(() => browser.start({ profile_id: 'test' }), /Settings → Browser Automation.*development override/i);
  assert.equal(controller.starts.length, 0);
});

test('browser session owns a dedicated profile and never places navigation URL in the launch command', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, controller, cdp } = await configuredRuntime(root);
  const started = await browser.start({
    profile_id: 'research',
    url: 'https://example.com/?q=a%26b',
    headless: true,
    viewport: { width: 1280, height: 720 }
  });
  assert.equal(started.profile_id, 'research');
  assert.equal(started.persistent_profile, true);
  assert.equal(started.url, 'https://example.com/?q=a%26b');
  assert.equal(controller.starts.length, 1);
  const command = controller.starts[0]!;
  assert.match(command, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(command, /--remote-debugging-port=0/);
  assert.match(command, /--headless=new/);
  assert.doesNotMatch(command, /--do-not-de-elevate/);
  assert.match(command, /about:blank/);
  assert.doesNotMatch(command, /example\.com/);
  assert.equal(cdp.actions.length, 1);
  assert.equal(cdp.actions[0]![0]!.type, 'goto');

  await assert.rejects(() => browser.start({ profile_id: 'research' }), /already in use/i);
  const closed = await browser.close(started.session_id);
  assert.equal(closed.closed, true);
  assert.equal(controller.terminated.length, 1);
  assert.equal((await stat(path.join(root, 'browser', 'profiles', 'research'))).isDirectory(), true);
});

test('browser snapshot publishes screenshot through verified Artifact store', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, artifacts } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'snapshot' });
  const snapshot = await browser.snapshot(started.session_id, started.page_id, { screenshot: true });
  assert.equal(snapshot.text, 'Browser snapshot text');
  assert.equal(snapshot.interactive_elements[0]?.selector, '#link');
  assert.ok(snapshot.screenshot);
  assert.equal(snapshot.screenshot?.mime_type, 'image/png');
  const verified = await artifacts.get(snapshot.screenshot!.artifact_id);
  assert.equal(verified.sha256, snapshot.screenshot!.sha256);
  const read = await readFile(path.join(root, 'artifacts', snapshot.screenshot!.artifact_id, 'payload'));
  assert.deepEqual([...read], [137, 80, 78, 71, 13, 10, 26, 10]);
  await browser.closeAll();
});

test('ephemeral browser profile is removed on close and act returns a fresh snapshot', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const started = await browser.start();
  assert.equal(started.persistent_profile, false);
  const profileDir = path.join(root, 'browser', 'profiles', started.profile_id);
  assert.equal((await stat(profileDir)).isDirectory(), true);
  const observed = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });
  const result = await browser.act(started.session_id, started.page_id, observed.browser_observation_id, [
    { type: 'click', selector: '#link' },
    { type: 'wait', duration_ms: 1 }
  ], { screenshot: false });
  assert.equal(result.page_id, 'page-1');
  assert.equal(result.screenshot, undefined);
  assert.equal(cdp.actions.at(-1)?.length, 2);
  await browser.close(started.session_id);
  await assert.rejects(() => stat(profileDir), /ENOENT/);
});

test('browser observations are one-shot and reject stale page state', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'observation' });

  const fresh = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });
  assert.match(fresh.browser_observation_id, /^[0-9a-f-]{36}$/i);
  const acted = await browser.act(
    started.session_id,
    started.page_id,
    fresh.browser_observation_id,
    [{ type: 'wait', duration_ms: 0 }],
    { screenshot: false }
  );
  assert.notEqual(acted.browser_observation_id, fresh.browser_observation_id);
  await assert.rejects(
    browser.act(started.session_id, started.page_id, fresh.browser_observation_id, [{ type: 'wait', duration_ms: 0 }], { screenshot: false }),
    /already-consumed|already used|unknown/i
  );

  const stale = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });
  cdp.stateTokenValue = 'state-2';
  await assert.rejects(
    browser.act(started.session_id, started.page_id, stale.browser_observation_id, [{ type: 'click', selector: '#link' }], { screenshot: false }),
    /STALE browser observation/i
  );
  await browser.closeAll();
});


class GatedActionDriver extends FakeCdpDriver {
  readonly actionEntered: Promise<void>;
  private signalEntered!: () => void;
  private resume!: () => void;
  readonly releaseAction: () => void;
  constructor() {
    super();
    this.actionEntered = new Promise(resolve => { this.signalEntered = resolve; });
    const resumePromise = new Promise<void>(resolve => { this.resume = resolve; });
    this.releaseAction = () => this.resume();
    this.waitForRelease = resumePromise;
  }
  private readonly waitForRelease: Promise<void>;
  override async act(port: number, pageId: string | undefined, actions: readonly BrowserAction[]): Promise<string> {
    this.signalEntered();
    await this.waitForRelease;
    return super.act(port, pageId, actions);
  }
}

test('same-session snapshot waits for in-flight action while independent browser sessions remain parallel', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const driver = new GatedActionDriver();
  const controller = new FakeProcessController(path.join(root, 'browser'));
  const { browser } = await configuredRuntime(root, controller, driver);
  const first = await browser.start({ profile_id: 'gate-first' });
  const second = await browser.start({ profile_id: 'gate-second' });
  const observed = await browser.snapshot(first.session_id, first.page_id, { screenshot: false });
  const inFlight = browser.act(first.session_id, first.page_id, observed.browser_observation_id, [{ type: 'click', selector: '#link' }], { screenshot: false });
  await driver.actionEntered;

  let firstSnapshotSettled = false;
  const queuedSnapshot = browser.snapshot(first.session_id, first.page_id, { screenshot: false }).then(value => {
    firstSnapshotSettled = true;
    return value;
  });
  const unrelated = await browser.snapshot(second.session_id, second.page_id, { screenshot: false });
  assert.equal(unrelated.session_id, second.session_id);
  assert.equal(firstSnapshotSettled, false, 'same-session snapshot must not interleave with action');

  driver.releaseAction();
  await inFlight;
  await queuedSnapshot;
  assert.equal(firstSnapshotSettled, true);
  await browser.closeAll();
});


test('closing a browser session waits for its in-flight action instead of terminating the owned process', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const driver = new GatedActionDriver();
  const controller = new FakeProcessController(path.join(root, 'browser'));
  const { browser } = await configuredRuntime(root, controller, driver);
  const session = await browser.start({ profile_id: 'gate-close' });
  const observed = await browser.snapshot(session.session_id, session.page_id, { screenshot: false });
  const inFlight = browser.act(session.session_id, session.page_id, observed.browser_observation_id, [{ type: 'fill', selector: '#input', value: 'hello' }], { screenshot: false });
  await driver.actionEntered;

  let closedSettled = false;
  const close = browser.close(session.session_id).then(value => {
    closedSettled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(controller.terminated.length, 0);
  assert.equal(closedSettled, false);
  driver.releaseAction();
  await inFlight;
  assert.equal((await close).closed, true);
  assert.equal(controller.terminated.length, 1);
  await browser.closeAll();
});


test('session FIFO refuses queue floods without affecting another browser session', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive:true,force:true })); });
  const driver = new GatedActionDriver();
  const controller = new FakeProcessController(path.join(root,'browser'));
  const { browser } = await configuredRuntime(root,controller,driver);
  const first = await browser.start({profile_id:'queue-flood-one'});
  const second = await browser.start({profile_id:'queue-flood-two'});
  const firstSnapshot = await browser.snapshot(first.session_id,first.page_id,{screenshot:false});
  const running = browser.act(first.session_id,first.page_id,firstSnapshot.browser_observation_id,
    [{type:'fill',selector:'#input',value:'hold'}],{screenshot:false});
  await driver.actionEntered;
  const queued=Array.from({length:31},()=>browser.snapshot(first.session_id,first.page_id,{screenshot:false}));
  await assert.rejects(browser.snapshot(first.session_id,first.page_id,{screenshot:false}),/operation queue is full/i);
  const independent = await browser.snapshot(second.session_id,second.page_id,{screenshot:false});
  assert.equal(independent.session_id,second.session_id);
  driver.releaseAction();
  await running;
  const results = await Promise.all(queued);
  assert.equal(results.length,31);
  const later = await browser.snapshot(first.session_id,first.page_id,{screenshot:false});
  assert.equal(later.session_id,first.session_id);
  await browser.closeAll();
});

test('candidate handoff denies agent reads, writes and inventory until trusted local resume', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, {recursive:true,force:true})); });
  const executable=path.join(root,'configured-browser.exe');
  await writeFile(executable,'fixture binary','utf8');
  const artifacts=new ArtifactStore(path.join(root,'artifacts'));
  await artifacts.init();
  const browserRoot=path.join(root,'browser');
  const controller=new FakeProcessController(browserRoot);
  const leaseId='99999999-9999-4999-8999-999999999999';
  const desktop={
    async assertLease(id: string) { assert.equal(id,leaseId); return {}; },
    async isLeaseActive(id: string) { return id===leaseId; }
  } as unknown as AgentDesktopManager;
  let browser!: BrowserRuntime;
  const boundary=createBrowserHandoffBoundary(id=>browser.invalidateForLocalHandoff(id));
  browser=new BrowserRuntime(browserRoot,controller,artifacts,new FakeCdpDriver(),executable,desktop,undefined,boundary.agent);
  await browser.init();
  const session=await browser.start({profile_id:'local-handoff-check',agent_desktop_lease_id:leaseId});
  const old=await browser.snapshot(session.session_id,session.page_id,{screenshot:false});
  const started=await browser.requestLocalBrowserHandoff(session.session_id);
  assert.equal(started.state,'handoff-requested');
  assert.equal((await browser.list()).length,0,'agent inventory cannot reveal an active handoff');
  assert.equal((await browser.listProfiles()).length,0,'agent cannot see human-owned profile identifiers');
  await assert.rejects(browser.snapshot(session.session_id,session.page_id,{screenshot:false}),/human control/i);
  await assert.rejects(browser.find(session.session_id,session.page_id,{query:'password'}),/human control/i);
  await assert.rejects(browser.act(session.session_id,session.page_id,old.browser_observation_id,[{type:'click',selector:'#go'}],{screenshot:false}),/human control/i);
  await assert.rejects(browser.newPage(session.session_id),/human control/i);
  await assert.rejects(browser.close(session.session_id),/human control/i);
  await assert.rejects(browser.runGuardedWorkflow(session.session_id,session.page_id,old.browser_observation_id,[
    {action:{type:'click',selector:'#go'},expected_url:'https://example.com/'}
  ]),/human control/i);
  assert.equal(boundary.local.accept(session.session_id).state,'human');
  await assert.rejects(browser.snapshot(session.session_id,session.page_id,{screenshot:false}),/human control/i);
  const resumed=boundary.local.resume(session.session_id);
  assert.equal(resumed.state,'agent');
  await assert.rejects(browser.act(session.session_id,session.page_id,old.browser_observation_id,
    [{type:'click',selector:'#go'}],{screenshot:false}),/consumed|expired|unknown/i);
  const fresh=await browser.snapshot(session.session_id,session.page_id,{screenshot:false});
  assert.equal(fresh.session_id,session.session_id);
  await browser.closeAll();
});

test('candidate handoff requires a dedicated visible lease and rejects invalid local transitions', async t => {
  const root=await tempRoot();
  t.after(async()=>{ await import('node:fs/promises').then(fs=>fs.rm(root,{recursive:true,force:true})); });
  const {browser,controller} = await configuredRuntime(root);
  const plain = await browser.start({profile_id:'handoff-headless-denied'});
  await assert.rejects(browser.requestLocalBrowserHandoff(plain.session_id),/not configured/i);
  await browser.closeAll();
  const transitions: string[]=[];
  const boundary=createBrowserHandoffBoundary(id=>{transitions.push(id);});
  const session='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(boundary.agent.status(session).state,'agent');
  assert.throws(()=>boundary.local.accept(session),/Invalid browser handoff transition/);
  assert.throws(()=>boundary.local.resume(session),/Invalid browser handoff transition/);
  boundary.agent.request(session);
  assert.throws(()=>boundary.agent.assertAgentAccess(session),/human control/i);
  assert.equal(boundary.local.reject(session).state,'agent');
  assert.equal(boundary.agent.epoch(session),2);
  boundary.agent.request(session);
  boundary.local.accept(session);
  assert.equal(boundary.agent.status(session).state,'human');
  boundary.local.resume(session);
  assert.equal(boundary.agent.status(session).state,'agent');
  assert.equal(transitions.length,5);
  assert.equal(boundary.agent.status(session).epoch,5);
  assert.equal(controller.terminated.length,1);
});

test('failed handoff revocation callback cannot restore agent access', () => {
  const session='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let rejectResume=false;
  const boundary=createBrowserHandoffBoundary(()=>{
    if (rejectResume) throw new Error('INJECTED_REVOKE_FAILURE');
  });
  boundary.agent.request(session);
  boundary.local.accept(session);
  rejectResume=true;
  assert.throws(()=>boundary.local.resume(session),/INJECTED_REVOKE_FAILURE/);
  assert.equal(boundary.agent.status(session).state,'human');
  assert.throws(()=>boundary.agent.assertAgentAccess(session),/human control/i);
});

test('handoff request on a configured headless session refuses ownership change', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, {recursive:true,force:true})); });
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'fixture binary', 'utf8');
  const artifacts = new ArtifactStore(path.join(root,'artifacts'));
  await artifacts.init();
  let browser!: BrowserRuntime;
  const boundary=createBrowserHandoffBoundary(id=>browser.invalidateForLocalHandoff(id));
  const browserRoot=path.join(root,'browser');
  browser=new BrowserRuntime(browserRoot,new FakeProcessController(browserRoot),artifacts,new FakeCdpDriver(),executable,undefined,undefined,boundary.agent);
  await browser.init();
  const session=await browser.start({profile_id:'headless-handoff-must-fail'});
  await assert.rejects(browser.requestLocalBrowserHandoff(session.session_id),/dedicated Agent Desktop lease/i);
  assert.equal(boundary.agent.status(session.session_id).state,'agent');
  assert.equal((await browser.list()).length,1);
  await browser.closeAll();
});

test('browser session inventory rechecks ownership when local handoff happens during CDP listPages', async t => {
  const root=await tempRoot();
  t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(root,{recursive:true,force:true}));});
  class BlockingInventoryDriver extends FakeCdpDriver {
    barrier: {entered:Promise<void>;signal:()=>void;release:()=>void;wait:Promise<void>}|undefined;
    override async listPages(port:number): Promise<readonly BrowserPageSummary[]> {
      if (this.barrier) {
        const b=this.barrier;
        this.barrier=undefined;
        b.signal();
        await b.wait;
      }
      return super.listPages(port);
    }
  }
  const executable=path.join(root,'configured-browser.exe');
  await writeFile(executable,'fixture binary','utf8');
  const artifacts=new ArtifactStore(path.join(root,'artifacts'));
  await artifacts.init();
  const driver=new BlockingInventoryDriver();
  const browserRoot=path.join(root,'browser');
  let browser!:BrowserRuntime;
  const boundary=createBrowserHandoffBoundary(id=>browser.invalidateForLocalHandoff(id));
  const controller=new FakeProcessController(browserRoot);
  browser=new BrowserRuntime(browserRoot,controller,artifacts,driver,executable,undefined,undefined,boundary.agent);
  await browser.init();
  const session=await browser.start({profile_id:'inventory-handoff-race'});
  let signal!:()=>void;
  let release!:()=>void;
  const entered=new Promise<void>(resolve=>{signal=resolve;});
  const wait=new Promise<void>(resolve=>{release=resolve;});
  driver.barrier={entered,signal,release,wait};
  const pendingList=browser.list();
  await entered;
  boundary.agent.request(session.session_id); // Emulates synchronous revocation in a trusted local channel.
  release();
  const inventory=await pendingList;
  assert.equal(inventory.length,0,'cannot disclose a tab read under an earlier control epoch');
  assert.equal((await browser.list()).length,0);
  await browser.closeAll();
});

test('guarded browser workflow performs two fresh-observation mutations without requiring repeated MCP roundtrips', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const session = await browser.start({ profile_id: 'guarded-two' });
  const observed = await browser.snapshot(session.session_id, session.page_id, { screenshot: false });
  const result = await browser.runGuardedWorkflow(session.session_id, session.page_id, observed.browser_observation_id, [
    { action: { type: 'fill', selector: '#input', value: 'hello' }, expected_url: 'https://example.com/' },
    { action: { type: 'click', selector: '#go' }, expected_url: 'https://example.com/', expected_text: 'Browser snapshot', after_text: 'Browser snapshot' }
  ]);
  assert.equal(result.completed_steps, 2);
  assert.equal(result.final_snapshot.session_id, session.session_id);
  assert.equal(cdp.actions.length, 2);
  assert.deepEqual(cdp.actions.map(batch => batch[0]?.type), ['fill', 'click']);
  await assert.rejects(
    browser.act(session.session_id, session.page_id, observed.browser_observation_id, [{type:'click',selector:'#go'}], { screenshot:false }),
    /consumed|expired|unknown/i
  );
  await browser.closeAll();
});

test('guarded browser workflow stops before a mismatched page guard; later clicks are not sent', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const session = await browser.start({ profile_id: 'guarded-stop' });
  const first = await browser.snapshot(session.session_id, session.page_id, { screenshot: false });
  await assert.rejects(
    browser.runGuardedWorkflow(session.session_id, session.page_id, first.browser_observation_id, [
      { action: { type: 'fill', selector: '#input', value: 'one' }, expected_url: 'https://example.com/' },
      { action: { type: 'click', selector: '#go' }, expected_url: 'https://example.com/other' }
    ]),
    error => {
      assert.ok(error instanceof Error);
      const details = error as Error & {completed_steps: number; step_index: number; dispatch_uncertain: boolean};
      assert.equal(details.name, 'BrowserWorkflowInterrupted');
      assert.equal(details.completed_steps, 1);
      assert.equal(details.step_index, 1);
      assert.equal(details.dispatch_uncertain, false);
      return true;
    }
  );
  assert.deepEqual(cdp.actions.map(batch=>batch[0]?.type), ['fill']);
  await browser.closeAll();
});

test('guarded browser workflow validates every future step before consuming the initial observation', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const session = await browser.start({ profile_id: 'guarded-validate' });
  const observation = await browser.snapshot(session.session_id, session.page_id, { screenshot: false });
  await assert.rejects(browser.runGuardedWorkflow(session.session_id, session.page_id, observation.browser_observation_id, [
    { action: { type:'click', selector:'#go' }, expected_url:'https://example.com/' },
    { action: { type:'click', selector:'#go' }, expected_url:'*' }
  ]), /requires a bounded exact HTTP/);
  const accepted = await browser.act(session.session_id, session.page_id, observation.browser_observation_id,
    [{ type:'click', selector:'#go' }], { screenshot: false });
  assert.ok(accepted.browser_observation_id);
  assert.equal(cdp.actions.length, 1);
  await browser.closeAll();
});

test('guarded browser workflow reports unknown delivery without automatically replaying a failing action', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  class AmbiguousDeliveryDriver extends FakeCdpDriver {
    override async act(port: number, pageId: string | undefined, actions: readonly BrowserAction[]): Promise<string> {
      await super.act(port,pageId,actions);
      throw new Error('Injected transport disconnect after delivery');
    }
  }
  const cdp = new AmbiguousDeliveryDriver();
  const { browser } = await configuredRuntime(root, undefined, cdp);
  const session = await browser.start({ profile_id: 'guarded-ambiguous' });
  const observation = await browser.snapshot(session.session_id, session.page_id, { screenshot: false });
  await assert.rejects(browser.runGuardedWorkflow(session.session_id,session.page_id,observation.browser_observation_id,[
    { action: { type:'click', selector:'#go' },expected_url:'https://example.com/' },
    { action: { type:'click', selector:'#go' },expected_url:'https://example.com/' }
  ]), error => {
    assert.ok(error instanceof Error);
    const details = error as Error & {completed_steps: number; step_index: number; dispatch_uncertain: boolean};
    assert.equal(details.name, 'BrowserWorkflowInterrupted');
    assert.equal(details.completed_steps, 0);
    assert.equal(details.step_index, 0);
    assert.equal(details.dispatch_uncertain, true);
    return true;
  });
  assert.equal(cdp.actions.length, 1, 'no unsafe replay after uncertain click delivery');
  await browser.closeAll();
});

test('guarded browser workflow refuses a stale starting observation before any mutation', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const session = await browser.start({ profile_id: 'guarded-stale' });
  const observation = await browser.snapshot(session.session_id, session.page_id, { screenshot: false });
  cdp.stateTokenValue = 'changed-state';
  await assert.rejects(browser.runGuardedWorkflow(session.session_id, session.page_id, observation.browser_observation_id, [
    { action: {type:'click',selector:'#go'}, expected_url:'https://example.com/' }
  ]), error => {
    assert.ok(error instanceof Error);
    const details = error as Error & {completed_steps: number; step_index: number; dispatch_uncertain: boolean};
    assert.equal(details.name,'BrowserWorkflowInterrupted');
    assert.equal(details.dispatch_uncertain,false);
    assert.equal(details.completed_steps,0);
    return true;
  });
  assert.equal(cdp.actions.length,0);
  await browser.closeAll();
});


test('guarded workflow fails closed for snapshot refs and preserves the caller observation', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive:true, force:true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const session = await browser.start({ profile_id:'guarded-no-ref' });
  const observation = await browser.snapshot(session.session_id,session.page_id,{screenshot:false});
  await assert.rejects(browser.runGuardedWorkflow(session.session_id,session.page_id,observation.browser_observation_id,[
    {action:{type:'click',ref:'e1'},expected_url:'https://example.com/'}
  ]), /requires a stable selector/);
  await browser.act(session.session_id,session.page_id,observation.browser_observation_id,
    [{type:'click',selector:'#go'}],{screenshot:false});
  assert.equal(cdp.actions.length,1);
  await browser.closeAll();
});

test('guarded workflow failed postcondition stops before dispatching later mutations', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive:true, force:true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const session = await browser.start({ profile_id:'guarded-after-failure' });
  const observation = await browser.snapshot(session.session_id,session.page_id,{screenshot:false});
  await assert.rejects(browser.runGuardedWorkflow(session.session_id,session.page_id,observation.browser_observation_id,[
    {action:{type:'fill',selector:'#input',value:'hello'},expected_url:'https://example.com/',after_text:'NOT_IN_PAGE'},
    {action:{type:'click',selector:'#go'},expected_url:'https://example.com/'}
  ]), error => {
    assert.ok(error instanceof Error);
    const details = error as Error & {completed_steps:number;step_index:number;dispatch_uncertain:boolean};
    assert.equal(details.completed_steps,1);
    assert.equal(details.step_index,0);
    assert.equal(details.dispatch_uncertain,false);
    assert.match(details.message,/Never automatically replay/i);
    return true;
  });
  assert.deepEqual(cdp.actions.map(batch=>batch[0]?.type),['fill']);
  await browser.closeAll();
});

test('guarded workflow owns one session gate across both mutations while unrelated sessions remain usable', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive:true,force:true })); });
  const driver = new GatedActionDriver();
  const controller = new FakeProcessController(path.join(root,'browser'));
  const { browser } = await configuredRuntime(root,controller,driver);
  const first = await browser.start({profile_id:'workflow-lock-one'});
  const second = await browser.start({profile_id:'workflow-lock-two'});
  const observed = await browser.snapshot(first.session_id,first.page_id,{screenshot:false});
  const running = browser.runGuardedWorkflow(first.session_id,first.page_id,observed.browser_observation_id,[
    {action:{type:'fill',selector:'#input',value:'start'},expected_url:'https://example.com/'},
    {action:{type:'click',selector:'#go'},expected_url:'https://example.com/'}
  ]);
  await driver.actionEntered;
  let sameSessionFinished=false;
  const queued=browser.snapshot(first.session_id,first.page_id,{screenshot:false}).then(value=>{
    sameSessionFinished=true;
    return value;
  });
  const other=await browser.snapshot(second.session_id,second.page_id,{screenshot:false});
  assert.equal(other.session_id,second.session_id);
  assert.equal(sameSessionFinished,false);
  driver.releaseAction();
  const outcome=await running;
  assert.equal(outcome.completed_steps,2);
  await queued;
  assert.equal(sameSessionFinished,true);
  assert.deepEqual(driver.actions.map(batch=>batch[0]?.type),['fill','click']);
  await browser.closeAll();
});

test('one browser observation authorizes at most one mutating action', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'single-mutation' });
  const observed = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });

  await assert.rejects(
    browser.act(started.session_id, started.page_id, observed.browser_observation_id, [
      { type: 'click', selector: '#link' },
      { type: 'fill', selector: '#input', value: 'changed' }
    ], { screenshot: false }),
    /at most one state-mutating action/i
  );
  assert.equal(cdp.actions.length, 0);

  const accepted = await browser.act(
    started.session_id,
    started.page_id,
    observed.browser_observation_id,
    [{ type: 'click', selector: '#link' }, { type: 'wait', duration_ms: 0 }],
    { screenshot: false }
  );
  assert.equal(accepted.page_id, 'page-1');
  assert.equal(cdp.actions.length, 1);
  await browser.closeAll();
});

test('browser page lifecycle can create and close tabs without allowing the last page to disappear', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'page-lifecycle' });
  const observation = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });

  const created = await browser.newPage(started.session_id, 'https://example.com/new');
  assert.equal(created.page_id, 'page-2');
  assert.equal(created.pages.length, 2);
  await assert.rejects(
    browser.act(started.session_id, started.page_id, observation.browser_observation_id, [{ type: 'wait', duration_ms: 0 }], { screenshot: false }),
    /already-consumed|already used|unknown/i
  );

  const closed = await browser.closePage(started.session_id, created.page_id);
  assert.equal(closed.closed, true);
  assert.equal(closed.pages.length, 1);
  await assert.rejects(
    browser.closePage(started.session_id, started.page_id),
    /last controllable browser page/i
  );
  await browser.closeAll();
});

test('browser dialog recovery invalidates old observations and requires a fresh snapshot', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'dialog-recovery' });
  const observed = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });

  const handled = await browser.handleDialog(started.session_id, started.page_id, true, 'approved');
  assert.equal(handled.handled, true);
  assert.equal(handled.observation_required_before_next_action, true);
  assert.deepEqual(cdp.dialogs, [{ pageId: 'page-1', accept: true, promptText: 'approved' }]);
  await assert.rejects(
    browser.act(started.session_id, started.page_id, observed.browser_observation_id, [{ type: 'wait', duration_ms: 0 }], { screenshot: false }),
    /already-consumed|already used|unknown/i
  );
  const fresh = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });
  assert.notEqual(fresh.browser_observation_id, observed.browser_observation_id);
  await browser.closeAll();
});

test('persistent browser profile lock blocks another Gateway runtime until release', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifactsA = new ArtifactStore(path.join(root, 'artifacts-a'));
  const artifactsB = new ArtifactStore(path.join(root, 'artifacts-b'));
  await artifactsA.init();
  await artifactsB.init();
  const browserRoot = path.join(root, 'browser');
  const browserA = new BrowserRuntime(browserRoot, new FakeProcessController(browserRoot), artifactsA, new FakeCdpDriver(), executable);
  const browserB = new BrowserRuntime(browserRoot, new FakeProcessController(browserRoot), artifactsB, new FakeCdpDriver(), executable);
  await browserA.init();
  await browserB.init();

  const first = await browserA.start({ profile_id: 'shared-profile' });
  const activePortPath = path.join(browserRoot, 'profiles', 'shared-profile', 'DevToolsActivePort');
  await writeFile(activePortPath, 'FIRST_GATEWAY_ACTIVE_PORT\n', 'utf8');
  await assert.rejects(
    browserB.start({ profile_id: 'shared-profile' }),
    /already owned by another DeskMCP Gateway|still initializing/i
  );
  assert.equal(await readFile(activePortPath, 'utf8'), 'FIRST_GATEWAY_ACTIVE_PORT\n');
  await browserA.close(first.session_id);
  const second = await browserB.start({ profile_id: 'shared-profile' });
  assert.equal(second.profile_id, 'shared-profile');
  await browserB.close(second.session_id);
});

test('browser close keeps profile ownership when owned process termination fails', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const browserRoot = path.join(root, 'browser');
  const controller = new FakeProcessController(browserRoot);
  const { browser } = await configuredRuntime(root, controller);
  const started = await browser.start({ profile_id: 'termination-failure' });

  controller.failTerminate = true;
  await assert.rejects(
    browser.close(started.session_id),
    /INJECTED_BROWSER_TERMINATION_FAILURE/
  );
  assert.equal(browser.info().active_sessions, 1);
  await assert.rejects(
    browser.start({ profile_id: 'termination-failure' }),
    /already in use/i
  );

  controller.failTerminate = false;
  const closed = await browser.close(started.session_id);
  assert.equal(closed.closed, true);
  const replacement = await browser.start({ profile_id: 'termination-failure' });
  await browser.close(replacement.session_id);
});

test('browser reconciliation removes sessions whose owned process has disappeared', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, controller } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'reconcile' });
  controller.activeIds.clear();
  const sessions = await browser.list();
  assert.equal(sessions.length, 0);
  const closed = await browser.close(started.session_id);
  assert.equal(closed.closed, false);
});


test('idle direct browser sessions are automatically reaped and ephemeral profiles are removed', async t => {
  const root = await tempRoot();
  const browserRoot = path.join(root, 'browser');
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const controller = new FakeProcessController(browserRoot);
  const browser = new BrowserRuntime(browserRoot, controller, artifacts, new FakeCdpDriver(), executable, undefined, 1000);
  await browser.init();
  t.after(async () => {
    await browser.closeAll().catch(() => undefined);
    await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }));
  });

  const started = await browser.start();
  const profileDir = path.join(browserRoot, 'profiles', started.profile_id);
  assert.equal((await stat(profileDir)).isDirectory(), true);

  const internalRecord = (browser as unknown as {
    sessions: Map<string, { profileLock: { release(): Promise<void> } }>
  }).sessions.get(started.session_id);
  assert.ok(internalRecord);
  const releaseProfileLock = internalRecord.profileLock.release.bind(internalRecord.profileLock);
  internalRecord.profileLock.release = async () => {
    await assert.rejects(() => stat(profileDir), /ENOENT/);
    await releaseProfileLock();
  };

  const deadline = Date.now() + 3500;
  while ((await browser.list()).length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  assert.equal((await browser.list()).length, 0);
  assert.deepEqual(controller.terminated, ['process-1']);
  await assert.rejects(() => stat(profileDir), /ENOENT/);
});


test('expired Agent Desktop placement detaches without closing the browser session', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const browserRoot = path.join(root, 'browser');
  const controller = new FakeProcessController(browserRoot);
  const cdp = new FakeCdpDriver();
  const leaseA = '11111111-1111-4111-8111-111111111111';
  const leaseB = '22222222-2222-4222-8222-222222222222';
  const activeLeases = new Set([leaseA, leaseB]);
  const agentDesktop = {
    async assertLease(id: string) {
      if (!activeLeases.has(id)) throw new Error('lease revoked');
      return {};
    },
    async isLeaseActive(id: string) { return activeLeases.has(id); }
  } as unknown as AgentDesktopManager;
  const browser = new BrowserRuntime(browserRoot, controller, artifacts, cdp, executable, agentDesktop);
  await browser.init();

  const sessionA = await browser.start({ profile_id: 'lease-a', agent_desktop_lease_id: leaseA });
  const sessionB = await browser.start({ profile_id: 'lease-b', agent_desktop_lease_id: leaseB });
  assert.deepEqual(controller.leaseIds, [leaseA, leaseB]);
  assert.equal((await browser.list()).length, 2);

  activeLeases.delete(leaseA);
  const deadline = Date.now() + 3000;
  let sessions = await browser.list();
  while (sessions.find(session => session.session_id === sessionA.session_id)?.agent_desktop !== false && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    sessions = await browser.list();
  }

  assert.equal(sessions.length, 2);
  assert.equal(sessions.find(session => session.session_id === sessionA.session_id)?.agent_desktop, false);
  assert.equal(sessions.find(session => session.session_id === sessionB.session_id)?.agent_desktop, true);
  assert.deepEqual(controller.terminated, []);

  const closedA = await browser.close(sessionA.session_id);
  assert.equal(closedA.closed, true);
  assert.deepEqual(controller.terminated, ['process-1']);
  assert.equal((await browser.list()).length, 1);

  await browser.closeAll();
});


test('Agent Desktop browser survives a transient placement refresh failure while the lease stays active', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const browserRoot = path.join(root, 'browser');
  const controller = new FakeProcessController(browserRoot);
  const cdp = new FakeCdpDriver();
  const leaseId = '44444444-4444-4444-8444-444444444444';
  const agentDesktop = {
    async assertLease() { return {}; },
    async isLeaseActive() { return true; }
  } as unknown as AgentDesktopManager;
  const browser = new BrowserRuntime(browserRoot, controller, artifacts, cdp, executable, agentDesktop);
  await browser.init();

  const session = await browser.start({ profile_id: 'transient-placement', agent_desktop_lease_id: leaseId });
  controller.placementErrors.push(new Error('INJECTED_TRANSIENT_AGENT_DESKTOP_PLACEMENT_FAILURE'));

  const deadline = Date.now() + 2500;
  while (controller.placements.filter(row => row.reconcile).length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const sessions = await browser.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.session_id, session.session_id);
  assert.equal(sessions[0]?.agent_desktop, true);
  assert.deepEqual(controller.terminated, []);
  assert.ok(controller.placements.some(row => row.reconcile && row.timeoutMs === 500));

  await browser.closeAll();
});


test('Agent Desktop browser waits until a real window is placed before start succeeds', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const browserRoot = path.join(root, 'browser');
  const controller = new FakeProcessController(browserRoot);
  controller.placementErrors.push(
    new Error('Agent Desktop native operation failed: No stable top-level window remained in the requested process tree before timeout.'),
    new Error('Agent Desktop native operation failed: No stable top-level window remained in the requested process tree before timeout.')
  );
  controller.placementWindows.push(1);
  const cdp = new FakeCdpDriver();
  const leaseId = '55555555-5555-4555-8555-555555555555';
  const agentDesktop = {
    async assertLease() { return {}; },
    async isLeaseActive() { return true; }
  } as unknown as AgentDesktopManager;
  const browser = new BrowserRuntime(browserRoot, controller, artifacts, cdp, executable, agentDesktop);
  await browser.init();

  const started = await browser.start({ profile_id: 'delayed-window', agent_desktop_lease_id: leaseId, timeout_ms: 5000 });
  assert.equal(started.active, true);
  assert.match(controller.starts[0]!, /--do-not-de-elevate/);
  assert.match(controller.starts[0]!, /--start-minimized/);
  assert.ok(controller.placements.length >= 3);
  const startupPlacements = controller.placements.slice(0, 3);
  assert.deepEqual(startupPlacements.map(row => row.leaseId), [leaseId, leaseId, leaseId]);
  assert.deepEqual(startupPlacements.map(row => row.reconcile), [false, false, false]);
  const reconcileCountBeforeNewPage = controller.placements.filter(row => row.reconcile).length;
  await browser.newPage(started.session_id);
  const reconciledPlacements = controller.placements.filter(row => row.reconcile);
  assert.ok(reconciledPlacements.length > reconcileCountBeforeNewPage);
  assert.equal(reconciledPlacements.at(-1)?.leaseId, leaseId);
  assert.deepEqual(controller.terminated, []);
  await browser.closeAll();
});

test('Agent Desktop placed browser can close independently while its placement lease is active', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const browserRoot = path.join(root, 'browser');
  const controller = new FakeProcessController(browserRoot);
  const cdp = new FakeCdpDriver();
  const leaseId = '33333333-3333-4333-8333-333333333333';
  const activeLeases = new Set([leaseId]);
  const agentDesktop = {
    async assertLease(id: string) {
      if (!activeLeases.has(id)) throw new Error('lease revoked');
      return {};
    },
    async isLeaseActive(id: string) { return activeLeases.has(id); }
  } as unknown as AgentDesktopManager;
  const browser = new BrowserRuntime(browserRoot, controller, artifacts, cdp, executable, agentDesktop);
  await browser.init();

  const session = await browser.start({ profile_id: 'lease-lifetime', agent_desktop_lease_id: leaseId });
  assert.equal((await browser.list())[0]?.agent_desktop, true);
  const placementsAfterStart = controller.placements.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(controller.placements.length > placementsAfterStart);

  const closed = await browser.close(session.session_id);
  assert.equal(closed.closed, true);
  assert.equal((await browser.list()).length, 0);
  assert.deepEqual(controller.terminated, ['process-1']);
  await browser.closeAll();
});


test('persistent browser profiles can be listed and deleted only while not owned', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'managed-profile' });

  let profiles = await browser.listProfiles();
  assert.equal(profiles.find(item => item.profile_id === 'managed-profile')?.in_use, true);
  await assert.rejects(browser.deleteProfile('managed-profile'), /already owned by another DeskMCP Gateway|already in use/i);

  await browser.close(started.session_id);
  profiles = await browser.listProfiles();
  assert.equal(profiles.find(item => item.profile_id === 'managed-profile')?.in_use, false);
  const deleted = await browser.deleteProfile('managed-profile');
  assert.deepEqual(deleted, { profile_id: 'managed-profile', deleted: true });
  assert.equal((await browser.listProfiles()).some(item => item.profile_id === 'managed-profile'), false);
});

test('persistent browser profile count is bounded before a new browser process starts', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, controller } = await configuredRuntime(root);
  const profilesRoot = path.join(root, 'browser', 'profiles');
  for (let index = 0; index < 32; index++) {
    await mkdir(path.join(profilesRoot, `profile-${index}`));
  }
  await assert.rejects(
    browser.start({ profile_id: 'overflow-profile' }),
    /at most 32 persistent browser profiles/i
  );
  assert.equal(controller.starts.length, 0);
});


test('browser download is observation-authorized, published as Artifact, and removes temp payload', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp, artifacts } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'download-artifact' });
  const observed = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });

  const result = await browser.download(
    started.session_id,
    started.page_id,
    observed.browser_observation_id,
    undefined,
    'e2',
    { screenshot: false }
  );
  assert.equal(cdp.downloadCalls, 1);
  assert.ok(result.download);
  assert.equal(result.download?.filename, 'download.txt');
  const artifact = await artifacts.read(result.download!.artifact_id, 0, 128, 'utf8');
  assert.equal(artifact.data, 'DESKMCP_BROWSER_DOWNLOAD_TEST');
  const downloadDir = path.join(root, 'browser', 'downloads', started.session_id);
  const leftover = await import('node:fs/promises').then(fs => fs.readdir(downloadDir));
  assert.deepEqual(leftover, []);
  assert.notEqual(result.browser_observation_id, observed.browser_observation_id);
  await browser.closeAll();
});

test('browser download rejects stale observations before invoking the download engine', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'download-stale' });
  const observed = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });
  cdp.stateTokenValue = 'state-changed';
  await assert.rejects(
    browser.download(started.session_id, started.page_id, observed.browser_observation_id, '#download', undefined, { screenshot: false }),
    /STALE browser observation/i
  );
  assert.equal(cdp.downloadCalls, 0);
  await browser.closeAll();
});


test('browser runtime defaults to Playwright and only allows explicit legacy CDP fallback', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const browserRoot = path.join(root, 'browser');
  const controller = new FakeProcessController(browserRoot);
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const previous = process.env.DESKTOP_MCP_BROWSER_ENGINE;
  try {
    delete process.env.DESKTOP_MCP_BROWSER_ENGINE;
    const defaultRuntime = new BrowserRuntime(browserRoot, controller, artifacts, undefined, executable);
    assert.equal(defaultRuntime.info().engine, 'playwright');

    process.env.DESKTOP_MCP_BROWSER_ENGINE = 'legacy-cdp';
    const legacyRuntime = new BrowserRuntime(browserRoot, controller, artifacts, undefined, executable);
    assert.equal(legacyRuntime.info().engine, 'legacy-cdp');

    const injectedRuntime = new BrowserRuntime(browserRoot, controller, artifacts, new FakeCdpDriver(), executable);
    assert.equal(injectedRuntime.info().engine, 'injected');

    process.env.DESKTOP_MCP_BROWSER_ENGINE = 'unknown-engine';
    assert.throws(
      () => new BrowserRuntime(browserRoot, controller, artifacts, undefined, executable),
      /must be either playwright or legacy-cdp/i
    );
  } finally {
    if (previous === undefined) delete process.env.DESKTOP_MCP_BROWSER_ENGINE;
    else process.env.DESKTOP_MCP_BROWSER_ENGINE = previous;
  }
});


test('browser find issues an actionable observation without returning a full page snapshot', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser, cdp } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'find-mode' });
  const found = await browser.find(started.session_id, started.page_id, {
    query: 'Submit',
    max_results: 5,
    timeout_ms: 5000
  });
  assert.equal(found.page_id, started.page_id);
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0]?.ref, 'e2');
  assert.ok(found.browser_observation_id);
  const acted = await browser.act(
    started.session_id,
    started.page_id,
    found.browser_observation_id,
    [{ type: 'click', ref: 'e2' }],
    { screenshot: false }
  );
  assert.equal(acted.page_id, 'page-1');
  assert.equal(cdp.actions.length, 1);
  await assert.rejects(
    browser.act(started.session_id, started.page_id, found.browser_observation_id, [{ type: 'wait', duration_ms: 0 }], { screenshot: false }),
    /already-consumed|unknown/i
  );
  await browser.closeAll();
});

test('browser select_page changes the active page and invalidates older session observations', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const { browser } = await configuredRuntime(root);
  const started = await browser.start({ profile_id: 'select-page' });
  const created = await browser.newPage(started.session_id, 'https://example.com/second');
  const observed = await browser.snapshot(started.session_id, started.page_id, { screenshot: false });
  const selected = await browser.selectPage(started.session_id, created.page_id);
  assert.equal(selected.selected, true);
  assert.equal(selected.page_id, created.page_id);
  assert.equal(selected.observation_required_before_next_action, true);
  assert.equal(selected.pages.find(page => page.page_id === created.page_id)?.active, true);
  await assert.rejects(
    browser.act(started.session_id, started.page_id, observed.browser_observation_id, [{ type: 'wait', duration_ms: 0 }], { screenshot: false }),
    /already-consumed|unknown/i
  );
  await browser.closeAll();
});
