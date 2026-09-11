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
  readonly role?: string;
  readonly id?: string;
  readonly name?: string;
  readonly type?: string;
  readonly text?: string;
  readonly value?: string;
  readonly aria_name?: string;
  readonly ref?: string;
  readonly selector?: string;
  readonly is_editable?: boolean;
}

export interface BrowserInteractiveElement {
  readonly tag: string;
  readonly role?: string;
  readonly type?: string;
  readonly text?: string;
  readonly aria_name?: string;
  readonly href?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
  readonly expanded?: boolean;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly ref?: string;
  readonly selector?: string;
}

export interface BrowserConsoleMessage {
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly text: string;
}

export interface BrowserNetworkEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly phase: 'request' | 'response' | 'failed';
  readonly method: string;
  readonly url: string;
  readonly query_redacted: boolean;
  readonly resource_type: string;
  readonly status?: number;
  readonly status_text?: string;
  readonly failure_text?: string;
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
  readonly console_messages?: readonly BrowserConsoleMessage[];
  readonly network_events?: readonly BrowserNetworkEvent[];
  readonly state_token: string;
  readonly png?: Uint8Array;
}

export type BrowserNavigationDirection = 'back' | 'forward' | 'reload';

export type BrowserAction =
  | { readonly type: 'goto'; readonly url: string; readonly wait_until?: 'domcontentloaded' | 'load'; readonly timeout_ms?: number }
  | { readonly type: 'click'; readonly selector?: string; readonly ref?: string }
  | { readonly type: 'hover'; readonly selector?: string; readonly ref?: string }
  | { readonly type: 'drag'; readonly source_selector?: string; readonly source_ref?: string; readonly target_selector?: string; readonly target_ref?: string }
  | { readonly type: 'fill'; readonly selector?: string; readonly ref?: string; readonly value: string }
  | { readonly type: 'type_text'; readonly selector?: string; readonly ref?: string; readonly text: string; readonly delay_ms?: number }
  | { readonly type: 'set_checked'; readonly selector?: string; readonly ref?: string; readonly checked: boolean }
  | { readonly type: 'press'; readonly selector?: string; readonly ref?: string; readonly key: string }
  | { readonly type: 'wait'; readonly duration_ms: number }
  | { readonly type: 'wait_selector'; readonly selector?: string; readonly ref?: string; readonly state?: 'visible' | 'hidden' | 'attached' | 'detached'; readonly timeout_ms?: number }
  | { readonly type: 'wait_url'; readonly url: string; readonly timeout_ms?: number }
  | { readonly type: 'wait_text'; readonly text: string; readonly exact?: boolean; readonly state?: 'visible' | 'hidden'; readonly timeout_ms?: number }
  | { readonly type: 'select'; readonly selector?: string; readonly ref?: string; readonly value: string }
  | { readonly type: 'set_files'; readonly selector?: string; readonly ref?: string; readonly files: readonly string[] }
  | { readonly type: 'scroll'; readonly delta_x?: number; readonly delta_y?: number }
  | { readonly type: 'navigation'; readonly direction: BrowserNavigationDirection; readonly timeout_ms?: number };

export interface BrowserSnapshotOptions {
  readonly full_page?: boolean;
  readonly screenshot?: boolean;
  readonly max_text_chars?: number;
  readonly max_interactive_elements?: number;
  readonly include_console?: boolean;
  readonly max_console_messages?: number;
  readonly include_network?: boolean;
  readonly max_network_events?: number;
  readonly timeout_ms?: number;
}

export interface BrowserDownloadData {
  readonly page_id: string;
  readonly suggested_filename: string;
  readonly path: string;
}

export interface BrowserFindMatch {
  readonly path: string;
  readonly snippet: string;
  readonly ref?: string;
  readonly role?: string;
  readonly name?: string;
}

export interface BrowserFindData {
  readonly page_id: string;
  readonly pages: readonly BrowserPageSummary[];
  readonly url: string;
  readonly title: string;
  readonly matches: readonly BrowserFindMatch[];
  readonly state_token: string;
}

export interface BrowserFindOptions {
  readonly query: string;
  readonly case_sensitive?: boolean;
  readonly max_results?: number;
  readonly timeout_ms?: number;
}

