import { createHash, randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Dialog, type Locator, type Page } from 'playwright-core';
import {
  type BrowserAction,
  type BrowserCdpDriver,
  type BrowserConsoleMessage,
  type BrowserDownloadData,
  type BrowserFindData,
  type BrowserFindMatch,
  type BrowserFindOptions,
  type BrowserFocusedElement,
  type BrowserInteractiveElement,
  type BrowserNetworkEvent,
  type BrowserPageSummary,
  type BrowserSnapshotData,
  type BrowserSnapshotOptions
} from './browser-cdp.js';

const ELEMENT_REF_PATTERN = /^(?:f\d+)*e\d+$/u;
const MAX_ARIA_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARIA_VISITED_NODES = 10_000;
const MAX_SCREENSHOT_PIXELS = 12_000_000;
const MAX_SCREENSHOT_BYTES = 48 * 1024 * 1024;
const MAX_PASSWORD_INPUTS = 100;
const MAX_CONSOLE_BUFFER = 200;
const MAX_NETWORK_BUFFER = 500;
const MAX_CONSOLE_TEXT = 4096;
const MAX_NETWORK_TEXT = 1024;
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'
]);

type ConnectOverCdp = (endpoint: string, options: { timeout: number }) => Promise<Browser>;

interface PlaywrightPortState {
  readonly port: number;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly pages: Map<string, Page>;
  readonly pageIds: WeakMap<Page, string>;
  readonly dialogs: Map<string, Dialog>;
  readonly consoleMessages: Map<string, BrowserConsoleMessage[]>;
  readonly networkEvents: Map<string, BrowserNetworkEvent[]>;
  readonly consoleCaptureEnabled: Set<string>;
  readonly networkCaptureEnabled: Set<string>;
  eventSequence: number;
  activePageId?: string;
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1000 || selected > 60_000) {
    throw new Error('Browser timeout must be between 1000 and 60000ms.');
  }
  return selected;
}

function normalizeNavigationUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw.trim()); }
  catch { throw new Error('Browser navigation URL is invalid.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Browser navigation only supports HTTP(S) URLs.');
  }
  return parsed.toString();
}

function pushBounded<T>(rows: T[], value: T, max: number): void {
  rows.push(value);
  if (rows.length > max) rows.splice(0, rows.length - max);
}

function sanitizeConsoleText(raw: string): string {
  return raw
    .replace(/\b(authorization|cookie|set-cookie)\b\s*[:=]\s*[^\r\n]*/giu, '$1: [REDACTED]')
    .slice(0, MAX_CONSOLE_TEXT);
}

function sanitizeNetworkUrl(raw: string): { url: string; query_redacted: boolean } {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { return { url: '<redacted-invalid-url>', query_redacted: false }; }
  const queryRedacted = parsed.search.length > 0;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { url: `${parsed.protocol}<redacted>`, query_redacted: queryRedacted };
  }
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  const safe = parsed.toString();
  return {
    url: safe.length <= 8192 ? safe : `${parsed.origin}/<redacted-long-path>`,
    query_redacted: queryRedacted
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringValue(value: unknown, max = 8192): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= max ? value : value.slice(0, max);
}

function firstAriaElementNode(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = firstAriaElementNode(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.role === 'string' || typeof row.ref === 'string' || typeof row.name === 'string') return row;
  if (Array.isArray(row.children)) return firstAriaElementNode(row.children);
  return undefined;
}

