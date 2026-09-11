import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Browser, BrowserContext, Dialog, Frame, Locator, Page } from 'playwright-core';
import { PlaywrightBrowserDriver } from '../src/browser-playwright.js';

const PNG_HEADER = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

class FakeLocator {
  constructor(private readonly page: FakePage, readonly selector: string, private readonly index?: number) {}
  async innerText(): Promise<string> { return this.selector === 'body' ? this.page.bodyText : ''; }
  async count(): Promise<number> {
    if (this.selector === 'input[type=password]') return this.page.passwordRefs.length;
    if (this.selector === ':focus') return this.page.focused ? 1 : 0;
    return 1;
  }
  nth(index: number): Locator { return new FakeLocator(this.page, this.selector, index) as unknown as Locator; }
  async ariaSnapshotJSON(): Promise<unknown> {
    if (this.selector === 'input[type=password]' && this.index !== undefined) {
      const ref = this.page.passwordRefs[this.index];
      if (!ref) return [];
      return { role: 'textbox', ref, text: this.page.passwordValues[this.index] ?? '' };
    }
    if (this.selector === ':focus') return this.page.focusAria ?? [];
    return this.page.ariaTree;
  }
  async evaluate(): Promise<unknown> {
    if (this.selector === ':focus') return this.page.focusDom;
    return undefined;
  }
  async click(): Promise<void> {
    this.page.actions.push(`click:${this.selector}`);
    const dialog = this.page.dialogOnClick;
    if (!dialog) return;
    delete this.page.dialogOnClick;
    this.page.emit('dialog', dialog);
    await new Promise<void>(resolve => { this.page.dialogClickRelease = resolve; });
  }
  async hover(): Promise<void> { this.page.actions.push(`hover:${this.selector}`); }
  async dragTo(target: Locator): Promise<void> {
    this.page.actions.push(`drag:${this.selector}->${(target as unknown as FakeLocator).selector}`);
  }
  async fill(value: string): Promise<void> { this.page.actions.push(`fill:${this.selector}:${value}`); }
  async pressSequentially(text: string, options?: { delay?: number }): Promise<void> { this.page.actions.push(`type:${this.selector}:${text}:${options?.delay ?? 0}`); }
  async setChecked(checked: boolean): Promise<void> { this.page.actions.push(`checked:${this.selector}:${checked}`); }
  async press(key: string): Promise<void> { this.page.actions.push(`press:${this.selector}:${key}`); }
  async waitFor(): Promise<void> { this.page.actions.push(`wait:${this.selector}`); }
  async selectOption(value: string): Promise<void> { this.page.actions.push(`select:${this.selector}:${value}`); }
  async setInputFiles(files: string[]): Promise<void> { this.page.actions.push(`files:${this.selector}:${files.join(',')}`); }
}

class FakePage extends EventEmitter {
  closed = false;
  currentUrl = 'https://example.test/';
  currentTitle = 'Example';
  bodyText = 'Example body';
  ariaTree: unknown = {
    role: 'document',
    children: [
      { role: 'button', name: 'Submit', ref: 'e2', box: { x: 10, y: 20, width: 80, height: 30 } },
      { role: 'button', name: 'Frame Action', ref: 'f1e2', box: { x: 5, y: 6, width: 90, height: 25 } }
    ]
  };
  viewport = { width: 1200, height: 800 };
  pageSize = { width: 1200, height: 1000 };
  screenshotBytes = PNG_HEADER;
  screenshotCalls = 0;
  actions: string[] = [];
  passwordRefs: string[] = [];
  passwordValues: string[] = [];
  focused = false;
  focusDom: unknown;
  focusAria: unknown;
  childFrames: FakePage[] = [];
  dialogOnClick?: Dialog;
  dialogClickRelease?: () => void;

