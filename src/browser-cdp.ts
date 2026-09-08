import { Buffer } from 'node:buffer';

export interface BrowserPageSummary {
  readonly page_id: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export interface BrowserViewport {
  readonly width: number;
  readonly height: number;
}

export interface BrowserSize {
  readonly width: number;
  readonly height: number;
}

export interface BrowserFocusedElement {
  readonly tag: string;
  readonly id?: string;
  readonly name?: string;
  readonly type?: string;
  readonly text?: string;
  readonly value?: string;
  readonly aria_name?: string;
  readonly selector?: string;
  readonly is_editable?: boolean;
}

export interface BrowserInteractiveElement {
  readonly tag: string;
  readonly type?: string;
  readonly text?: string;
  readonly aria_name?: string;
  readonly href?: string;
  readonly selector?: string;
}

export interface BrowserSnapshotData {
  readonly page_id: string;
  readonly pages: readonly BrowserPageSummary[];
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly viewport: BrowserViewport;
  readonly page_size: BrowserSize;
  readonly focused_element?: BrowserFocusedElement;
  readonly interactive_elements: readonly BrowserInteractiveElement[];
  readonly png?: Uint8Array;
}

export type BrowserNavigationDirection = 'back' | 'forward' | 'reload';

export type BrowserAction =
  | { readonly type: 'goto'; readonly url: string; readonly wait_until?: 'domcontentloaded' | 'load'; readonly timeout_ms?: number }
  | { readonly type: 'click'; readonly selector: string }
  | { readonly type: 'fill'; readonly selector: string; readonly value: string }
  | { readonly type: 'press'; readonly selector?: string; readonly key: string }
  | { readonly type: 'wait'; readonly duration_ms: number }
  | { readonly type: 'wait_selector'; readonly selector: string; readonly state?: 'visible' | 'hidden' | 'attached' | 'detached'; readonly timeout_ms?: number }
  | { readonly type: 'wait_url'; readonly url: string; readonly timeout_ms?: number }
  | { readonly type: 'wait_text'; readonly text: string; readonly exact?: boolean; readonly state?: 'visible' | 'hidden'; readonly timeout_ms?: number }
  | { readonly type: 'select'; readonly selector: string; readonly value: string }
  | { readonly type: 'scroll'; readonly delta_x?: number; readonly delta_y?: number }
  | { readonly type: 'navigation'; readonly direction: BrowserNavigationDirection; readonly timeout_ms?: number };

export interface BrowserSnapshotOptions {
  readonly full_page?: boolean;
  readonly screenshot?: boolean;
  readonly max_text_chars?: number;
  readonly max_interactive_elements?: number;
  readonly timeout_ms?: number;
}

export interface BrowserCdpDriver {
  listPages(port: number, timeoutMs?: number): Promise<readonly BrowserPageSummary[]>;
  snapshot(port: number, pageId: string | undefined, options?: BrowserSnapshotOptions): Promise<BrowserSnapshotData>;
  act(port: number, pageId: string | undefined, actions: readonly BrowserAction[], timeoutMs?: number): Promise<string>;
}

interface CdpPageTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly title: string;
  readonly webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

function boundedTimeout(value: number | undefined, fallback = 10000): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 100 || selected > 60000) {
    throw new Error('Browser timeout_ms must be between 100 and 60000.');
  }
  return selected;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchTargets(port: number, timeoutMs: number): Promise<CdpPageTarget[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid browser CDP port.');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`Browser CDP page discovery failed with HTTP ${response.status}.`);
  const value = await response.json() as unknown;
  if (!Array.isArray(value)) throw new Error('Browser CDP page discovery returned invalid JSON.');
  return value.filter((item): item is CdpPageTarget => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const candidate = item as Partial<CdpPageTarget>;
    return typeof candidate.id === 'string'
      && typeof candidate.type === 'string'
      && typeof candidate.url === 'string'
      && typeof candidate.title === 'string';
  });
}

