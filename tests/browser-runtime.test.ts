import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
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
  type BrowserProcessController
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

  async terminate(processSessionId: string): Promise<void> {
    this.terminated.push(processSessionId);
    if (this.failTerminate) throw new Error('INJECTED_BROWSER_TERMINATION_FAILURE');
    this.activeIds.delete(processSessionId);
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

async function configuredRuntime(root: string, profileController?: FakeProcessController) {
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const controller = profileController ?? new FakeProcessController(path.join(root, 'browser'));
  const cdp = new FakeCdpDriver();
  const browser = new BrowserRuntime(path.join(root, 'browser'), controller, artifacts, cdp, executable);
  await browser.init();
  return { browser, controller, cdp, artifacts };
}

test('owned browser process controller constrains the whole process tree to an Agent Desktop lease', async () => {
  const leaseId = '44444444-4444-4444-8444-444444444444';
  const placements: Array<{ pid: number; leaseId: string }> = [];
  const asserted: string[] = [];
  const bridge = {
    async startProcess() { return { isError: false, text: 'Process started with PID 4242' }; },
    async listProcessSessions() { return { isError: false, text: 'PID: 4242' }; },
    async forceTerminateProcess() { return { isError: false, text: 'terminated' }; }
  } as unknown as DesktopBackendBridge;
  const agentDesktop = {
    async assertLease(id: string) { asserted.push(id); return {}; },
    async placeProcessTreeWindows(pid: number, id: string) { placements.push({ pid, leaseId: id }); }
  } as unknown as AgentDesktopManager;
  const controller = new OwnedBrowserProcessController(bridge, new ProcessSessionRegistry(), agentDesktop);

  const sessionId = await controller.start('Write-Output test', leaseId);
  assert.match(sessionId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(placements, [{ pid: 4242, leaseId }]);
  assert.deepEqual(asserted, [leaseId, leaseId]);
});

test('browser runtime is disabled until an executable is configured locally', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const browserRoot = path.join(root, 'browser');
  const controller = new FakeProcessController(browserRoot);
  const browser = new BrowserRuntime(browserRoot, controller, artifacts, new FakeCdpDriver(), undefined);
  await browser.init();
  assert.equal(browser.info().configured, false);
  await assert.rejects(() => browser.start({ profile_id: 'test' }), /not configured/i);
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


test('closing an Agent Desktop lease only closes browser sessions owned by that lease', async t => {
  const root = await tempRoot();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const executable = path.join(root, 'configured-browser.exe');
  await writeFile(executable, 'test browser placeholder', 'utf8');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
  await artifacts.init();
  const browserRoot = path.join(root, 'browser');
  const controller = new FakeProcessController(browserRoot);
  const cdp = new FakeCdpDriver();
  const agentDesktop = {
    async assertLease() { return {}; },
    async placeProcessWindows() { }
  } as unknown as AgentDesktopManager;
  const browser = new BrowserRuntime(browserRoot, controller, artifacts, cdp, executable, agentDesktop);
  await browser.init();

  const leaseA = '11111111-1111-4111-8111-111111111111';
  const leaseB = '22222222-2222-4222-8222-222222222222';
  const sessionA = await browser.start({ profile_id: 'lease-a', agent_desktop_lease_id: leaseA });
  const sessionB = await browser.start({ profile_id: 'lease-b', agent_desktop_lease_id: leaseB });
  assert.deepEqual(controller.leaseIds, [leaseA, leaseB]);
  assert.equal((await browser.list()).length, 2);

  const cleanup = await browser.closeAgentDesktopLease(leaseA);
  assert.equal(cleanup.lease_id, leaseA);
  assert.equal(cleanup.closed_sessions, 1);
  assert.deepEqual(controller.terminated, ['process-1']);
  const remaining = await browser.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.session_id, sessionB.session_id);
  assert.notEqual(remaining[0]?.session_id, sessionA.session_id);

  await browser.closeAll();
});


test('Agent Desktop browser stays open until its control lease exits', async t => {
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
    async placeProcessWindows() { },
    async isLeaseActive(id: string) { return activeLeases.has(id); }
  } as unknown as AgentDesktopManager;
  const browser = new BrowserRuntime(browserRoot, controller, artifacts, cdp, executable, agentDesktop);
  await browser.init();

  const session = await browser.start({ profile_id: 'lease-lifetime', agent_desktop_lease_id: leaseId });
  await assert.rejects(
    browser.close(session.session_id),
    /stay open until their Agent Control lease exits/i
  );
  assert.equal((await browser.list()).length, 1);
  assert.deepEqual(controller.terminated, []);

  activeLeases.delete(leaseId);
  const deadline = Date.now() + 3000;
  while ((await browser.list()).length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
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