  isClosed(): boolean { return this.closed; }
  frames(): Frame[] { return [this as unknown as Frame, ...this.childFrames.map(frame => frame as unknown as Frame)]; }
  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return this.currentTitle; }
  setDefaultTimeout(): void {}
  setDefaultNavigationTimeout(): void {}
  locator(selector: string): Locator { return new FakeLocator(this, selector) as unknown as Locator; }
  getByText(text: string): Locator { return new FakeLocator(this, `text=${text}`) as unknown as Locator; }
  get keyboard(): { press: (key: string) => Promise<void> } {
    return { press: async key => { this.actions.push(`keyboard:${key}`); } };
  }
  async ariaSnapshotJSON(): Promise<unknown> { return this.ariaTree; }
  async evaluate(fn: unknown): Promise<unknown> {
    const source = String(fn);
    if (source.includes('scrollWidth')) return { ...this.pageSize };
    if (source.includes('innerWidth')) return { ...this.viewport };
    return undefined;
  }
  async screenshot(): Promise<Uint8Array> {
    this.screenshotCalls += 1;
    return this.screenshotBytes;
  }
  async goto(url: string): Promise<void> { this.currentUrl = url; this.actions.push(`goto:${url}`); }
  async reload(): Promise<void> { this.actions.push('reload'); }
  async goBack(): Promise<void> { this.actions.push('back'); }
  async goForward(): Promise<void> { this.actions.push('forward'); }
  async waitForTimeout(ms: number): Promise<void> { this.actions.push(`wait-time:${ms}`); }
  async waitForURL(url: string): Promise<void> { this.actions.push(`wait-url:${url}`); }
  async close(): Promise<void> { this.closed = true; this.emit('close'); }
}

class FakeContext extends EventEmitter {
  constructor(readonly pageList: FakePage[]) { super(); }
  pages(): Page[] { return this.pageList.filter(page => !page.closed) as unknown as Page[]; }
  async newPage(): Promise<Page> {
    const page = new FakePage();
    page.currentUrl = 'about:blank';
    page.currentTitle = '';
    this.pageList.push(page);
    this.emit('page', page as unknown as Page);
    return page as unknown as Page;
  }
}

class FakeBrowser extends EventEmitter {
  connected = true;
  closeCalls = 0;
  constructor(readonly context: FakeContext) { super(); }
  contexts(): BrowserContext[] { return [this.context as unknown as BrowserContext]; }
  isConnected(): boolean { return this.connected; }
  async close(): Promise<void> { this.closeCalls += 1; this.connected = false; this.emit('disconnected'); }
}

class FakeDialog {
  accepted: string | undefined;
  dismissed = false;
  constructor(private readonly onHandled?: () => void) {}
  async accept(promptText?: string): Promise<void> {
    this.accepted = promptText ?? '';
    this.onHandled?.();
  }
  async dismiss(): Promise<void> {
    this.dismissed = true;
    this.onHandled?.();
  }
}

function setup() {
  const page = new FakePage();
  const context = new FakeContext([page]);
  const browser = new FakeBrowser(context);
  const endpoints: string[] = [];
  const driver = new PlaywrightBrowserDriver(async (endpoint, options) => {
    endpoints.push(`${endpoint}|${options.timeout}`);
    return browser as unknown as Browser;
  });
  return { driver, page, context, browser, endpoints };
}

test('Playwright driver uses loopback CDP and returns AI refs including cross-frame refs', async () => {
  const { driver, endpoints } = setup();
  const snapshot = await driver.snapshot(43123, undefined, { screenshot: false, timeout_ms: 5000 });
  assert.equal(endpoints[0], 'http://127.0.0.1:43123|5000');
  assert.deepEqual(snapshot.interactive_elements.map(row => row.ref), ['e2', 'f1e2']);
  assert.match(snapshot.state_token, /^aria-v1:[0-9a-f]{64}$/);
});

