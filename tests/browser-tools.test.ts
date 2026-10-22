import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AuditLogger } from '../src/audit.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { TaskContextStore } from '../src/task-context.js';
import { SkillStore } from '../src/skill-store.js';
import { DynamicMcpHub } from '../src/dynamic-mcp-hub.js';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';
import type { BrowserRuntime } from '../src/browser-runtime.js';
import type { BrowserCrossToolGuard } from '../src/browser-cross-tool-guard.js';
import { createBrowserCrossToolGuard } from '../src/browser-cross-tool-guard.js';
import { createBrowserHandoffBoundary } from '../src/browser-handoff-boundary.js';
import { DesktopBackendBridge } from '../src/desktop-backend-bridge.js';
import { DesktopPolicy, type PermissionProfile } from '../src/desktop-policy.js';
import { startHttpServer } from '../src/http-server.js';
import { ObservationStore } from '../src/observation-store.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVATION_ID = '22222222-2222-4222-8222-222222222222';

class StubBrowserRuntime {
  startCalls = 0;
  listCalls = 0;
  closeCalls = 0;
  newPageCalls = 0;
  selectPageCalls = 0;
  closePageCalls = 0;
  handleDialogCalls = 0;
  listProfilesCalls = 0;
  deleteProfileCalls = 0;
  snapshotCalls = 0;
  findCalls = 0;
  actCalls = 0;
  downloadCalls = 0;
  lastActActions: unknown[] | undefined;
  lastSnapshotOptions: unknown;

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

  async newPage(sessionId: string, url?: string) {
    this.newPageCalls += 1;
    return {
      session_id: sessionId,
      page_id: 'page-2',
      pages: [
        { page_id: 'page-1', url: 'about:blank', title: '', active: false },
        { page_id: 'page-2', url: url ?? 'about:blank', title: '', active: true }
      ]
    };
  }

  async selectPage(sessionId: string, pageId: string) {
    this.selectPageCalls += 1;
    return {
      session_id: sessionId,
      page_id: pageId,
      selected: true,
      observation_required_before_next_action: true,
      pages: [
        { page_id: 'page-1', url: 'about:blank', title: '', active: pageId === 'page-1' },
        { page_id: 'page-2', url: 'https://example.com/new', title: '', active: pageId === 'page-2' }
      ]
    };
  }

  async closePage(sessionId: string, pageId: string) {
    this.closePageCalls += 1;
    return {
      session_id: sessionId,
      page_id: pageId,
      closed: true,
      pages: [{ page_id: 'page-1', url: 'about:blank', title: '', active: true }]
    };
  }

  async handleDialog(sessionId: string, pageId: string, accept: boolean, promptText?: string) {
    this.handleDialogCalls += 1;
    return {
      session_id: sessionId,
      page_id: pageId,
      handled: true,
      observation_required_before_next_action: true,
      accept,
      ...(promptText !== undefined ? { prompt_text: promptText } : {})
    };
  }

  async listProfiles() {
    this.listProfilesCalls += 1;
    return [{ profile_id: 'tool-test', in_use: false, modified_at: new Date(0).toISOString() }];
  }

  async deleteProfile(profileId: string) {
    this.deleteProfileCalls += 1;
    return { profile_id: profileId, deleted: true };
  }