export interface BrowserCdpDriver {
  listPages(port: number, timeoutMs?: number): Promise<readonly BrowserPageSummary[]>;
  createPage(port: number, url?: string, timeoutMs?: number): Promise<string>;
  selectPage(port: number, pageId: string, timeoutMs?: number): Promise<string>;
  closePage(port: number, pageId: string, timeoutMs?: number): Promise<void>;
  handleDialog(port: number, pageId: string | undefined, accept: boolean, promptText?: string, timeoutMs?: number): Promise<void>;
  download(port: number, pageId: string | undefined, selector: string | undefined, ref: string | undefined, destinationPath: string, timeoutMs?: number): Promise<BrowserDownloadData>;
  find(port: number, pageId: string | undefined, options: BrowserFindOptions): Promise<BrowserFindData>;
  snapshot(port: number, pageId: string | undefined, options?: BrowserSnapshotOptions): Promise<BrowserSnapshotData>;
  stateToken(port: number, pageId: string | undefined, timeoutMs?: number): Promise<string>;
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

const MAX_SCREENSHOT_PIXELS = 12_000_000;
const MAX_SCREENSHOT_BASE64_CHARS = 64 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 48 * 1024 * 1024;

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

async function fetchBrowserWebSocketUrl(port: number, timeoutMs: number): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid browser CDP port.');
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`Browser CDP version discovery failed with HTTP ${response.status}.`);
  const value = await response.json() as unknown;
  const object = objectValue(value, 'Browser CDP version');
  if (typeof object.webSocketDebuggerUrl !== 'string' || object.webSocketDebuggerUrl.length > 4096) {
    throw new Error('Browser CDP version response did not include a valid websocket URL.');
  }
  return object.webSocketDebuggerUrl;
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

function elementTargetExpression(selector: string | undefined, ref: string | undefined, body: string): string {
  const selectedSelector = selector?.trim();
  const selectedRef = ref?.trim();
  if (Boolean(selectedSelector) === Boolean(selectedRef)) {
    throw new Error('Browser element action requires exactly one of selector or ref.');
  }
  if (selectedSelector) return selectorExpression(selectedSelector, body);
  if (!/^e[1-9][0-9]{0,6}$/u.test(selectedRef!)) throw new Error('Browser element ref is invalid.');
  return `(() => { const ref = ${JSON.stringify(selectedRef)}; const state = globalThis['__deskmcpObservationStateV1']; if (!state || state.refVersion !== state.version) throw new Error('Element ref is unavailable or stale: ' + ref); const el = state.refToElement instanceof Map ? state.refToElement.get(ref) : undefined; if (!el || el.nodeType !== 1 || !el.isConnected) throw new Error('Element ref is unavailable or stale: ' + ref); ${body} })()`;
}