test('Playwright state token changes when the AI accessibility tree changes', async () => {
  const { driver, page } = setup();
  const before = await driver.stateToken(43124, undefined, 5000);
  page.ariaTree = {
    role: 'document',
    children: [{ role: 'button', name: 'Changed', ref: 'e2', box: { x: 10, y: 20, width: 80, height: 30 } }]
  };
  const after = await driver.stateToken(43124, undefined, 5000);
  assert.notEqual(after, before);
});

test('Playwright screenshot refuses oversized pages before allocating screenshot bytes', async () => {
  const { driver, page } = setup();
  page.pageSize = { width: 5000, height: 5000 };
  await assert.rejects(
    driver.snapshot(43125, undefined, { screenshot: true, full_page: true, timeout_ms: 5000 }),
    /pixel safety budget/i
  );
  assert.equal(page.screenshotCalls, 0);
});

test('Playwright screenshot validates PNG bytes', async () => {
  const { driver, page } = setup();
  page.screenshotBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(
    driver.snapshot(43126, undefined, { screenshot: true, timeout_ms: 5000 }),
    /valid PNG/i
  );
});

test('Playwright dialog handling uses the pending Playwright Dialog object', async () => {
  const { driver, page } = setup();
  const pages = await driver.listPages(43127, 5000);
  const dialog = new FakeDialog();
  page.emit('dialog', dialog as unknown as Dialog);
  await driver.handleDialog(43127, pages[0]!.page_id, true, 'approved', 5000);
  assert.equal(dialog.accepted, 'approved');
  await assert.rejects(
    driver.handleDialog(43127, pages[0]!.page_id, true, undefined, 5000),
    /no pending JavaScript dialog/i
  );
});

test('Playwright page lifecycle never closes the externally owned browser', async () => {
  const { driver, browser } = setup();
  const initial = await driver.listPages(43128, 5000);
  const created = await driver.createPage(43128, 'https://example.test/new', 5000);
  const afterCreate = await driver.listPages(43128, 5000);
  assert.equal(afterCreate.length, 2);
  await driver.closePage(43128, created, 5000);
  assert.equal((await driver.listPages(43128, 5000)).length, 1);
  await assert.rejects(driver.closePage(43128, initial[0]!.page_id, 5000), /last controllable browser page/i);
  assert.equal(browser.closeCalls, 0);
});

test('Playwright aria-ref actions route through Playwright locators', async () => {
  const { driver, page } = setup();
  const pages = await driver.listPages(43129, 5000);
  await driver.act(43129, pages[0]!.page_id, [
    { type: 'click', ref: 'f1e2' },
    { type: 'wait', duration_ms: 0 }
  ], 5000);
  assert.ok(page.actions.includes('click:aria-ref=f1e2'));
});


test('Playwright actions interrupt immediately when a blocking dialog appears', async () => {
  const { driver, page } = setup();
  const pages = await driver.listPages(43130, 5000);
  const dialog = new FakeDialog(() => page.dialogClickRelease?.());
  page.dialogOnClick = dialog as unknown as Dialog;
  await assert.rejects(
    driver.act(43130, pages[0]!.page_id, [{ type: 'click', ref: 'e2' }], 5000),
    /JavaScript dialog is pending/i
  );
  assert.equal(dialog.accepted, undefined);
  await driver.handleDialog(43130, pages[0]!.page_id, true, 'continue', 5000);
  assert.equal(dialog.accepted, 'continue');
});