  async snapshot(sessionId: string, _pageId?: string, options?: unknown) {
    this.snapshotCalls += 1;
    this.lastSnapshotOptions = options;
    return {
      session_id: sessionId,
      browser_observation_id: OBSERVATION_ID,
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

  async find(sessionId: string, pageId: string | undefined, options: { query: string; case_sensitive?: boolean; max_results?: number }) {
    this.findCalls += 1;
    this.lastSnapshotOptions = options;
    return {
      session_id: sessionId,
      browser_observation_id: OBSERVATION_ID,
      page_id: pageId ?? 'page-1',
      pages: [{ page_id: 'page-1', url: 'about:blank', title: '', active: true }],
      url: 'about:blank',
      title: '',
      matches: [{ path: 'document > button "Submit" [ref=f1e2]', snippet: `button | ${options.query} | ref=f1e2`, ref: 'f1e2', role: 'button', name: 'Submit' }]
    };
  }

  async download(sessionId: string, _pageId: string | undefined, _observationId: string, selector: string | undefined, ref: string | undefined) {
    this.downloadCalls += 1;
    this.lastActActions = [{ type: 'download', ...(selector ? { selector } : {}), ...(ref ? { ref } : {}) }];
    return {
      ...(await this.snapshot(sessionId)),
      download: {
        artifact_id: 'art_11111111111111111111111111111111',
        filename: 'download.txt',
        mime_type: 'text/plain; charset=utf-8',
        size_bytes: 12,
        sha256: '0'.repeat(64),
        created_at: new Date(0).toISOString(),
        expires_at: new Date(60_000).toISOString()
      }
    };
  }

  async act(sessionId: string, _pageId: string | undefined, _observationId: string, actions: readonly unknown[]) {
    this.actCalls += 1;
    this.lastActActions = [...actions];
    return this.snapshot(sessionId);
  }
}

async function withBrowserClient<T>(
  profile: PermissionProfile,
  operation: (client: Client, browser: StubBrowserRuntime, root: string) => Promise<T>,
  guard?: BrowserCrossToolGuard,
  configureHub?: (hub: DynamicMcpHub) => void
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-browser-tools-'));
  const policy = await DesktopPolicy.create({ profile, allowedRoots: [root] });
  const audit = new AuditLogger(path.join(root, 'audit.jsonl'));
  await audit.init();
  const bridge = new DesktopBackendBridge();
  const observations = new ObservationStore();
  const sessions = new ProcessSessionRegistry();
  const browser = new StubBrowserRuntime();
  if (guard) Object.assign(browser, {crossToolGuard: () => guard});
  const tasks = guard ? new TaskContextStore(path.join(root, 'tasks')) : undefined;
  const artifacts = guard ? new ArtifactStore(path.join(root, 'artifacts')) : undefined;
  const hub = guard ? new DynamicMcpHub(path.join(root, 'mcp-hub')) : undefined;
  const skills = guard ? new SkillStore(path.join(root, 'skills')) : undefined;
  const desktop = guard ? ({ status: async () => { throw new Error('Test must not reach native desktop'); } } as unknown as AgentDesktopManager) : undefined;
  await tasks?.init();
  await artifacts?.init();
  await hub?.init();
  if (hub && configureHub) configureHub(hub);
  await skills?.init();
  const running = await startHttpServer(
    '127.0.0.1',
    0,
    bridge,
    policy,
    audit,
    observations,
    sessions,
    undefined,
    tasks,
    artifacts,
    hub,
    browser as unknown as BrowserRuntime,
    skills,
    desktop
  );
  const client = new Client(
    { name: 'deskmcp-browser-tools-test', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } }
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));
    return await operation(client, browser, root);
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
          browser_observation_id: OBSERVATION_ID,
          screenshot: false,
          actions: [{ type: 'wait', duration_ms: 0 }]
        }
      });
      const profiles = await client.callTool({ name: 'desktop_browser_session', arguments: { action: 'list_profiles' } });
      const deleteProfile = await client.callTool({
        name: 'desktop_browser_session',
        arguments: { action: 'delete_profile', profile_id: 'tool-test' }
      });

      for (const result of [session, snapshot, act, profiles, deleteProfile]) {
        assert.equal(result.isError, true);
        assert.match(contentText(result), /Full Control|fully-unlocked/i);
      }
      assert.deepEqual(
        [browser.startCalls, browser.listCalls, browser.closeCalls, browser.newPageCalls, browser.closePageCalls, browser.listProfilesCalls, browser.deleteProfileCalls, browser.snapshotCalls, browser.actCalls],
        [0, 0, 0, 0, 0, 0, 0, 0, 0]
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
          browser_observation_id: OBSERVATION_ID,
          screenshot: false,
          actions: [{ type: 'wait', duration_ms: 0 }]
        }
      });
      assert.equal(act.isError, undefined);

      const newPage = await client.callTool({
        name: 'desktop_browser_session',
        arguments: { action: 'new_page', session_id: SESSION_ID, url: 'https://example.com/new' }
      });
      assert.equal(newPage.isError, undefined);
      assert.match(contentText(newPage), /page-2/);

      const selectPage = await client.callTool({
        name: 'desktop_browser_session',
        arguments: { action: 'select_page', session_id: SESSION_ID, page_id: 'page-2' }
      });
      assert.equal(selectPage.isError, undefined);
      assert.match(contentText(selectPage), /"selected": true/);

      const closePage = await client.callTool({
        name: 'desktop_browser_session',
        arguments: { action: 'close_page', session_id: SESSION_ID, page_id: 'page-2' }
      });
      assert.equal(closePage.isError, undefined);
      assert.match(contentText(closePage), /"closed": true/);

      const close = await client.callTool({
        name: 'desktop_browser_session',
        arguments: { action: 'close', session_id: SESSION_ID }
      });
      assert.equal(close.isError, undefined);
      assert.match(contentText(close), /"closed": true/);

      const profiles = await client.callTool({ name: 'desktop_browser_session', arguments: { action: 'list_profiles' } });
      assert.equal(profiles.isError, undefined);
      assert.match(contentText(profiles), /tool-test/);
      const deleteProfile = await client.callTool({
        name: 'desktop_browser_session',
        arguments: { action: 'delete_profile', profile_id: 'tool-test' }
      });
      assert.equal(deleteProfile.isError, undefined);
      assert.match(contentText(deleteProfile), /"deleted": true/);

      assert.deepEqual(
        [browser.startCalls, browser.closeCalls, browser.newPageCalls, browser.selectPageCalls, browser.closePageCalls, browser.listProfilesCalls, browser.deleteProfileCalls, browser.snapshotCalls, browser.actCalls],
        [1, 1, 1, 1, 1, 1, 1, 2, 1]
      );
    });
  }
});

