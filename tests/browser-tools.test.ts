import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AuditLogger } from '../src/audit.js';
import type { BrowserRuntime } from '../src/browser-runtime.js';
import { DesktopBackendBridge } from '../src/desktop-backend-bridge.js';
import { DesktopPolicy, type PermissionProfile } from '../src/desktop-policy.js';
import { startHttpServer } from '../src/http-server.js';
import { ObservationStore } from '../src/observation-store.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

class StubBrowserRuntime {
  startCalls = 0;
  listCalls = 0;
  closeCalls = 0;
  snapshotCalls = 0;
  actCalls = 0;

  info() {
    return {
      configured: true,
      process_ownership: 'deskmcp-job-object' as const,
      profile_isolation: true as const,
      reuse_existing_cdp: false as const,
      active_sessions: 0
    };
  }

  async start() {
    this.startCalls += 1;
    return {
      session_id: SESSION_ID,
      profile_id: 'tool-test',
      persistent_profile: true,
      headless: true,
      created_at: new Date(0).toISOString(),
      active: true,
      page_id: 'page-1',
      url: 'about:blank',
      title: '',
      pages: [{ page_id: 'page-1', url: 'about:blank', title: '', active: true }]
    };
  }

  async list() {
    this.listCalls += 1;
    return [];
  }

  async close(sessionId: string) {
    this.closeCalls += 1;
    return { session_id: sessionId, closed: true };
  }

  async snapshot(sessionId: string) {
    this.snapshotCalls += 1;
    return {
      session_id: sessionId,
      page_id: 'page-1',
      pages: [{ page_id: 'page-1', url: 'about:blank', title: '', active: true }],
      url: 'about:blank',
      title: '',
      text: 'snapshot',
      viewport: { width: 1000, height: 700 },
      page_size: { width: 1000, height: 700 },
      interactive_elements: []
    };
  }

  async act(sessionId: string) {
    this.actCalls += 1;
    return this.snapshot(sessionId);
  }
}

async function withBrowserClient<T>(
  profile: PermissionProfile,
  operation: (client: Client, browser: StubBrowserRuntime) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-browser-tools-'));
  const policy = await DesktopPolicy.create({ profile, allowedRoots: [root] });
  const audit = new AuditLogger(path.join(root, 'audit.jsonl'));
  await audit.init();
  const bridge = new DesktopBackendBridge();
  const observations = new ObservationStore();
  const sessions = new ProcessSessionRegistry();
  const browser = new StubBrowserRuntime();
  const running = await startHttpServer(
    '127.0.0.1',
    0,
    bridge,
    policy,
    audit,
    observations,
    sessions,
    undefined,
    undefined,
    undefined,
    undefined,
    browser as unknown as BrowserRuntime
  );
  const client = new Client(
    { name: 'deskmcp-browser-tools-test', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } }
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));
    return await operation(client, browser);
  } finally {
    await client.close().catch(() => undefined);
    await running.close();
    await bridge.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

function contentText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n');
}

test('browser MCP tools stay discoverable but Read and Write cannot invoke browser runtime', async () => {
  for (const profile of ['read-only', 'workspace-write'] as const) {
    await withBrowserClient(profile, async (client, browser) => {
      const listed = await client.listTools();
      const names = new Set(listed.tools.map(tool => tool.name));
      assert.equal(names.has('desktop_browser_session'), true);
      assert.equal(names.has('desktop_browser_snapshot'), true);
      assert.equal(names.has('desktop_browser_act'), true);

      const session = await client.callTool({ name: 'desktop_browser_session', arguments: { action: 'list' } });
      const snapshot = await client.callTool({
        name: 'desktop_browser_snapshot',
        arguments: { session_id: SESSION_ID, screenshot: false }
      });
      const act = await client.callTool({
        name: 'desktop_browser_act',
        arguments: {
          session_id: SESSION_ID,
          screenshot: false,
          actions: [{ type: 'wait', duration_ms: 0 }]
        }
      });

      for (const result of [session, snapshot, act]) {
        assert.equal(result.isError, true);
        assert.match(contentText(result), /Full Control|fully-unlocked/i);
      }
      assert.deepEqual(
        [browser.startCalls, browser.listCalls, browser.closeCalls, browser.snapshotCalls, browser.actCalls],
        [0, 0, 0, 0, 0]
      );
    });
  }
});

test('browser MCP tools allow Full Control and Fully Unlocked through the stable facade', async () => {
  for (const profile of ['full-control', 'fully-unlocked'] as const) {
    await withBrowserClient(profile, async (client, browser) => {
      const start = await client.callTool({
        name: 'desktop_browser_session',
        arguments: { action: 'start', profile_id: 'tool-test', headless: true }
      });
      assert.equal(start.isError, undefined);
      assert.match(contentText(start), new RegExp(SESSION_ID));

      const snapshot = await client.callTool({
        name: 'desktop_browser_snapshot',
        arguments: { session_id: SESSION_ID, screenshot: false }
      });
      assert.equal(snapshot.isError, undefined);
      assert.match(contentText(snapshot), /snapshot/);

      const act = await client.callTool({
        name: 'desktop_browser_act',
        arguments: {
          session_id: SESSION_ID,
          screenshot: false,
          actions: [{ type: 'wait', duration_ms: 0 }]
        }
      });
      assert.equal(act.isError, undefined);

      const close = await client.callTool({
        name: 'desktop_browser_session',
        arguments: { action: 'close', session_id: SESSION_ID }
      });
      assert.equal(close.isError, undefined);
      assert.match(contentText(close), /"closed": true/);
      assert.deepEqual(
        [browser.startCalls, browser.closeCalls, browser.snapshotCalls, browser.actCalls],
        [1, 1, 2, 1]
      );
    });
  }
});