test('Playwright public snapshot redacts password input values while stale token still detects secret changes', async () => {
  const { driver, page } = setup();
  page.passwordRefs = ['e9'];
  page.passwordValues = ['TOP-SECRET-ONE'];
  page.ariaTree = {
    role: 'document',
    children: [
      { role: 'textbox', name: 'Password', ref: 'e9', text: 'TOP-SECRET-ONE', box: { x: 10, y: 10, width: 200, height: 30 } },
      { role: 'textbox', name: 'Email', ref: 'e10', text: 'user@example.test', box: { x: 10, y: 50, width: 200, height: 30 } }
    ]
  };
  const snapshot = await driver.snapshot(43131, undefined, { screenshot: false, timeout_ms: 5000 });
  assert.doesNotMatch(JSON.stringify(snapshot), /TOP-SECRET-ONE/);
  const password = snapshot.interactive_elements.find(row => row.ref === 'e9');
  const email = snapshot.interactive_elements.find(row => row.ref === 'e10');
  assert.equal(password?.text, undefined);
  assert.equal(email?.text, 'user@example.test');
  const before = snapshot.state_token;
  page.passwordValues = ['TOP-SECRET-TWO'];
  page.ariaTree = {
    role: 'document',
    children: [
      { role: 'textbox', name: 'Password', ref: 'e9', text: 'TOP-SECRET-TWO', box: { x: 10, y: 10, width: 200, height: 30 } },
      { role: 'textbox', name: 'Email', ref: 'e10', text: 'user@example.test', box: { x: 10, y: 50, width: 200, height: 30 } }
    ]
  };
  const after = await driver.stateToken(43131, undefined, 5000);
  assert.notEqual(after, before);
});


test('Playwright hover and drag actions use observation refs, including cross-frame targets', async () => {
  const { driver, page } = setup();
  const pages = await driver.listPages(43132, 5000);
  await driver.act(43132, pages[0]!.page_id, [{ type: 'hover', ref: 'e2' }], 5000);
  await driver.act(43132, pages[0]!.page_id, [{ type: 'drag', source_ref: 'e2', target_ref: 'f1e2' }], 5000);
  assert.deepEqual(page.actions.slice(-2), ['hover:aria-ref=e2', 'drag:aria-ref=e2->aria-ref=f1e2']);
});

test('Playwright automatically tracks popup pages and makes the newest page active', async () => {
  const { driver, context } = setup();
  await driver.listPages(43133, 5000);
  const popup = new FakePage();
  popup.currentUrl = 'https://popup.example.test/';
  popup.currentTitle = 'Popup';
  context.pageList.push(popup);
  context.emit('page', popup as unknown as Page);
  const pages = await driver.listPages(43133, 5000);
  assert.equal(pages.length, 2);
  const popupSummary = pages.find(row => row.url === 'https://popup.example.test/');
  assert.ok(popupSummary);
  assert.equal(popupSummary.active, true);
  const snapshot = await driver.snapshot(43133, popupSummary.page_id, { screenshot: false, timeout_ms: 5000 });
  assert.equal(snapshot.url, 'https://popup.example.test/');
});


