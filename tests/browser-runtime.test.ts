import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/artifact-store.js';
import type {
  BrowserAction,
  BrowserCdpDriver,
  BrowserPageSummary,
  BrowserSnapshotData,
  BrowserSnapshotOptions
} from '../src/browser-cdp.js';
import {
  BrowserRuntime,
  type BrowserProcessController
} from '../src/browser-runtime.js';

async function tempRoot(): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'deskmcp-browser-test-')));
}

class FakeProcessController implements BrowserProcessController {
  readonly starts: string[] = [];
  readonly terminated: string[] = [];
  readonly activeIds = new Set<string>();
  private next = 1;

  constructor(private readonly runtimeRoot: string) {}

  async start(command: string): Promise<string> {
    this.starts.push(command);
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
    this.activeIds.delete(processSessionId);
  }
}

class FakeCdpDriver implements BrowserCdpDriver {
  readonly actions: BrowserAction[][] = [];
  readonly pages: BrowserPageSummary[] = [{
    page_id: 'page-1',
    url: 'about:blank',
    title: '',
    active: true
  }];

  async listPages(port: number): Promise<readonly BrowserPageSummary[]> {
    assert.equal(port, 43210);
    return this.pages.map(page => ({ ...page }));
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
      png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    };
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
  const result = await browser.act(started.session_id, started.page_id, [
    { type: 'click', selector: '#link' },
    { type: 'wait', duration_ms: 1 }
  ], { screenshot: false });
  assert.equal(result.page_id, 'page-1');
  assert.equal(result.screenshot, undefined);
  assert.equal(cdp.actions.at(-1)?.length, 2);
  await browser.close(started.session_id);
  await assert.rejects(() => stat(profileDir), /ENOENT/);
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