function flattenAriaTree(value: unknown, maxInteractiveElements: number): BrowserInteractiveElement[] {
  const result: BrowserInteractiveElement[] = [];
  let visited = 0;
  const visit = (node: unknown): void => {
    if (visited++ >= MAX_ARIA_VISITED_NODES || result.length >= maxInteractiveElements) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const row = node as Record<string, unknown>;
    const role = stringValue(row.role, 128);
    const ref = stringValue(row.ref, 128);
    const cursor = stringValue(row.cursor, 64);
    if (role && ref && ELEMENT_REF_PATTERN.test(ref) && (INTERACTIVE_ROLES.has(role) || cursor === 'pointer')) {
      const box = row.box && typeof row.box === 'object' && !Array.isArray(row.box)
        ? row.box as Record<string, unknown>
        : undefined;
      const ariaName = stringValue(row.name, 4096);
      const text = stringValue(row.text, 8192);
      const href = stringValue(row.url, 8192);
      const disabled = booleanValue(row.disabled);
      const checked = booleanValue(row.checked);
      const selected = booleanValue(row.selected);
      const expanded = booleanValue(row.expanded);
      const x = finiteNumber(box?.x);
      const y = finiteNumber(box?.y);
      const width = finiteNumber(box?.width);
      const height = finiteNumber(box?.height);
      const element: BrowserInteractiveElement = {
        tag: role,
        role,
        ref,
        ...(ariaName !== undefined ? { aria_name: ariaName } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(href !== undefined ? { href } : {}),
        ...(row.value !== undefined && (typeof row.value === 'string' || typeof row.value === 'number')
          ? { value: String(row.value).slice(0, 8192) } : {}),
        ...(disabled !== undefined ? { disabled } : {}),
        ...(checked !== undefined ? { checked } : {}),
        ...(selected !== undefined ? { selected } : {}),
        ...(expanded !== undefined ? { expanded } : {}),
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {})
      };
      result.push(element);
    }
    if (Array.isArray(row.children)) visit(row.children);
  };
  visit(value);
  return result;
}

function collectAriaRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectAriaRefs(child, refs);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (typeof row.ref === 'string' && ELEMENT_REF_PATTERN.test(row.ref)) refs.add(row.ref);
  if (Array.isArray(row.children)) collectAriaRefs(row.children, refs);
}

function sanitizeAccessibilityTree(value: unknown, passwordRefs: ReadonlySet<string>, redactAllTextboxes: boolean): unknown {
  if (Array.isArray(value)) return value.map(child => sanitizeAccessibilityTree(child, passwordRefs, redactAllTextboxes));
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  const role = typeof row.role === 'string' ? row.role : undefined;
  const ref = typeof row.ref === 'string' ? row.ref : undefined;
  const redactValue = (ref !== undefined && passwordRefs.has(ref)) ||
    (redactAllTextboxes && (role === 'textbox' || role === 'searchbox'));
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(row)) {
    if (redactValue && (key === 'text' || key === 'value')) continue;
    if (key === 'children' && Array.isArray(child)) {
      sanitized.children = child
        .filter(item => !(redactValue && typeof item === 'string'))
        .map(item => sanitizeAccessibilityTree(item, passwordRefs, redactAllTextboxes));
      continue;
    }
    sanitized[key] = child;
  }
  return sanitized;
}

function findAriaTree(value: unknown, query: string, caseSensitive: boolean, maxResults: number): BrowserFindMatch[] {
  const selected = query.trim();
  if (!selected || selected.length > 1024) throw new Error('Browser find query must contain between 1 and 1024 characters.');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) throw new Error('Browser find max_results must be between 1 and 50.');
  const needle = caseSensitive ? selected : selected.toLocaleLowerCase();
  const results: BrowserFindMatch[] = [];
  let visited = 0;
  const visit = (node: unknown, parents: readonly string[]): void => {
    if (visited++ >= MAX_ARIA_VISITED_NODES || results.length >= maxResults) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parents);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const row = node as Record<string, unknown>;
    const role = stringValue(row.role, 128);
    const name = stringValue(row.name, 1024);
    const text = stringValue(row.text, 2048);
    const ref = stringValue(row.ref, 128);
    const valueText = typeof row.value === 'string' || typeof row.value === 'number' ? String(row.value).slice(0, 2048) : undefined;
    const url = stringValue(row.url, 2048);
    const segment = `${role ?? 'node'}${name ? ` "${name.slice(0, 120)}"` : ''}${ref && ELEMENT_REF_PATTERN.test(ref) ? ` [ref=${ref}]` : ''}`;
    const path = [...parents, segment];
    const searchable = [role, name, text, valueText, url, ref].filter((item): item is string => Boolean(item)).join(' ');
    const haystack = caseSensitive ? searchable : searchable.toLocaleLowerCase();
    if (haystack.includes(needle)) {
      const snippet = [role, name, text, valueText, ref ? `ref=${ref}` : undefined]
        .filter((item): item is string => Boolean(item))
        .join(' | ')
        .slice(0, 2048);
      results.push({
        path: path.join(' > ').slice(0, 4096),
        snippet,
        ...(ref && ELEMENT_REF_PATTERN.test(ref) ? { ref } : {}),
        ...(role ? { role } : {}),
        ...(name ? { name } : {})
      });
    }
    if (Array.isArray(row.children)) visit(row.children, path);
  };
  visit(value, []);
  return results;
}