test('Playwright opt-in console/network observability is bounded and redacts sensitive URL/header data', async () => {
  const { driver, page } = setup();
  const pages = await driver.listPages(43134, 5000);
  const pageId = pages[0]!.page_id;

  const defaultSnapshot = await driver.snapshot(43134, pageId, { screenshot: false, timeout_ms: 5000 });
  assert.equal(defaultSnapshot.console_messages, undefined);
  assert.equal(defaultSnapshot.network_events, undefined);

  const enabledSnapshot = await driver.snapshot(43134, pageId, {
    screenshot: false,
    include_console: true,
    max_console_messages: 2,
    include_network: true,
    max_network_events: 10,
    timeout_ms: 5000
  });
  assert.deepEqual(enabledSnapshot.console_messages, []);
  assert.deepEqual(enabledSnapshot.network_events, []);

  page.emit('console', { type: () => 'log', text: () => 'first message' });
  page.emit('console', { type: () => 'warning', text: () => 'Authorization: Bearer SUPER-SECRET-TOKEN' });
  page.emit('console', { type: () => 'error', text: () => 'Cookie: session=VERY-SECRET-COOKIE' });

  const request = {
    url: () => 'https://user:pass@example.test/api/items?token=QUERY-SECRET#fragment',
    method: () => 'POST',
    resourceType: () => 'xhr',
    failure: () => ({ errorText: 'Set-Cookie: sid=FAILED-SECRET' })
  };
  const response = {
    request: () => request,
    url: () => request.url(),
    status: () => 201,
    statusText: () => 'Created'
  };
  page.emit('request', request);
  page.emit('response', response);
  page.emit('requestfailed', request);
  page.emit('request', {
    url: () => 'data:text/plain,INLINE-SECRET',
    method: () => 'GET',
    resourceType: () => 'other',
    failure: () => null
  });

  const snapshot = await driver.snapshot(43134, pageId, {
    screenshot: false,
    include_console: true,
    max_console_messages: 2,
    include_network: true,
    max_network_events: 10,
    timeout_ms: 5000
  });
  assert.equal(snapshot.console_messages?.length, 2);
  assert.match(snapshot.console_messages?.[0]?.text ?? '', /Authorization: \[REDACTED\]/i);
  assert.match(snapshot.console_messages?.[1]?.text ?? '', /Cookie: \[REDACTED\]/i);
  assert.ok((snapshot.console_messages?.[1]?.sequence ?? 0) > (snapshot.console_messages?.[0]?.sequence ?? 0));

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /SUPER-SECRET-TOKEN|VERY-SECRET-COOKIE|QUERY-SECRET|FAILED-SECRET|INLINE-SECRET|user:pass/i);
  const requestEvent = snapshot.network_events?.find(row => row.phase === 'request' && row.url.includes('/api/items'));
  assert.equal(requestEvent?.url, 'https://example.test/api/items');
  assert.equal(requestEvent?.query_redacted, true);
  assert.equal(requestEvent?.method, 'POST');
  assert.equal(requestEvent?.resource_type, 'xhr');
  const responseEvent = snapshot.network_events?.find(row => row.phase === 'response');
  assert.equal(responseEvent?.status, 201);
  const failedEvent = snapshot.network_events?.find(row => row.phase === 'failed');
  assert.match(failedEvent?.failure_text ?? '', /Set-Cookie: \[REDACTED\]/i);
  assert.ok(snapshot.network_events?.some(row => row.url === 'data:<redacted>'));
});


test('Playwright console/network capture keeps only bounded in-memory history after opt-in', async () => {
  const { driver, page } = setup();
  const pages = await driver.listPages(43135, 5000);
  const pageId = pages[0]!.page_id;
  await driver.snapshot(43135, pageId, {
    screenshot: false,
    include_console: true,
    max_console_messages: 200,
    include_network: true,
    max_network_events: 500,
    timeout_ms: 5000
  });

  for (let index = 0; index < 205; index++) {
    page.emit('console', { type: () => 'log', text: () => `message-${index}` });
  }
  for (let index = 0; index < 505; index++) {
    page.emit('request', {
      url: () => `https://example.test/resource/${index}?secret=hidden-${index}`,
      method: () => 'GET',
      resourceType: () => 'fetch',
      failure: () => null
    });
  }

  const snapshot = await driver.snapshot(43135, pageId, {
    screenshot: false,
    include_console: true,
    max_console_messages: 200,
    include_network: true,
    max_network_events: 500,
    timeout_ms: 5000
  });
  assert.equal(snapshot.console_messages?.length, 200);
  assert.equal(snapshot.console_messages?.[0]?.text, 'message-5');
  assert.equal(snapshot.console_messages?.at(-1)?.text, 'message-204');
  assert.equal(snapshot.network_events?.length, 500);
  assert.equal(snapshot.network_events?.[0]?.url, 'https://example.test/resource/5');
  assert.equal(snapshot.network_events?.at(-1)?.url, 'https://example.test/resource/504');
  assert.doesNotMatch(JSON.stringify(snapshot.network_events), /hidden-/i);
});