function publicPages(targets: readonly CdpPageTarget[], activeId?: string): BrowserPageSummary[] {
  return targets
    .filter(target => target.type === 'page')
    .map(target => ({
      page_id: target.id,
      url: target.url,
      title: target.title,
      active: target.id === activeId
    }));
}

function selectPageTarget(targets: readonly CdpPageTarget[], pageId?: string): CdpPageTarget {
  const pages = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
  if (pages.length === 0) throw new Error('Browser session has no controllable page.');
  if (!pageId) return pages[0]!;
  const found = pages.find(page => page.id === pageId);
  if (!found) throw new Error(`Browser page not found: ${pageId}.`);
  return found;
}

async function eventDataText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  return String(data);
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      this.failPending(new Error('Browser CDP connection closed.'));
    });
    socket.addEventListener('error', () => {
      this.failPending(new Error('Browser CDP connection failed.'));
    });
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    if (!/^ws:\/\/127\.0\.0\.1(?::\d+)?\//u.test(url) && !/^ws:\/\/localhost(?::\d+)?\//u.test(url)) {
      throw new Error('Browser CDP websocket must be loopback.');
    }
    const socket = new WebSocket(url);
    await withTimeout(new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Browser CDP websocket open failed.')), { once: true });
    }), timeoutMs, 'Browser CDP connect');
    return new CdpConnection(socket);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async handleMessage(data: unknown): Promise<void> {
    let parsed: CdpResponse;
    try {
      parsed = JSON.parse(await eventDataText(data)) as CdpResponse;
    } catch {
      return;
    }
    if (typeof parsed.id !== 'number') return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(new Error(`Browser CDP error ${parsed.error.code ?? ''}: ${parsed.error.message ?? 'unknown error'}`.trim()));
    } else {
      pending.resolve(parsed.result);
    }
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Browser CDP websocket is not open.');
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return withTimeout(result, timeoutMs, `Browser CDP ${method}`);
  }

  close(): void {
    this.failPending(new Error('Browser CDP connection closed locally.'));
    try { this.socket.close(); } catch { }
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned invalid data.`);
  return value as Record<string, unknown>;
}

async function evaluate(connection: CdpConnection, expression: string, timeoutMs: number): Promise<unknown> {
  const response = objectValue(await connection.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  }, timeoutMs), 'Runtime.evaluate');
  if (response.exceptionDetails) throw new Error('Browser page evaluation failed.');
  const remote = objectValue(response.result, 'Runtime.evaluate result');
  return remote.value;
}

function selectorExpression(selector: string, body: string): string {
  return `(() => { const selector = ${JSON.stringify(selector)}; const el = document.querySelector(selector); if (!el) throw new Error('Selector not found: ' + selector); ${body} })()`;
}

function normalizeNavigationUrl(raw: string): string {
  const value = raw.trim();
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error('Browser navigation URL is invalid.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Browser navigation only supports HTTP(S) URLs.');
  }
  return parsed.toString();
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function snapshotExpression(maxTextChars: number, maxInteractiveElements: number): string {
  return `(() => {
    const maxText = ${maxTextChars};
    const maxElements = ${maxInteractiveElements};
    const trim = (value, max = 500) => String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const cssPath = (element) => {
      if (!(element instanceof Element)) return '';
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      let current = element;
      while (current && current instanceof Element && current !== document.documentElement && parts.length < 8) {
        let part = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter(child => child.tagName === current.tagName);
          if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    };
    const visible = (element) => {
      if (!(element instanceof Element)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const selector = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
    const interactive = [];
    for (const element of document.querySelectorAll(selector)) {
      if (!visible(element)) continue;
      interactive.push({
        tag: element.tagName.toLowerCase(),
        ...(element instanceof HTMLInputElement && element.type ? { type: element.type } : {}),
        ...(trim(element.textContent, 240) ? { text: trim(element.textContent, 240) } : {}),
        ...(trim(element.getAttribute('aria-label'), 240) ? { aria_name: trim(element.getAttribute('aria-label'), 240) } : {}),
        ...(element instanceof HTMLAnchorElement && element.href ? { href: element.href } : {}),
        selector: cssPath(element)
      });
      if (interactive.length >= maxElements) break;
    }
    const active = document.activeElement;
    let focused;
    if (active && active !== document.body && active !== document.documentElement) {
      const input = active instanceof HTMLInputElement ? active : null;
      const rawValue = 'value' in active ? String(active.value ?? '') : '';
      focused = {
        tag: active.tagName.toLowerCase(),
        ...(active.id ? { id: active.id } : {}),
        ...(active.getAttribute('name') ? { name: active.getAttribute('name') } : {}),
        ...(active.getAttribute('type') ? { type: active.getAttribute('type') } : {}),
        ...(trim(active.textContent, 240) ? { text: trim(active.textContent, 240) } : {}),
        ...(rawValue && (!input || input.type !== 'password') ? { value: rawValue.slice(0, 500) } : {}),
        ...(trim(active.getAttribute('aria-label'), 240) ? { aria_name: trim(active.getAttribute('aria-label'), 240) } : {}),
        selector: cssPath(active),
        is_editable: active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement || active.isContentEditable
      };
    }
    const root = document.documentElement;
    return {
      url: location.href,
      title: document.title,
      text: String(document.body?.innerText ?? '').slice(0, maxText),
      viewport: { width: Math.max(0, innerWidth), height: Math.max(0, innerHeight) },
      page_size: { width: Math.max(root?.scrollWidth ?? 0, innerWidth), height: Math.max(root?.scrollHeight ?? 0, innerHeight) },
      ...(focused ? { focused_element: focused } : {}),
      interactive_elements: interactive
    };
  })()`;
}

function parseSnapshotValue(value: unknown): Omit<BrowserSnapshotData, 'page_id' | 'pages' | 'png'> {
  const object = objectValue(value, 'Browser snapshot');
  const viewport = objectValue(object.viewport, 'Browser viewport');
  const pageSize = objectValue(object.page_size, 'Browser page size');
  if (
    typeof object.url !== 'string'
    || typeof object.title !== 'string'
    || typeof object.text !== 'string'
    || typeof viewport.width !== 'number'
    || typeof viewport.height !== 'number'
    || typeof pageSize.width !== 'number'
    || typeof pageSize.height !== 'number'
    || !Array.isArray(object.interactive_elements)
  ) throw new Error('Browser snapshot fields are invalid.');
  const focused = object.focused_element;
  return {
    url: object.url,
    title: object.title,
    text: object.text,
    viewport: { width: viewport.width, height: viewport.height },
    page_size: { width: pageSize.width, height: pageSize.height },
    ...(focused && typeof focused === 'object' && !Array.isArray(focused)
      ? { focused_element: focused as unknown as BrowserFocusedElement }
      : {}),
    interactive_elements: object.interactive_elements as BrowserInteractiveElement[]
  };
}

async function waitForNavigationState(
  connection: CdpConnection,
  waitUntilState: 'domcontentloaded' | 'load',
  timeoutMs: number
): Promise<void> {
  await waitUntil(async () => {
    const ready = await evaluate(connection, 'document.readyState', Math.min(timeoutMs, 5000));
    return waitUntilState === 'domcontentloaded'
      ? ready === 'interactive' || ready === 'complete'
      : ready === 'complete';
  }, timeoutMs, `Browser ${waitUntilState}`);
}

async function runAction(connection: CdpConnection, action: BrowserAction, defaultTimeoutMs: number): Promise<void> {
  switch (action.type) {
    case 'goto': {
      const url = normalizeNavigationUrl(action.url);
      const timeout = boundedTimeout(action.timeout_ms, defaultTimeoutMs);
      await connection.send('Page.navigate', { url }, timeout);
      await waitForNavigationState(connection, action.wait_until ?? 'domcontentloaded', timeout);
      return;
    }
    case 'click':
      await evaluate(connection, selectorExpression(action.selector,
        "el.scrollIntoView({block:'center', inline:'center'}); if (!(el instanceof HTMLElement)) throw new Error('Element is not clickable'); el.click(); return true;"), defaultTimeoutMs);
      return;
    case 'fill':
      await evaluate(connection, selectorExpression(action.selector,
        `if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable)) throw new Error('Element is not editable');
         const value = ${JSON.stringify(action.value)};
         if (el.isContentEditable) { el.textContent = value; }
         else { const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value'); if (descriptor?.set) descriptor.set.call(el, value); else el.value = value; }
         el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true;`), defaultTimeoutMs);
      return;
    case 'press': {
      if (action.selector) {
        await evaluate(connection, selectorExpression(action.selector, "if (!(el instanceof HTMLElement)) throw new Error('Element is not focusable'); el.focus(); return true;"), defaultTimeoutMs);
      }
      const key = action.key.trim();
      if (!key || key.length > 64) throw new Error('Browser press key is invalid.');
      const text = key.length === 1 ? key : undefined;
      await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...(text ? { text } : {}) }, defaultTimeoutMs);
      await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, defaultTimeoutMs);
      return;
    }
    case 'wait':
      if (!Number.isInteger(action.duration_ms) || action.duration_ms < 0 || action.duration_ms > 30000) {
        throw new Error('Browser wait duration_ms must be between 0 and 30000.');
      }
      await new Promise(resolve => setTimeout(resolve, action.duration_ms));
      return;
    case 'wait_selector': {
      const timeout = boundedTimeout(action.timeout_ms, defaultTimeoutMs);
      const state = action.state ?? 'visible';
      await waitUntil(async () => {
        const result = await evaluate(connection, `(() => { const el = document.querySelector(${JSON.stringify(action.selector)}); if (${JSON.stringify(state)} === 'attached') return Boolean(el); if (${JSON.stringify(state)} === 'detached') return !el; if (!el) return ${JSON.stringify(state)} === 'hidden'; const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); const visible = style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; return ${JSON.stringify(state)} === 'visible' ? visible : !visible; })()`, Math.min(timeout, 5000));
        return result === true;
      }, timeout, `Browser wait_selector ${state}`);
      return;
    }
    case 'wait_url': {
      const target = normalizeNavigationUrl(action.url);
      const timeout = boundedTimeout(action.timeout_ms, defaultTimeoutMs);
      await waitUntil(async () => (await evaluate(connection, 'location.href', Math.min(timeout, 5000))) === target, timeout, 'Browser wait_url');
      return;
    }
    case 'wait_text': {
      const timeout = boundedTimeout(action.timeout_ms, defaultTimeoutMs);
      const expected = action.text;
      if (!expected) throw new Error('Browser wait_text text is required.');
      const state = action.state ?? 'visible';
      await waitUntil(async () => {
        const found = await evaluate(connection, `(() => { const haystack = String(document.body?.innerText ?? ''); const needle = ${JSON.stringify(expected)}; return ${action.exact === true ? 'haystack === needle' : 'haystack.includes(needle)'}; })()`, Math.min(timeout, 5000));
        return state === 'visible' ? found === true : found !== true;
      }, timeout, `Browser wait_text ${state}`);
      return;
    }
    case 'select':
      await evaluate(connection, selectorExpression(action.selector,
        `if (!(el instanceof HTMLSelectElement)) throw new Error('Element is not a select'); const value = ${JSON.stringify(action.value)}; if (!Array.from(el.options).some(option => option.value === value)) throw new Error('Select option not found'); el.value = value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;`), defaultTimeoutMs);
      return;
    case 'scroll':
      await evaluate(connection, `window.scrollBy(${Math.trunc(action.delta_x ?? 0)}, ${Math.trunc(action.delta_y ?? 0)}); true`, defaultTimeoutMs);
      return;
    case 'navigation': {
      const timeout = boundedTimeout(action.timeout_ms, defaultTimeoutMs);
      if (action.direction === 'reload') {
        await connection.send('Page.reload', {}, timeout);
        await waitForNavigationState(connection, 'domcontentloaded', timeout);
        return;
      }
      const history = objectValue(await connection.send('Page.getNavigationHistory', {}, timeout), 'Browser navigation history');
      if (!Array.isArray(history.entries) || typeof history.currentIndex !== 'number') throw new Error('Browser navigation history is invalid.');
      const nextIndex = action.direction === 'back' ? history.currentIndex - 1 : history.currentIndex + 1;
      const target = history.entries[nextIndex] as { id?: unknown } | undefined;
      if (!target || typeof target.id !== 'number') throw new Error(`Browser cannot navigate ${action.direction}.`);
      await connection.send('Page.navigateToHistoryEntry', { entryId: target.id }, timeout);
      await waitForNavigationState(connection, 'domcontentloaded', timeout);
      return;
    }
  }
}

export class ChromeCdpDriver implements BrowserCdpDriver {
  async listPages(port: number, timeoutMs = 5000): Promise<readonly BrowserPageSummary[]> {
    return publicPages(await fetchTargets(port, boundedTimeout(timeoutMs, 5000)));
  }

  async snapshot(port: number, pageId: string | undefined, options: BrowserSnapshotOptions = {}): Promise<BrowserSnapshotData> {
    const timeout = boundedTimeout(options.timeout_ms, 10000);
    const maxText = options.max_text_chars ?? 8000;
    const maxElements = options.max_interactive_elements ?? 100;
    if (!Number.isInteger(maxText) || maxText < 1 || maxText > 50000) throw new Error('Browser max_text_chars must be between 1 and 50000.');
    if (!Number.isInteger(maxElements) || maxElements < 1 || maxElements > 500) throw new Error('Browser max_interactive_elements must be between 1 and 500.');

    const targets = await fetchTargets(port, timeout);
    const target = selectPageTarget(targets, pageId);
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl!, timeout);
    try {
      await connection.send('Runtime.enable', {}, timeout);
      await connection.send('Page.enable', {}, timeout);
      const snapshot = parseSnapshotValue(await evaluate(connection, snapshotExpression(maxText, maxElements), timeout));
      let png: Uint8Array | undefined;
      if (options.screenshot !== false) {
        const params: Record<string, unknown> = { format: 'png', fromSurface: true };
        if (options.full_page === true) {
          const metrics = objectValue(await connection.send('Page.getLayoutMetrics', {}, timeout), 'Browser layout metrics');
          const content = objectValue(metrics.cssContentSize ?? metrics.contentSize, 'Browser content size');
          if (typeof content.width === 'number' && typeof content.height === 'number' && content.width > 0 && content.height > 0) {
            const width = Math.min(content.width, 12000);
            const height = Math.min(content.height, 12000);
            params.captureBeyondViewport = true;
            params.clip = { x: 0, y: 0, width, height, scale: 1 };
          }
        }
        const captured = objectValue(await connection.send('Page.captureScreenshot', params, timeout), 'Browser screenshot');
        if (typeof captured.data !== 'string') throw new Error('Browser screenshot payload is invalid.');
        png = Buffer.from(captured.data, 'base64');
      }
      return {
        page_id: target.id,
        pages: publicPages(targets, target.id),
        ...snapshot,
        ...(png ? { png } : {})
      };
    } finally {
      connection.close();
    }
  }

  async act(port: number, pageId: string | undefined, actions: readonly BrowserAction[], timeoutMs = 15000): Promise<string> {
    const timeout = boundedTimeout(timeoutMs, 15000);
    if (actions.length < 1 || actions.length > 20) throw new Error('Browser actions must contain between 1 and 20 items.');
    const targets = await fetchTargets(port, timeout);
    const target = selectPageTarget(targets, pageId);
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl!, timeout);
    try {
      await connection.send('Runtime.enable', {}, timeout);
      await connection.send('Page.enable', {}, timeout);
      for (const action of actions) await runAction(connection, action, timeout);
      return target.id;
    } finally {
      connection.close();
    }
  }
}