async function elementObjectId(
  connection: CdpConnection,
  selector: string | undefined,
  ref: string | undefined,
  timeoutMs: number
): Promise<string> {
  const expression = elementTargetExpression(selector, ref, 'return el;');
  const response = objectValue(await connection.send('Runtime.evaluate', {
    expression,
    returnByValue: false,
    awaitPromise: true,
    userGesture: true
  }, timeoutMs), 'Runtime.evaluate');
  if (response.exceptionDetails) throw new Error('Browser element resolution failed.');
  const remote = objectValue(response.result, 'Browser element remote object');
  if (typeof remote.objectId !== 'string' || !remote.objectId) throw new Error('Browser element did not resolve to a live remote object.');
  return remote.objectId;
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
    const stateKey = '__deskmcpObservationStateV1';
    let state = globalThis[stateKey];
    if (!state || typeof state !== 'object' || typeof state.token !== 'string' || typeof state.version !== 'number') {
      state = {
        token: globalThis.crypto?.randomUUID?.() ?? (String(performance.timeOrigin) + '-' + Math.random().toString(36).slice(2)),
        version: 0
      };
      Object.defineProperty(globalThis, stateKey, { value: state, enumerable: false, configurable: false, writable: false });
      if (document.documentElement) {
        const observer = new MutationObserver(() => { state.version = Math.min(Number.MAX_SAFE_INTEGER, state.version + 1); });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      }
    }
    if (state.refVersion !== state.version || !(state.refToElement instanceof Map) || !(state.elementToRef instanceof WeakMap)) {
      state.refVersion = state.version;
      state.nextRef = 1;
      state.refToElement = new Map();
      state.elementToRef = new WeakMap();
    }
    const elementRef = (element) => {
      let ref = state.elementToRef.get(element);
      if (!ref) {
        ref = 'e' + state.nextRef++;
        state.elementToRef.set(element, ref);
        state.refToElement.set(ref, element);
      }
      return ref;
    };
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
    const seenElements = new Set();
    const seenRoots = new Set();
    const roots = [document];
    let scanned = 0;
    const maxScan = Math.min(20000, Math.max(2000, maxElements * 40));
    while (roots.length > 0 && interactive.length < maxElements) {
      const scope = roots.shift();
      if (!scope || seenRoots.has(scope)) continue;
      seenRoots.add(scope);
      for (const element of scope.querySelectorAll(selector)) {
        if (seenElements.has(element) || !visible(element)) continue;
        seenElements.add(element);
        const rect = element.getBoundingClientRect();
        const role = trim(element.getAttribute('role'), 80);
        const ariaName = trim(element.getAttribute('aria-label'), 240);
        const rawValue = 'value' in element ? String(element.value ?? '') : (element.isContentEditable ? String(element.textContent ?? '') : '');
        const input = element instanceof HTMLInputElement ? element : null;
        const safeValue = input?.type === 'password' ? '' : trim(rawValue, 500);
        const ariaDisabled = element.getAttribute('aria-disabled');
        const nativeDisabled = 'disabled' in element && typeof element.disabled === 'boolean' ? element.disabled : undefined;
        const ariaChecked = element.getAttribute('aria-checked');
        const nativeChecked = input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : undefined;
        const ariaSelected = element.getAttribute('aria-selected');
        const ariaExpanded = element.getAttribute('aria-expanded');
        const cssSelector = element.getRootNode() === document ? cssPath(element) : '';
        interactive.push({
          tag: element.tagName.toLowerCase(),
          ...(role ? { role } : {}),
          ...(input?.type ? { type: input.type } : {}),
          ...(trim(element.textContent, 240) ? { text: trim(element.textContent, 240) } : {}),
          ...(ariaName ? { aria_name: ariaName } : {}),
          ...(element instanceof HTMLAnchorElement && element.href ? { href: element.href } : {}),
          ...(safeValue ? { value: safeValue } : {}),
          ...(typeof nativeDisabled === 'boolean' ? { disabled: nativeDisabled } : ariaDisabled === 'true' ? { disabled: true } : ariaDisabled === 'false' ? { disabled: false } : {}),
          ...(typeof nativeChecked === 'boolean' ? { checked: nativeChecked } : ariaChecked === 'true' ? { checked: true } : ariaChecked === 'false' ? { checked: false } : {}),
          ...(ariaSelected === 'true' ? { selected: true } : ariaSelected === 'false' ? { selected: false } : {}),
          ...(ariaExpanded === 'true' ? { expanded: true } : ariaExpanded === 'false' ? { expanded: false } : {}),
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          ref: elementRef(element),
          ...(cssSelector ? { selector: cssSelector } : {})
        });
        if (interactive.length >= maxElements) break;
      }
      if (scanned >= maxScan) continue;
      for (const element of scope.querySelectorAll('*')) {
        scanned += 1;
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (scanned >= maxScan) break;
      }
    }
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
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
        ref: elementRef(active),
        ...(active.getRootNode() === document ? { selector: cssPath(active) } : {}),
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
      interactive_elements: interactive,
      state_token: state.token + ':' + state.version + ':' + location.href
    };
  })()`;
}

function optionalStringField(
  object: Record<string, unknown>,
  name: string,
  maxLength: number
): string | undefined {
  const value = object[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`Browser snapshot ${name} is invalid.`);
  return value;
}

function optionalBooleanField(object: Record<string, unknown>, name: string): boolean | undefined {
  const value = object[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Browser snapshot ${name} is invalid.`);
  return value;
}