test('Playwright find searches the sanitized AI tree and returns actionable cross-frame refs without password values', async () => {
  const { driver, page } = setup();
  page.passwordRefs = ['e9'];
  page.passwordValues = ['FIND-SECRET-PASSWORD'];
  page.ariaTree = {
    role: 'document',
    children: [
      { role: 'textbox', name: 'Password', ref: 'e9', text: 'FIND-SECRET-PASSWORD' },
      { role: 'button', name: 'Submit order', ref: 'e2' },
      { role: 'iframe', name: 'Payment frame', ref: 'e8', children: [
        { role: 'button', name: 'Frame Action', ref: 'f1e2' }
      ] }
    ]
  };

  const found = await driver.find(43135, undefined, {
    query: 'frame action',
    max_results: 10,
    timeout_ms: 5000
  });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0]?.ref, 'f1e2');
  assert.match(found.matches[0]?.path ?? '', /iframe.*Payment frame.*button.*Frame Action/i);
  assert.match(found.state_token, /^aria-v1:[0-9a-f]{64}$/);

  const secretSearch = await driver.find(43135, found.page_id, {
    query: 'FIND-SECRET-PASSWORD',
    max_results: 10,
    timeout_ms: 5000
  });
  assert.equal(secretSearch.matches.length, 0);
  assert.doesNotMatch(JSON.stringify(secretSearch), /FIND-SECRET-PASSWORD/);
});

test('Playwright selectPage explicitly changes the active page and rejects unknown page ids', async () => {
  const { driver } = setup();
  const initial = await driver.listPages(43136, 5000);
  const created = await driver.createPage(43136, 'https://second.example.test/', 5000);
  assert.equal((await driver.listPages(43136, 5000)).find(row => row.page_id === created)?.active, true);
  const selected = await driver.selectPage(43136, initial[0]!.page_id, 5000);
  assert.equal(selected, initial[0]!.page_id);
  const after = await driver.listPages(43136, 5000);
  assert.equal(after.find(row => row.page_id === initial[0]!.page_id)?.active, true);
  assert.equal(after.find(row => row.page_id === created)?.active, false);
  await assert.rejects(driver.selectPage(43136, 'page-missing', 5000), /page not found/i);
});


test('Playwright type_text and set_checked use deterministic locator actions with observation refs', async () => {
  const { driver, page } = setup();
  const pages = await driver.listPages(43137, 5000);
  await driver.act(43137, pages[0]!.page_id, [
    { type: 'type_text', ref: 'e2', text: 'hello', delay_ms: 25 }
  ], 5000);
  await driver.act(43137, pages[0]!.page_id, [
    { type: 'set_checked', ref: 'f1e2', checked: true }
  ], 5000);
  assert.deepEqual(page.actions.slice(-2), [
    'type:aria-ref=e2:hello:25',
    'checked:aria-ref=f1e2:true'
  ]);
  await assert.rejects(
    driver.act(43137, pages[0]!.page_id, [{ type: 'type_text', ref: 'e2', text: 'x', delay_ms: 251 }], 5000),
    /delay_ms/i
  );
});


test('Playwright focused_element prefers the deepest focused frame and never exposes password content', async () => {
  const { driver, page } = setup();
  page.focused = true;
  page.focusDom = { tag: 'iframe', id: 'auth-frame', isEditable: false, isPassword: false };
  page.focusAria = { role: 'iframe', name: 'Auth', ref: 'e8' };

  const child = new FakePage();
  child.focused = true;
  child.focusDom = { tag: 'input', id: 'password', name: 'password', type: 'password', isEditable: true, isPassword: true };
  child.focusAria = { role: 'textbox', name: 'Password', ref: 'f1e7', text: 'TOP-SECRET-FOCUS' };
  page.childFrames = [child];

  const snapshot = await driver.snapshot(43140, undefined, { screenshot: false, timeout_ms: 5000 });
  assert.deepEqual(snapshot.focused_element, {
    tag: 'input',
    role: 'textbox',
    id: 'password',
    name: 'password',
    type: 'password',
    aria_name: 'Password',
    ref: 'f1e7',
    is_editable: true
  });
  assert.doesNotMatch(JSON.stringify(snapshot.focused_element), /TOP-SECRET-FOCUS/);
});