export class PlaywrightBrowserDriver implements BrowserCdpDriver {
  private readonly states = new Map<number, Promise<PlaywrightPortState>>();

  constructor(private readonly connectOverCdp: ConnectOverCdp = (endpoint, options) => chromium.connectOverCDP(endpoint, options)) {}

  private registerPage(state: PlaywrightPortState, page: Page): string {
    const existing = state.pageIds.get(page);
    if (existing) return existing;
    const id = `page-${randomUUID()}`;
    state.pageIds.set(page, id);
    state.pages.set(id, page);
    state.consoleMessages.set(id, []);
    state.networkEvents.set(id, []);
    page.on('dialog', dialog => {
      state.dialogs.set(id, dialog);
    });
    page.on('console', message => {
      try {
        if (!state.consoleCaptureEnabled.has(id)) return;
        const rows = state.consoleMessages.get(id);
        if (!rows) return;
        pushBounded(rows, {
          sequence: ++state.eventSequence,
          timestamp: new Date().toISOString(),
          type: message.type().slice(0, 64),
          text: sanitizeConsoleText(message.text())
        }, MAX_CONSOLE_BUFFER);
      } catch {
        // Observability must never destabilize browser control.
      }
    });
    page.on('request', request => {
      try {
        if (!state.networkCaptureEnabled.has(id)) return;
        const rows = state.networkEvents.get(id);
        if (!rows) return;
        const safeUrl = sanitizeNetworkUrl(request.url());
        pushBounded(rows, {
          sequence: ++state.eventSequence,
          timestamp: new Date().toISOString(),
          phase: 'request',
          method: request.method().slice(0, 32),
          url: safeUrl.url,
          query_redacted: safeUrl.query_redacted,
          resource_type: request.resourceType().slice(0, 64)
        }, MAX_NETWORK_BUFFER);
      } catch {
        // Observability must never destabilize browser control.
      }
    });
    page.on('response', response => {
      try {
        if (!state.networkCaptureEnabled.has(id)) return;
        const rows = state.networkEvents.get(id);
        if (!rows) return;
        const request = response.request();
        const safeUrl = sanitizeNetworkUrl(response.url());
        pushBounded(rows, {
          sequence: ++state.eventSequence,
          timestamp: new Date().toISOString(),
          phase: 'response',
          method: request.method().slice(0, 32),
          url: safeUrl.url,
          query_redacted: safeUrl.query_redacted,
          resource_type: request.resourceType().slice(0, 64),
          status: response.status(),
          status_text: sanitizeConsoleText(response.statusText()).slice(0, MAX_NETWORK_TEXT)
        }, MAX_NETWORK_BUFFER);
      } catch {
        // Observability must never destabilize browser control.
      }
    });
    page.on('requestfailed', request => {
      try {
        if (!state.networkCaptureEnabled.has(id)) return;
        const rows = state.networkEvents.get(id);
        if (!rows) return;
        const safeUrl = sanitizeNetworkUrl(request.url());
        pushBounded(rows, {
          sequence: ++state.eventSequence,
          timestamp: new Date().toISOString(),
          phase: 'failed',
          method: request.method().slice(0, 32),
          url: safeUrl.url,
          query_redacted: safeUrl.query_redacted,
          resource_type: request.resourceType().slice(0, 64),
          failure_text: sanitizeConsoleText(request.failure()?.errorText ?? 'request failed').slice(0, MAX_NETWORK_TEXT)
        }, MAX_NETWORK_BUFFER);
      } catch {
        // Observability must never destabilize browser control.
      }
    });
    page.once('close', () => {
      state.pages.delete(id);
      state.dialogs.delete(id);
      state.consoleMessages.delete(id);
      state.networkEvents.delete(id);
      state.consoleCaptureEnabled.delete(id);
      state.networkCaptureEnabled.delete(id);
      if (state.activePageId === id) {
        const next = state.pages.keys().next().value as string | undefined;
        if (next) state.activePageId = next;
        else delete state.activePageId;
      }
    });
    return id;
  }