test('browser MCP act accepts observation refs and rejects ambiguous selector/ref targets', async () => {
  await withBrowserClient('full-control', async (client, browser) => {
    const byRef = await client.callTool({
      name: 'desktop_browser_act',
      arguments: {
        session_id: SESSION_ID,
        browser_observation_id: OBSERVATION_ID,
        screenshot: false,
        actions: [{ type: 'click', ref: 'e1' }]
      }
    });
    assert.equal(byRef.isError, undefined);
    assert.deepEqual(browser.lastActActions, [{ type: 'click', ref: 'e1' }]);

    const callsBeforeInvalid = browser.actCalls;
    let rejected = false;
    try {
      const invalid = await client.callTool({
        name: 'desktop_browser_act',
        arguments: {
          session_id: SESSION_ID,
          browser_observation_id: OBSERVATION_ID,
          screenshot: false,
          actions: [{ type: 'click', selector: '#button', ref: 'e1' }]
        }
      });
      rejected = invalid.isError === true;
      if (invalid.isError) assert.match(contentText(invalid), /selector|ref|invalid/i);
    } catch (error) {
      rejected = true;
      assert.match(String(error), /selector|ref|invalid|argument/i);
    }
    assert.equal(rejected, true);
    assert.equal(browser.actCalls, callsBeforeInvalid);
  });
});