function optionalFiniteNumberField(object: Record<string, unknown>, name: string): number | undefined {
  const value = object[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new Error(`Browser snapshot ${name} is invalid.`);
  }
  return value;
}

function parseInteractiveElements(value: unknown[]): BrowserInteractiveElement[] {
  return value.map((raw, index) => {
    const item = objectValue(raw, `Browser interactive element ${index}`);
    const tag = optionalStringField(item, 'tag', 80);
    if (!tag) throw new Error(`Browser interactive element ${index} is missing a valid tag.`);
    const role = optionalStringField(item, 'role', 80);
    const type = optionalStringField(item, 'type', 80);
    const text = optionalStringField(item, 'text', 240);
    const ariaName = optionalStringField(item, 'aria_name', 240);
    const href = optionalStringField(item, 'href', 8192);
    const fieldValue = optionalStringField(item, 'value', 500);
    const ref = optionalStringField(item, 'ref', 16);
    if (ref !== undefined && !/^e[1-9][0-9]{0,6}$/u.test(ref)) throw new Error(`Browser interactive element ${index} ref is invalid.`);
    const selector = optionalStringField(item, 'selector', 4096);
    const disabled = optionalBooleanField(item, 'disabled');
    const checked = optionalBooleanField(item, 'checked');
    const selected = optionalBooleanField(item, 'selected');
    const expanded = optionalBooleanField(item, 'expanded');
    const x = optionalFiniteNumberField(item, 'x');
    const y = optionalFiniteNumberField(item, 'y');
    const width = optionalFiniteNumberField(item, 'width');
    const height = optionalFiniteNumberField(item, 'height');
    if (width !== undefined && width < 0) throw new Error(`Browser interactive element ${index} width is invalid.`);
    if (height !== undefined && height < 0) throw new Error(`Browser interactive element ${index} height is invalid.`);
    return {
      tag,
      ...(role !== undefined ? { role } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(ariaName !== undefined ? { aria_name: ariaName } : {}),
      ...(href !== undefined ? { href } : {}),
      ...(fieldValue !== undefined ? { value: fieldValue } : {}),
      ...(disabled !== undefined ? { disabled } : {}),
      ...(checked !== undefined ? { checked } : {}),
      ...(selected !== undefined ? { selected } : {}),
      ...(expanded !== undefined ? { expanded } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(ref !== undefined ? { ref } : {}),
      ...(selector !== undefined ? { selector } : {})
    };
  });
}

function parseFocusedElement(value: unknown): BrowserFocusedElement | undefined {
  if (value === undefined) return undefined;
  const item = objectValue(value, 'Browser focused element');
  const tag = optionalStringField(item, 'tag', 80);
  if (!tag) throw new Error('Browser focused element is missing a valid tag.');
  const id = optionalStringField(item, 'id', 512);
  const name = optionalStringField(item, 'name', 512);
  const type = optionalStringField(item, 'type', 80);
  const text = optionalStringField(item, 'text', 240);
  const fieldValue = optionalStringField(item, 'value', 500);
  const ariaName = optionalStringField(item, 'aria_name', 240);
  const ref = optionalStringField(item, 'ref', 16);
  if (ref !== undefined && !/^e[1-9][0-9]{0,6}$/u.test(ref)) throw new Error('Browser focused element ref is invalid.');
  const selector = optionalStringField(item, 'selector', 4096);
  const isEditable = optionalBooleanField(item, 'is_editable');
  return {
    tag,
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(fieldValue !== undefined ? { value: fieldValue } : {}),
    ...(ariaName !== undefined ? { aria_name: ariaName } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(selector !== undefined ? { selector } : {}),
    ...(isEditable !== undefined ? { is_editable: isEditable } : {})
  };
}

function parseSnapshotValue(value: unknown): Omit<BrowserSnapshotData, 'page_id' | 'pages' | 'png'> {
  const object = objectValue(value, 'Browser snapshot');
  const viewport = objectValue(object.viewport, 'Browser viewport');
  const pageSize = objectValue(object.page_size, 'Browser page size');
  if (
    typeof object.url !== 'string' || object.url.length > 8192
    || typeof object.title !== 'string' || object.title.length > 4096
    || typeof object.text !== 'string' || object.text.length > 50000
    || typeof viewport.width !== 'number' || !Number.isFinite(viewport.width) || viewport.width < 0 || viewport.width > 1_000_000
    || typeof viewport.height !== 'number' || !Number.isFinite(viewport.height) || viewport.height < 0 || viewport.height > 1_000_000
    || typeof pageSize.width !== 'number' || !Number.isFinite(pageSize.width) || pageSize.width < 0 || pageSize.width > 1_000_000
    || typeof pageSize.height !== 'number' || !Number.isFinite(pageSize.height) || pageSize.height < 0 || pageSize.height > 1_000_000
    || typeof object.state_token !== 'string'
    || object.state_token.length < 3
    || object.state_token.length > 2048
    || !Array.isArray(object.interactive_elements)
    || object.interactive_elements.length > 500
  ) throw new Error('Browser snapshot fields are invalid.');
  const focused = parseFocusedElement(object.focused_element);
  const interactiveElements = parseInteractiveElements(object.interactive_elements);
  return {
    url: object.url,
    title: object.title,
    text: object.text,
    viewport: { width: viewport.width, height: viewport.height },
    page_size: { width: pageSize.width, height: pageSize.height },
    ...(focused ? { focused_element: focused } : {}),
    interactive_elements: interactiveElements,
    state_token: object.state_token
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
    case 'click': {
      const point = objectValue(await evaluate(connection, elementTargetExpression(action.selector, action.ref,
        `if (!el || el.nodeType !== 1) throw new Error('Element is not clickable');
         el.scrollIntoView({block:'center', inline:'center'});
         const rect = el.getBoundingClientRect();
         if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) throw new Error('Element has no clickable bounds');
         const x = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(0, innerWidth - 1));
         const y = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(0, innerHeight - 1));
         const root = el.getRootNode?.();
         const hit = root && typeof root.elementFromPoint === 'function' ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);
         if (!hit || (hit !== el && !el.contains(hit))) throw new Error('Element is covered by another element');
         return {x, y};`), defaultTimeoutMs), 'Browser click point');
      if (typeof point.x !== 'number' || !Number.isFinite(point.x) || typeof point.y !== 'number' || !Number.isFinite(point.y)) {
        throw new Error('Browser click point is invalid.');
      }
      await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' }, defaultTimeoutMs);
      await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }, defaultTimeoutMs);
      await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }, defaultTimeoutMs);
      return;
    }
    case 'hover':
      throw new Error('Browser hover requires the Playwright browser engine.');
    case 'drag':
      throw new Error('Browser drag requires the Playwright browser engine.');
    case 'fill':
      await evaluate(connection, elementTargetExpression(action.selector, action.ref,
        `if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable)) throw new Error('Element is not editable');
         const value = ${JSON.stringify(action.value)};
         if (el.isContentEditable) { el.textContent = value; }
         else { const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value'); if (descriptor?.set) descriptor.set.call(el, value); else el.value = value; }
         el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true;`), defaultTimeoutMs);
      return;
    case 'type_text':
      throw new Error('Browser type_text requires the Playwright browser engine.');
    case 'set_checked':
      throw new Error('Browser set_checked requires the Playwright browser engine.');
    case 'press': {
      if (action.selector || action.ref) {
        await evaluate(connection, elementTargetExpression(action.selector, action.ref, "if (!el || typeof el.focus !== 'function') throw new Error('Element is not focusable'); el.focus(); return true;"), defaultTimeoutMs);
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
      const selectedSelector = action.selector?.trim();
      const selectedRef = action.ref?.trim();
      if (Boolean(selectedSelector) === Boolean(selectedRef)) throw new Error('Browser wait_selector requires exactly one of selector or ref.');
      if (selectedRef && !/^e[1-9][0-9]{0,6}$/u.test(selectedRef)) throw new Error('Browser element ref is invalid.');
      await waitUntil(async () => {
        const lookup = selectedRef
          ? `const ref = ${JSON.stringify(selectedRef)}; const stateObject = globalThis['__deskmcpObservationStateV1']; if (!stateObject || stateObject.refVersion !== stateObject.version) throw new Error('Element ref is unavailable or stale: ' + ref); const el = stateObject.refToElement instanceof Map ? stateObject.refToElement.get(ref) : undefined;`
          : `const el = document.querySelector(${JSON.stringify(selectedSelector)});`;
        const result = await evaluate(connection, `(() => { ${lookup} const attached = Boolean(el && el.nodeType === 1 && el.isConnected); if (${JSON.stringify(state)} === 'attached') return attached; if (${JSON.stringify(state)} === 'detached') return !attached; if (!attached) return ${JSON.stringify(state)} === 'hidden'; const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); const visible = style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; return ${JSON.stringify(state)} === 'visible' ? visible : !visible; })()`, Math.min(timeout, 5000));
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
      await evaluate(connection, elementTargetExpression(action.selector, action.ref,
        `if (!(el instanceof HTMLSelectElement)) throw new Error('Element is not a select'); const value = ${JSON.stringify(action.value)}; if (!Array.from(el.options).some(option => option.value === value)) throw new Error('Select option not found'); el.value = value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;`), defaultTimeoutMs);
      return;
    case 'set_files': {
      if (!Array.isArray(action.files) || action.files.length < 1 || action.files.length > 10 || action.files.some(file => typeof file !== 'string' || file.length === 0 || file.length > 4096)) {
        throw new Error('Browser set_files requires between 1 and 10 validated local file paths.');
      }
      const objectId = await elementObjectId(connection, action.selector, action.ref, defaultTimeoutMs);
      await connection.send('DOM.setFileInputFiles', { files: [...action.files], objectId }, defaultTimeoutMs);
      return;
    }
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

  async createPage(port: number, url?: string, timeoutMs = 5000): Promise<string> {
    const timeout = boundedTimeout(timeoutMs, 5000);
    const targetUrl = url ? normalizeNavigationUrl(url) : 'about:blank';
    const connection = await CdpConnection.connect(await fetchBrowserWebSocketUrl(port, timeout), timeout);
    try {
      const result = objectValue(await connection.send('Target.createTarget', { url: targetUrl }, timeout), 'Browser create page');
      if (typeof result.targetId !== 'string' || !result.targetId) throw new Error('Browser create page returned an invalid target id.');
      return result.targetId;
    } finally {
      connection.close();
    }
  }

  async selectPage(_port: number, _pageId: string, _timeoutMs = 5000): Promise<string> {
    throw new Error('Browser select_page requires the Playwright browser engine.');
  }

  async closePage(port: number, pageId: string, timeoutMs = 5000): Promise<void> {
    const timeout = boundedTimeout(timeoutMs, 5000);
    const targets = await fetchTargets(port, timeout);
    const pages = targets.filter(target => target.type === 'page');
    if (!pages.some(page => page.id === pageId)) throw new Error(`Browser page not found: ${pageId}.`);
    if (pages.length <= 1) throw new Error('Cannot close the last controllable browser page; close the browser session instead.');
    const connection = await CdpConnection.connect(await fetchBrowserWebSocketUrl(port, timeout), timeout);
    try {
      const result = objectValue(await connection.send('Target.closeTarget', { targetId: pageId }, timeout), 'Browser close page');
      if (result.success !== true) throw new Error('Browser close page was not confirmed by Chromium.');
    } finally {
      connection.close();
    }
  }

  async handleDialog(port: number, pageId: string | undefined, accept: boolean, promptText?: string, timeoutMs = 5000): Promise<void> {
    const timeout = boundedTimeout(timeoutMs, 5000);
    if (promptText !== undefined && promptText.length > 4096) throw new Error('Browser dialog prompt_text is too long.');
    const targets = await fetchTargets(port, timeout);
    const target = selectPageTarget(targets, pageId);
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl!, timeout);
    try {
      await connection.send('Page.enable', {}, timeout);
      await connection.send('Page.handleJavaScriptDialog', {
        accept,
        ...(promptText !== undefined ? { promptText } : {})
      }, timeout);
    } finally {
      connection.close();
    }
  }

  async download(_port: number, _pageId: string | undefined, _selector: string | undefined, _ref: string | undefined, _destinationPath: string, _timeoutMs = 5000): Promise<BrowserDownloadData> {
    throw new Error('Browser download requires the Playwright browser engine.');
  }

  async find(_port: number, _pageId: string | undefined, _options: BrowserFindOptions): Promise<BrowserFindData> {
    throw new Error('Browser find mode requires the Playwright browser engine.');
  }

  async stateToken(port: number, pageId: string | undefined, timeoutMs = 5000): Promise<string> {
    const timeout = boundedTimeout(timeoutMs, 5000);
    const targets = await fetchTargets(port, timeout);
    const target = selectPageTarget(targets, pageId);
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl!, timeout);
    try {
      await connection.send('Runtime.enable', {}, timeout);
      const value = await evaluate(connection, `(() => {
        const state = globalThis['__deskmcpObservationStateV1'];
        if (!state || typeof state !== 'object' || typeof state.token !== 'string' || typeof state.version !== 'number') return '';
        return state.token + ':' + state.version + ':' + location.href;
      })()`, timeout);
      if (typeof value !== 'string' || value.length < 3) throw new Error('Browser page state changed after the last snapshot. Take a fresh snapshot.');
      return value;
    } finally {
      connection.close();
    }
  }

  async snapshot(port: number, pageId: string | undefined, options: BrowserSnapshotOptions = {}): Promise<BrowserSnapshotData> {
    const timeout = boundedTimeout(options.timeout_ms, 10000);
    const maxText = options.max_text_chars ?? 8000;
    const maxElements = options.max_interactive_elements ?? 100;
    if (!Number.isInteger(maxText) || maxText < 1 || maxText > 50000) throw new Error('Browser max_text_chars must be between 1 and 50000.');
    if (!Number.isInteger(maxElements) || maxElements < 1 || maxElements > 500) throw new Error('Browser max_interactive_elements must be between 1 and 500.');
    if (options.include_console === true || options.include_network === true) {
      throw new Error('Browser console/network observability requires the Playwright browser engine.');
    }

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
        const viewportPixels = snapshot.viewport.width * snapshot.viewport.height;
        if (options.full_page === true || viewportPixels > MAX_SCREENSHOT_PIXELS) {
          const metrics = objectValue(await connection.send('Page.getLayoutMetrics', {}, timeout), 'Browser layout metrics');
          if (options.full_page === true) {
            const content = objectValue(metrics.cssContentSize ?? metrics.contentSize, 'Browser content size');
            if (typeof content.width === 'number' && typeof content.height === 'number' && content.width > 0 && content.height > 0) {
              const width = Math.min(content.width, 12000);
              const height = Math.min(content.height, 12000);
              const scale = Math.min(1, Math.sqrt(MAX_SCREENSHOT_PIXELS / Math.max(1, width * height)));
              params.captureBeyondViewport = true;
              params.clip = { x: 0, y: 0, width, height, scale };
            }
          } else {
            const visual = objectValue(metrics.cssVisualViewport ?? metrics.visualViewport, 'Browser visual viewport');
            const width = typeof visual.clientWidth === 'number' && visual.clientWidth > 0 ? visual.clientWidth : snapshot.viewport.width;
            const height = typeof visual.clientHeight === 'number' && visual.clientHeight > 0 ? visual.clientHeight : snapshot.viewport.height;
            const x = typeof visual.pageX === 'number' ? visual.pageX : 0;
            const y = typeof visual.pageY === 'number' ? visual.pageY : 0;
            const scale = Math.min(1, Math.sqrt(MAX_SCREENSHOT_PIXELS / Math.max(1, width * height)));
            params.clip = { x, y, width, height, scale };
          }
        }
        const captured = objectValue(await connection.send('Page.captureScreenshot', params, timeout), 'Browser screenshot');
        if (typeof captured.data !== 'string') throw new Error('Browser screenshot payload is invalid.');
        if (captured.data.length > MAX_SCREENSHOT_BASE64_CHARS) throw new Error('Browser screenshot exceeded the encoded safety limit.');
        const decoded = Buffer.from(captured.data, 'base64');
        if (decoded.length > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeded the decoded safety limit.');
        png = decoded;
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