  private async connect(port: number, timeoutMs: number): Promise<PlaywrightPortState> {
    const browser = await this.connectOverCdp(`http://127.0.0.1:${port}`, { timeout: timeoutMs });
    const context = browser.contexts()[0];
    if (!context) {
      // Do not call browser.close() on a connectOverCDP() browser. That can send Browser.close
      // to the externally launched Chromium process; ProcessHost remains the sole process owner.
      throw new Error('Playwright CDP connection did not expose the default Chromium context.');
    }
    const state: PlaywrightPortState = {
      port,
      browser,
      context,
      pages: new Map<string, Page>(),
      pageIds: new WeakMap<Page, string>(),
      dialogs: new Map<string, Dialog>(),
      consoleMessages: new Map<string, BrowserConsoleMessage[]>(),
      networkEvents: new Map<string, BrowserNetworkEvent[]>(),
      consoleCaptureEnabled: new Set<string>(),
      networkCaptureEnabled: new Set<string>(),
      eventSequence: 0
    };
    for (const page of context.pages()) {
      const id = this.registerPage(state, page);
      if (!state.activePageId) state.activePageId = id;
    }
    context.on('page', page => {
      state.activePageId = this.registerPage(state, page);
    });
    browser.once('disconnected', () => {
      const current = this.states.get(port);
      if (current) void current.then(value => {
        if (value === state) this.states.delete(port);
      }).catch(() => undefined);
    });
    return state;
  }