test('browser set_files canonicalizes Workspace files and rejects paths outside policy', async () => {
  await withBrowserClient('full-control', async (client, browser, root) => {
    const allowed = path.join(root, 'upload.txt');
    await writeFile(allowed, 'allowed upload', 'utf8');
    const ok = await client.callTool({
      name: 'desktop_browser_act',
      arguments: {
        session_id: SESSION_ID,
        browser_observation_id: OBSERVATION_ID,
        screenshot: false,
        actions: [{ type: 'set_files', ref: 'e1', files: [allowed] }]
      }
    });
    assert.equal(ok.isError, undefined);
    const canonicalAllowed = await realpath(allowed);
    assert.deepEqual(browser.lastActActions, [{ type: 'set_files', ref: 'e1', files: [canonicalAllowed] }]);

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-browser-outside-'));
    try {
      const outside = path.join(outsideRoot, 'outside.txt');
      await writeFile(outside, 'outside', 'utf8');
      const callsBeforeDenied = browser.actCalls;
      const denied = await client.callTool({
        name: 'desktop_browser_act',
        arguments: {
          session_id: SESSION_ID,
          browser_observation_id: OBSERVATION_ID,
          screenshot: false,
          actions: [{ type: 'set_files', ref: 'e1', files: [outside] }]
        }
      });
      assert.equal(denied.isError, true);
      assert.match(contentText(denied), /outside|allowed root|workspace|policy/i);
      assert.equal(browser.actCalls, callsBeforeDenied);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('browser handle_dialog is an explicit session recovery action that requires re-observation', async () => {
  await withBrowserClient('full-control', async (client, browser) => {
    const result = await client.callTool({
      name: 'desktop_browser_session',
      arguments: {
        action: 'handle_dialog',
        session_id: SESSION_ID,
        page_id: 'page-1',
        accept: true,
        prompt_text: 'approved'
      }
    });
    assert.equal(result.isError, undefined);
    assert.match(contentText(result), /"handled": true/);
    assert.match(contentText(result), /observation_required_before_next_action/);
    assert.equal(browser.handleDialogCalls, 1);
    assert.equal(browser.actCalls, 0);
  });
});


test('browser MCP download accepts cross-frame Playwright refs and returns Artifact result', async () => {
  await withBrowserClient('full-control', async (client, browser) => {
    const result = await client.callTool({
      name: 'desktop_browser_act',
      arguments: {
        session_id: SESSION_ID,
        page_id: 'page-1',
        browser_observation_id: OBSERVATION_ID,
        screenshot: false,
        actions: [{ type: 'download', ref: 'f1e2' }]
      }
    });
    assert.equal(result.isError, undefined);
    assert.equal(browser.downloadCalls, 1);
    assert.equal(browser.actCalls, 0);
    assert.deepEqual(browser.lastActActions, [{ type: 'download', ref: 'f1e2' }]);
    assert.match(contentText(result), /download\.txt/);
  });
});

test('browser MCP download must be the only action under one observation', async () => {
  await withBrowserClient('full-control', async (client, browser) => {
    const result = await client.callTool({
      name: 'desktop_browser_act',
      arguments: {
        session_id: SESSION_ID,
        page_id: 'page-1',
        browser_observation_id: OBSERVATION_ID,
        screenshot: false,
        actions: [
          { type: 'download', ref: 'e2' },
          { type: 'wait', duration_ms: 0 }
        ]
      }
    });
    assert.equal(result.isError, true);
    assert.match(contentText(result), /download must be the only action/i);
    assert.equal(browser.downloadCalls, 0);
    assert.equal(browser.actCalls, 0);
  });
});


test('browser MCP hover and drag accept Playwright refs and reject ambiguous drag endpoints', async () => {
  await withBrowserClient('full-control', async (client, browser) => {
    const hover = await client.callTool({
      name: 'desktop_browser_act',
      arguments: {
        session_id: SESSION_ID,
        browser_observation_id: OBSERVATION_ID,
        screenshot: false,
        actions: [{ type: 'hover', ref: 'f1e2' }]
      }
    });
    assert.equal(hover.isError, undefined);
    assert.deepEqual(browser.lastActActions, [{ type: 'hover', ref: 'f1e2' }]);

    const drag = await client.callTool({
      name: 'desktop_browser_act',
      arguments: {
        session_id: SESSION_ID,
        browser_observation_id: OBSERVATION_ID,
        screenshot: false,
        actions: [{ type: 'drag', source_ref: 'e2', target_ref: 'f1e2' }]
      }
    });
    assert.equal(drag.isError, undefined);
    assert.deepEqual(browser.lastActActions, [{ type: 'drag', source_ref: 'e2', target_ref: 'f1e2' }]);

    const callsBeforeInvalid = browser.actCalls;
    const invalid = await client.callTool({
      name: 'desktop_browser_act',
      arguments: {
        session_id: SESSION_ID,
        browser_observation_id: OBSERVATION_ID,
        screenshot: false,
        actions: [{ type: 'drag', source_selector: '#source', source_ref: 'e2', target_ref: 'f1e2' }]
      }
    }).catch(error => ({ isError: true, content: [{ type: 'text', text: String(error) }] }));
    assert.equal(invalid.isError, true);
    assert.equal(browser.actCalls, callsBeforeInvalid);
  });
});


test('browser MCP snapshot forwards bounded opt-in console/network observability options', async () => {
  await withBrowserClient('full-control', async (client, browser) => {
    const result = await client.callTool({
      name: 'desktop_browser_snapshot',
      arguments: {
        session_id: SESSION_ID,
        page_id: 'page-1',
        screenshot: false,
        include_console: true,
        max_console_messages: 17,
        include_network: true,
        max_network_events: 23
      }
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(browser.lastSnapshotOptions, {
      full_page: false,
      screenshot: false,
      max_text_chars: 8000,
      max_interactive_elements: 100,
      include_console: true,
      max_console_messages: 17,
      include_network: true,
      max_network_events: 23
    });

    let rejected = false;
    try {
      const invalid = await client.callTool({
        name: 'desktop_browser_snapshot',
        arguments: {
          session_id: SESSION_ID,
          screenshot: false,
          include_console: true,
          max_console_messages: 201
        }
      });
      rejected = invalid.isError === true;
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true);
  });
});


test('browser MCP snapshot mode=find returns compact refs and rejects ambiguous full/find requests', async () => {
  await withBrowserClient('full-control', async (client, browser) => {
    const found = await client.callTool({
      name: 'desktop_browser_snapshot',
      arguments: {
        session_id: SESSION_ID,
        page_id: 'page-1',
        mode: 'find',
        find_query: 'Submit',
        find_case_sensitive: false,
        max_find_results: 5,
        screenshot: false
      }
    });
    assert.equal(found.isError, undefined);
    assert.match(contentText(found), /f1e2/);
    assert.match(contentText(found), new RegExp(OBSERVATION_ID));
    assert.equal(browser.findCalls, 1);
    assert.equal(browser.snapshotCalls, 0);
    assert.deepEqual(browser.lastSnapshotOptions, {
      query: 'Submit',
      case_sensitive: false,
      max_results: 5
    });

    let rejectedMissingQuery = false;
    try {
      const invalid = await client.callTool({
        name: 'desktop_browser_snapshot',
        arguments: { session_id: SESSION_ID, mode: 'find', screenshot: false }
      });
      rejectedMissingQuery = invalid.isError === true;
    } catch (error) {
      rejectedMissingQuery = true;
      assert.match(String(error), /find_query|argument|invalid/i);
    }
    assert.equal(rejectedMissingQuery, true);

    let rejectedFullQuery = false;
    try {
      const invalid = await client.callTool({
        name: 'desktop_browser_snapshot',
        arguments: { session_id: SESSION_ID, mode: 'full', find_query: 'Submit', screenshot: false }
      });
      rejectedFullQuery = invalid.isError === true;
    } catch (error) {
      rejectedFullQuery = true;
      assert.match(String(error), /find_query|argument|invalid/i);
    }
    assert.equal(rejectedFullQuery, true);
  });
});


test('browser MCP type_text and set_checked support Playwright refs and reject invalid targets', async () => {
  await withBrowserClient('full-control', async (client, browser) => {
    const typed = await client.callTool({
      name: 'desktop_browser_act',
      arguments: {
        session_id: SESSION_ID,
        browser_observation_id: OBSERVATION_ID,
        screenshot: false,
        actions: [{ type: 'type_text', ref: 'e2', text: 'hello', delay_ms: 15 }]
      }
    });
    assert.equal(typed.isError, undefined);
    assert.deepEqual(browser.lastActActions, [{ type: 'type_text', ref: 'e2', text: 'hello', delay_ms: 15 }]);

    const checked = await client.callTool({
      name: 'desktop_browser_act',
      arguments: {
        session_id: SESSION_ID,
        browser_observation_id: OBSERVATION_ID,
        screenshot: false,
        actions: [{ type: 'set_checked', ref: 'f1e2', checked: true }]
      }
    });
    assert.equal(checked.isError, undefined);
    assert.deepEqual(browser.lastActActions, [{ type: 'set_checked', ref: 'f1e2', checked: true }]);

    let rejected = false;
    try {
      const invalid = await client.callTool({
        name: 'desktop_browser_act',
        arguments: {
          session_id: SESSION_ID,
          browser_observation_id: OBSERVATION_ID,
          screenshot: false,
          actions: [{ type: 'type_text', selector: '#input', ref: 'e2', text: 'x', delay_ms: 300 }]
        }
      });
      rejected = invalid.isError === true;
    } catch (error) {
      rejected = true;
      assert.match(String(error), /selector|ref|delay|invalid|argument/i);
    }
    assert.equal(rejected, true);
  });
});

test('candidate human takeover cross-tool quarantine denies filesystem, processes and computer UI before backend calls', async () => {
  const boundary = createBrowserHandoffBoundary(() => undefined);
  const guard = createBrowserCrossToolGuard(boundary.agent);
  boundary.agent.request(SESSION_ID);
  assert.equal(boundary.agent.anySessionReserved(), true);
  await withBrowserClient('full-control', async (client, _browser, root) => {
    for (const [name, args] of [
      ['desktop_read_file', {path: path.join(root, 'fixture.txt'), length: 100}],
      ['desktop_list_directory', {path: root, depth: 1}],
      ['desktop_search', {path: root, pattern: 'secret'}],
      ['desktop_get_file_info', {path: root}],
      ['desktop_create_directory', {path: path.join(root,'should-not-create')}],
      ['desktop_move_file', {source:path.join(root,'a'),destination:path.join(root,'b')}],
      ['desktop_edit_file', {path:path.join(root,'file'),old_string:'a',new_string:'b'}],
      ['desktop_write_file', {path:path.join(root,'file'),content:'bad',mode:'rewrite'}],
      ['desktop_start_process', {command: 'Write-Output SHOULD_NOT_RUN'}],
      ['desktop_read_process', {session_id: SESSION_ID}],
      ['desktop_interact_process', {session_id:SESSION_ID,input:'bad'}],
      ['desktop_terminate_process', {session_id: SESSION_ID}],
      ['desktop_ui_windows', {}],
      ['desktop_ui_snapshot', {window_id: SESSION_ID}],
      ['desktop_ui_action', {window_id: SESSION_ID, computer_observation_id: OBSERVATION_ID, action: 'wait'}]
    ] as const) {
      const denied = await client.callTool({name, arguments: args});
      assert.equal(denied.isError, true, name + ' must fail during handoff');
      assert.match(contentText(denied), /human takeover quarantine/i, name);
    }
    for (const [name, args] of [
      ['desktop_agent_desktop', {action:'status'}],
      ['desktop_task_manage', {action:'list'}],
      ['desktop_skill_manage', {action:'list'}],
      ['desktop_artifact_manage', {action:'list'}],
      ['desktop_mcp_manage', {action:'list'}],
      ['desktop_mcp_tool_search', {query:'browser'}],
      ['desktop_mcp_tool_inspect', {name:'test:tool'}],
      ['desktop_mcp_tool_call', {name:'test:tool', arguments:{}}]
    ] as const) {
      const denied = await client.callTool({name, arguments:args});
      assert.equal(denied.isError, true, name + ' must fail during handoff');
      assert.match(contentText(denied), /human takeover quarantine/i, name);
    }
    const registered = (await client.listTools()).tools.map(tool=>tool.name);
    assert.equal(registered.length,27,'all current DeskMCP tool registrations are covered');

    const deniedPolicy = await client.callTool({name:'desktop_policy_status', arguments:{}});
    assert.equal(deniedPolicy.isError, true);
    assert.match(contentText(deniedPolicy), /human takeover quarantine/i);

    boundary.local.reject(SESSION_ID);
    assert.equal(boundary.agent.anySessionReserved(), false);
    const normal = await client.callTool({name:'desktop_policy_status', arguments:{}});
    assert.equal(normal.isError, undefined);
    assert.match(contentText(normal), /full-control/);
  }, guard);
});

test('handoff beginning during in-flight MCP read suppresses late response and audits denial', async () => {
  const boundary = createBrowserHandoffBoundary(() => undefined);
  const guard = createBrowserCrossToolGuard(boundary.agent);
  let signal!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve=>{signal=resolve;});
  const blocked = new Promise<void>(resolve=>{release=resolve;});
  await withBrowserClient('full-control', async client => {
    const pending = client.callTool({
      name:'desktop_mcp_tool_search',
      arguments:{query:'a'}
    });
    await entered;
    boundary.agent.request(SESSION_ID);
    release();
    const denied = await pending;
    assert.equal(denied.isError, true);
    assert.match(contentText(denied), /human takeover quarantine/);
    assert.doesNotMatch(contentText(denied), /SHOULD_STAY_PRIVATE/);
  }, guard, hub => {
    Object.assign(hub, { searchTools: async () => {
      signal();
      await blocked;
      return [{ qualified_name:'SHOULD_STAY_PRIVATE', server:'test',tool_name:'private'}];
    }});
  });
});

test('real MCP in-flight dynamic tool call must drain before browser handoff can transfer', async () => {
  const boundary=createBrowserHandoffBoundary(()=>undefined);
  const guard=createBrowserCrossToolGuard(boundary.agent);
  let signal!:()=>void;
  let release!:()=>void;
  const entered=new Promise<void>(resolve=>{signal=resolve;});
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  let callbackStarted=false;
  await withBrowserClient('full-control',async(client)=>{
    const activeRead=client.callTool({name:'desktop_mcp_tool_search',arguments:{query:'blocking'}});
    await entered;
    const transfer=guard.withHandoffBarrier(async()=>{
      callbackStarted=true;
      return boundary.agent.request(SESSION_ID);
    },1500);
    assert.equal(callbackStarted,false);
    const denied=await client.callTool({name:'desktop_policy_status',arguments:{}});
    assert.equal(denied.isError,true);
    assert.match(contentText(denied),/quarantine/i);
    assert.equal(callbackStarted,false);
    release();
    const old=await activeRead;
    assert.equal(old.isError,true,'in-flight result must be withheld during handoff');
    assert.match(contentText(old),/quarantine/i);
    const transferResult=await transfer;
    assert.equal(transferResult.state,'handoff-requested');
    assert.equal(callbackStarted,true);
    boundary.local.reject(SESSION_ID);
  },guard,hub=>{
    Object.assign(hub,{searchTools:async()=>{signal();await waiting;return [{qualified_name:'SHOULD_NOT_RETURN',server:'test',tool_name:'secret'}];}});
  });
});