  private async state(port: number, timeoutMs = 5000): Promise<PlaywrightPortState> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Browser CDP port is invalid.');
    const existing = this.states.get(port);
    if (existing) {
      const resolved = await existing;
      if (resolved.browser.isConnected()) return resolved;
      this.states.delete(port);
    }
    const pending = this.connect(port, boundedTimeout(timeoutMs, 5000));
    this.states.set(port, pending);
    try { return await pending; }
    catch (error) {
      if (this.states.get(port) === pending) this.states.delete(port);
      throw error;
    }
  }

  private page(state: PlaywrightPortState, pageId?: string): { id: string; page: Page } {
    const id = pageId ?? state.activePageId ?? state.pages.keys().next().value as string | undefined;
    if (!id) throw new Error('Browser has no controllable page.');
    const page = state.pages.get(id);
    if (!page || page.isClosed()) throw new Error(`Browser page not found: ${id}.`);
    state.activePageId = id;
    return { id, page };
  }

  private locator(page: Page, selector?: string, ref?: string): Locator {
    const selectedSelector = selector?.trim();
    const selectedRef = ref?.trim();
    if (Boolean(selectedSelector) === Boolean(selectedRef)) {
      throw new Error('Browser element action requires exactly one of selector or ref.');
    }
    if (selectedRef) {
      if (!ELEMENT_REF_PATTERN.test(selectedRef)) throw new Error('Browser element ref is invalid.');
      return page.locator(`aria-ref=${selectedRef}`);
    }
    return page.locator(selectedSelector!);
  }

  private pendingDialogError(pageId: string): Error {
    return new Error(`Browser JavaScript dialog is pending on page ${pageId}. Use desktop_browser_session action=handle_dialog, then take a fresh browser snapshot.`);
  }

  private async runWithDialogInterrupt<T>(state: PlaywrightPortState, pageId: string, page: Page, operation: () => Promise<T>): Promise<T> {
    if (state.dialogs.has(pageId)) throw this.pendingDialogError(pageId);
    let rejectDialog!: (error: Error) => void;
    const dialogPromise = new Promise<never>((_resolve, reject) => { rejectDialog = reject; });
    const listener = () => { rejectDialog(this.pendingDialogError(pageId)); };
    page.once('dialog', listener);
    const operationPromise = operation();
    try {
      return await Promise.race([operationPromise, dialogPromise]);
    } catch (error) {
      if (state.dialogs.has(pageId)) void operationPromise.catch(() => undefined);
      throw error;
    } finally {
      page.off('dialog', listener);
    }
  }

  private async passwordRefs(page: Page, timeoutMs: number): Promise<{ refs: Set<string>; complete: boolean }> {
    const refs = new Set<string>();
    let totalPasswords = 0;
    let complete = true;
    for (const frame of page.frames()) {
      const passwords = frame.locator('input[type=password]');
      let count: number;
      try { count = await passwords.count(); }
      catch {
        complete = false;
        continue;
      }
      totalPasswords += count;
      if (totalPasswords > MAX_PASSWORD_INPUTS) {
        throw new Error(`Browser page contains more than ${MAX_PASSWORD_INPUTS} password inputs; snapshot refused to preserve privacy.`);
      }
      for (let index = 0; index < count; index++) {
        const before = refs.size;
        try {
          const scoped = await passwords.nth(index).ariaSnapshotJSON({ mode: 'ai', boxes: false, timeout: timeoutMs });
          collectAriaRefs(scoped, refs);
        } catch {
          complete = false;
        }
        if (refs.size === before) complete = false;
      }
    }
    return { refs, complete: complete && refs.size >= totalPasswords };
  }

  private async accessibilityState(page: Page, timeoutMs: number, sanitizeForPublic = false): Promise<{ tree: unknown; token: string }> {
    const rawTree = await page.ariaSnapshotJSON({ mode: 'ai', boxes: true, timeout: timeoutMs });
    let serialized: string;
    try { serialized = JSON.stringify(rawTree); }
    catch { throw new Error('Browser accessibility snapshot could not be serialized safely.'); }
    const encodedBytes = Buffer.byteLength(serialized, 'utf8');
    if (encodedBytes > MAX_ARIA_JSON_BYTES) throw new Error('Browser accessibility snapshot exceeded the safety limit.');
    const token = `aria-v1:${createHash('sha256').update(page.url(), 'utf8').update('\0').update(serialized, 'utf8').digest('hex')}`;
    if (!sanitizeForPublic) return { tree: rawTree, token };
    const passwords = await this.passwordRefs(page, timeoutMs);
    return {
      tree: sanitizeAccessibilityTree(rawTree, passwords.refs, !passwords.complete),
      token
    };
  }

  private async focusedElement(page: Page, timeoutMs: number): Promise<BrowserFocusedElement | undefined> {
    const frames = [...page.frames()].reverse();
    for (const frame of frames) {
      const focused = frame.locator(':focus');
      let count: number;
      try { count = await focused.count(); }
      catch { continue; }
      if (count < 1) continue;
      const locator = focused.nth(0);
      let dom: { tag: string; id?: string; name?: string; type?: string; isEditable: boolean; isPassword: boolean } | undefined;
      try {
        dom = await locator.evaluate(element => {
          const html = element as HTMLElement;
          const tag = String(element.tagName ?? '').toLowerCase();
          const input = element instanceof HTMLInputElement ? element : undefined;
          return {
            tag,
            ...(html.id ? { id: html.id } : {}),
            ...(html.getAttribute('name') ? { name: html.getAttribute('name')! } : {}),
            ...(input?.type ? { type: input.type } : {}),
            isEditable: Boolean(input || element instanceof HTMLTextAreaElement || html.isContentEditable),
            isPassword: Boolean(input && input.type.toLowerCase() === 'password')
          };
        }, undefined, { timeout: timeoutMs });
      } catch {
        continue;
      }
      if (!dom?.tag || dom.tag === 'html' || dom.tag === 'body') continue;

      let aria: Record<string, unknown> | undefined;
      try {
        aria = firstAriaElementNode(await locator.ariaSnapshotJSON({ mode: 'ai', boxes: false, timeout: timeoutMs }));
      } catch { }
      const role = stringValue(aria?.role, 128);
      const ariaName = stringValue(aria?.name, 1024);
      const candidateRef = stringValue(aria?.ref, 128);
      const ref = candidateRef && ELEMENT_REF_PATTERN.test(candidateRef) ? candidateRef : undefined;
      return {
        tag: dom.tag,
        ...(role ? { role } : {}),
        ...(dom.id ? { id: dom.id } : {}),
        ...(dom.name ? { name: dom.name } : {}),
        ...(dom.type ? { type: dom.type } : {}),
        ...(ariaName ? { aria_name: ariaName } : {}),
        ...(ref ? { ref } : {}),
        is_editable: dom.isEditable
      };
    }
    return undefined;
  }

  async listPages(port: number, timeoutMs = 5000): Promise<readonly BrowserPageSummary[]> {
    const state = await this.state(port, timeoutMs);
    const rows: BrowserPageSummary[] = [];
    for (const [id, page] of state.pages) {
      if (page.isClosed()) continue;
      rows.push({
        page_id: id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: id === state.activePageId
      });
    }
    return rows;
  }

  async createPage(port: number, url?: string, timeoutMs = 5000): Promise<string> {
    const timeout = boundedTimeout(timeoutMs, 5000);
    const state = await this.state(port, timeout);
    const page = await state.context.newPage();
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    const id = this.registerPage(state, page);
    state.activePageId = id;
    if (url) await page.goto(normalizeNavigationUrl(url), { waitUntil: 'domcontentloaded', timeout });
    return id;
  }

  async selectPage(port: number, pageId: string, timeoutMs = 5000): Promise<string> {
    const state = await this.state(port, boundedTimeout(timeoutMs, 5000));
    return this.page(state, pageId).id;
  }

  async closePage(port: number, pageId: string, timeoutMs = 5000): Promise<void> {
    const timeout = boundedTimeout(timeoutMs, 5000);
    const state = await this.state(port, timeout);
    const livePages = [...state.pages.entries()].filter(([, page]) => !page.isClosed());
    if (livePages.length <= 1) throw new Error('Cannot close the last controllable browser page; close the browser session instead.');
    const page = state.pages.get(pageId);
    if (!page || page.isClosed()) throw new Error(`Browser page not found: ${pageId}.`);
    await page.close({ runBeforeUnload: false });
  }

  async handleDialog(port: number, pageId: string | undefined, accept: boolean, promptText?: string, timeoutMs = 5000): Promise<void> {
    const timeout = boundedTimeout(timeoutMs, 5000);
    const state = await this.state(port, timeout);
    const selected = this.page(state, pageId);
    const dialog = state.dialogs.get(selected.id);
    if (!dialog) throw new Error('Browser has no pending JavaScript dialog on the requested page.');
    if (promptText !== undefined && promptText.length > 4096) throw new Error('Browser dialog prompt_text is too long.');
    try {
      if (accept) await dialog.accept(promptText);
      else await dialog.dismiss();
    } finally {
      if (state.dialogs.get(selected.id) === dialog) state.dialogs.delete(selected.id);
    }
  }

  async download(
    port: number,
    pageId: string | undefined,
    selector: string | undefined,
    ref: string | undefined,
    destinationPath: string,
    timeoutMs = 15_000
  ): Promise<BrowserDownloadData> {
    const timeout = boundedTimeout(timeoutMs, 15_000);
    if (!destinationPath.trim()) throw new Error('Browser download destination path is required.');
    const state = await this.state(port, timeout);
    const selected = this.page(state, pageId);
    const page = selected.page;
    page.setDefaultTimeout(timeout);
    const locator = this.locator(page, selector, ref);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      locator.click({ timeout })
    ]);
    const failure = await download.failure();
    if (failure) throw new Error(`Browser download failed: ${failure}`);
    await download.saveAs(destinationPath);
    const suggested = download.suggestedFilename().trim();
    return {
      page_id: selected.id,
      suggested_filename: suggested || 'download.bin',
      path: destinationPath
    };
  }

  async find(port: number, pageId: string | undefined, options: BrowserFindOptions): Promise<BrowserFindData> {
    const timeout = boundedTimeout(options.timeout_ms, 5000);
    const maxResults = options.max_results ?? 20;
    const state = await this.state(port, timeout);
    const selected = this.page(state, pageId);
    if (state.dialogs.has(selected.id)) throw this.pendingDialogError(selected.id);
    const accessibility = await this.accessibilityState(selected.page, timeout, true);
    return {
      page_id: selected.id,
      pages: await this.listPages(port, timeout),
      url: selected.page.url(),
      title: await selected.page.title().catch(() => ''),
      matches: findAriaTree(accessibility.tree, options.query, options.case_sensitive === true, maxResults),
      state_token: accessibility.token
    };
  }

  async stateToken(port: number, pageId: string | undefined, timeoutMs = 5000): Promise<string> {
    const timeout = boundedTimeout(timeoutMs, 5000);
    const state = await this.state(port, timeout);
    const selected = this.page(state, pageId);
    if (state.dialogs.has(selected.id)) throw this.pendingDialogError(selected.id);
    return (await this.accessibilityState(selected.page, timeout)).token;
  }

  async snapshot(port: number, pageId: string | undefined, options: BrowserSnapshotOptions = {}): Promise<BrowserSnapshotData> {
    const timeout = boundedTimeout(options.timeout_ms, 10_000);
    const maxText = options.max_text_chars ?? 8000;
    const maxElements = options.max_interactive_elements ?? 100;
    const maxConsole = options.max_console_messages ?? 50;
    const maxNetwork = options.max_network_events ?? 100;
    if (!Number.isInteger(maxText) || maxText < 1 || maxText > 50_000) throw new Error('Browser max_text_chars must be between 1 and 50000.');
    if (!Number.isInteger(maxElements) || maxElements < 1 || maxElements > 500) throw new Error('Browser max_interactive_elements must be between 1 and 500.');
    if (!Number.isInteger(maxConsole) || maxConsole < 1 || maxConsole > MAX_CONSOLE_BUFFER) throw new Error(`Browser max_console_messages must be between 1 and ${MAX_CONSOLE_BUFFER}.`);
    if (!Number.isInteger(maxNetwork) || maxNetwork < 1 || maxNetwork > MAX_NETWORK_BUFFER) throw new Error(`Browser max_network_events must be between 1 and ${MAX_NETWORK_BUFFER}.`);
    const state = await this.state(port, timeout);
    const selected = this.page(state, pageId);
    if (options.include_console === true) state.consoleCaptureEnabled.add(selected.id);
    if (options.include_network === true) state.networkCaptureEnabled.add(selected.id);
    if (state.dialogs.has(selected.id)) throw this.pendingDialogError(selected.id);
    const page = selected.page;
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    const accessibility = await this.accessibilityState(page, timeout, true);
    const interactiveElements = flattenAriaTree(accessibility.tree, maxElements);
    const focusedElement = await this.focusedElement(page, timeout);
    const text = (await page.locator('body').innerText({ timeout }).catch(() => '')).slice(0, maxText);
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const pageSize = await page.evaluate(() => ({
      width: Math.max(document.documentElement?.scrollWidth ?? 0, document.body?.scrollWidth ?? 0, window.innerWidth),
      height: Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0, window.innerHeight)
    }));
    let png: Uint8Array | undefined;
    if (options.screenshot !== false) {
      const width = options.full_page === true ? pageSize.width : viewport.width;
      const height = options.full_page === true ? pageSize.height : viewport.height;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > MAX_SCREENSHOT_PIXELS) {
        throw new Error(`Browser screenshot exceeds the ${MAX_SCREENSHOT_PIXELS}-pixel safety budget.`);
      }
      const data = await page.screenshot({ type: 'png', fullPage: options.full_page === true, timeout });
      if (data.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeded the decoded safety limit.');
      if (data.byteLength < 8 || data[0] !== 137 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71 || data[4] !== 13 || data[5] !== 10 || data[6] !== 26 || data[7] !== 10) {
        throw new Error('Browser screenshot was not a valid PNG payload.');
      }
      png = data;
    }
    return {
      page_id: selected.id,
      pages: await this.listPages(port, timeout),
      url: page.url(),
      title: await page.title().catch(() => ''),
      text,
      viewport,
      page_size: pageSize,
      ...(focusedElement ? { focused_element: focusedElement } : {}),
      interactive_elements: interactiveElements,
      ...(options.include_console === true ? { console_messages: [...(state.consoleMessages.get(selected.id) ?? [])].slice(-maxConsole) } : {}),
      ...(options.include_network === true ? { network_events: [...(state.networkEvents.get(selected.id) ?? [])].slice(-maxNetwork) } : {}),
      state_token: accessibility.token,
      ...(png ? { png } : {})
    };
  }

  async act(port: number, pageId: string | undefined, actions: readonly BrowserAction[], timeoutMs = 15_000): Promise<string> {
    const timeout = boundedTimeout(timeoutMs, 15_000);
    if (actions.length < 1 || actions.length > 20) throw new Error('Browser actions must contain between 1 and 20 items.');
    const state = await this.state(port, timeout);
    const selected = this.page(state, pageId);
    const page = selected.page;
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    const run = <T>(operation: () => Promise<T>) => this.runWithDialogInterrupt(state, selected.id, page, operation);
    for (const action of actions) {
      switch (action.type) {
        case 'goto':
          await run(() => page.goto(normalizeNavigationUrl(action.url), { waitUntil: action.wait_until ?? 'domcontentloaded', timeout: boundedTimeout(action.timeout_ms, timeout) }));
          break;
        case 'click':
          await run(() => this.locator(page, action.selector, action.ref).click({ timeout }));
          break;
        case 'hover':
          await run(() => this.locator(page, action.selector, action.ref).hover({ timeout }));
          break;
        case 'drag': {
          const source = this.locator(page, action.source_selector, action.source_ref);
          const target = this.locator(page, action.target_selector, action.target_ref);
          await run(() => source.dragTo(target, { timeout }));
          break;
        }
        case 'fill':
          await run(() => this.locator(page, action.selector, action.ref).fill(action.value, { timeout }));
          break;
        case 'type_text': {
          if (action.text.length > 65_536) throw new Error('Browser type_text text is too long.');
          const delay = action.delay_ms ?? 0;
          if (!Number.isInteger(delay) || delay < 0 || delay > 250) throw new Error('Browser type_text delay_ms must be between 0 and 250.');
          await run(() => this.locator(page, action.selector, action.ref).pressSequentially(action.text, { delay, timeout }));
          break;
        }
        case 'set_checked':
          await run(() => this.locator(page, action.selector, action.ref).setChecked(action.checked, { timeout }));
          break;
        case 'press':
          if (action.selector || action.ref) await run(() => this.locator(page, action.selector, action.ref).press(action.key, { timeout }));
          else await run(() => page.keyboard.press(action.key));
          break;
        case 'wait':
          if (!Number.isInteger(action.duration_ms) || action.duration_ms < 0 || action.duration_ms > 30_000) throw new Error('Browser wait duration_ms must be between 0 and 30000.');
          await run(() => page.waitForTimeout(action.duration_ms));
          break;
        case 'wait_selector':
          await run(() => this.locator(page, action.selector, action.ref).waitFor({ state: action.state ?? 'visible', timeout: boundedTimeout(action.timeout_ms, timeout) }));
          break;
        case 'wait_url':
          await run(() => page.waitForURL(normalizeNavigationUrl(action.url), { timeout: boundedTimeout(action.timeout_ms, timeout) }));
          break;
        case 'wait_text': {
          const locator = page.getByText(action.text, { exact: action.exact === true }).first();
          await run(() => locator.waitFor({ state: action.state === 'hidden' ? 'hidden' : 'visible', timeout: boundedTimeout(action.timeout_ms, timeout) }));
          break;
        }
        case 'select':
          await run(() => this.locator(page, action.selector, action.ref).selectOption(action.value, { timeout }));
          break;
        case 'set_files':
          await run(() => this.locator(page, action.selector, action.ref).setInputFiles([...action.files], { timeout }));
          break;
        case 'scroll':
          await run(() => page.evaluate(({ x, y }) => window.scrollBy(x, y), { x: Math.trunc(action.delta_x ?? 0), y: Math.trunc(action.delta_y ?? 0) }));
          break;
        case 'navigation':
          if (action.direction === 'reload') await run(() => page.reload({ waitUntil: 'domcontentloaded', timeout: boundedTimeout(action.timeout_ms, timeout) }));
          else if (action.direction === 'back') await run(() => page.goBack({ waitUntil: 'domcontentloaded', timeout: boundedTimeout(action.timeout_ms, timeout) }));
          else await run(() => page.goForward({ waitUntil: 'domcontentloaded', timeout: boundedTimeout(action.timeout_ms, timeout) }));
          break;
      }
    }
    return state.activePageId ?? selected.id;
  }
}
