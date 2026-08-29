import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AuditLogger, type AuditRecord } from '../src/audit.js';
import { DesktopCommanderBridge } from '../src/desktop-commander-bridge.js';
import { DesktopPolicy } from '../src/desktop-policy.js';
import { startHttpServer } from '../src/http-server.js';
import { ObservationStore } from '../src/observation-store.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';
import {
  PROJECT_ROOT,
  READ_TEST_FILE,
  TEST_AREA
} from '../src/paths.js';

const auditPath = path.join(TEST_AREA, 'audit-e2e.jsonl');
const editPath = path.join(TEST_AREA, 'edit-e2e.txt');
const existingWritePath = path.join(TEST_AREA, 'existing-write-e2e.txt');
const bridgeWritePath = path.join(TEST_AREA, 'bridge-write-e2e.txt');
const createdDirPath = path.join(TEST_AREA, 'created-dir-e2e');
const moveSourcePath = path.join(TEST_AREA, 'move-source-e2e.txt');
const moveDestPath = path.join(createdDirPath, 'moved.txt');
const searchPublicPath = path.join(TEST_AREA, 'search-public-visible.txt');
const searchSensitivePath = path.join(TEST_AREA, '.env.search-e2e');

function makeClient(version: string): Client {
  return new Client(
    { name: 'deskmcp-bridge-test', version },
    { versionNegotiation: { mode: 'auto' } }
  );
}

function parseAudit(text: string): AuditRecord[] {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditRecord);
}

test('workspace-write policy exposes guarded Desktop Commander filesystem tools', async () => {
  await rm(bridgeWritePath, { force: true });
  await rm(auditPath, { force: true });
  await rm(bridgeWritePath, { force: true });
  await rm(createdDirPath, { recursive: true, force: true });
  await writeFile(moveSourcePath, 'MOVE_ME', 'utf8');
  await writeFile(editPath, 'alpha beta alpha', 'utf8');
  await writeFile(existingWritePath, 'ORIGINAL', 'utf8');
  await writeFile(searchPublicPath, 'SEARCH_E2E_COMMON public', 'utf8');
  await writeFile(searchSensitivePath, 'SEARCH_E2E_COMMON secret', 'utf8');

  const policy = await DesktopPolicy.create({
    profile: 'workspace-write',
    allowedRoots: [TEST_AREA]
  });
  const audit = new AuditLogger(auditPath);
  await audit.init();
  const observations = new ObservationStore();
  const processSessions = new ProcessSessionRegistry();
  const bridge = new DesktopCommanderBridge();
  await bridge.start();
  const running = await startHttpServer('127.0.0.1', 0, bridge, policy, audit, observations, processSessions);
  const client = makeClient('0.9.0');

  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`${running.url}/mcp`)
    ));

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(tool => tool.name).sort(),
      [
        'desktop_create_directory',
        'desktop_edit_file',
        'desktop_get_file_info',
        'desktop_interact_process',
        'desktop_list_directory',
        'desktop_move_file',
        'desktop_policy_status',
        'desktop_read_file',
        'desktop_read_process',
        'desktop_search',
        'desktop_start_process',
        'desktop_terminate_process',
        'desktop_write_file'
      ]
    );

    const status = await client.callTool({
      name: 'desktop_policy_status',
      arguments: {}
    });
    assert.match(JSON.stringify(status.content), /workspace-write/);

    const workspaceProcessDenied = await client.callTool({
      name: 'desktop_start_process',
      arguments: { command: 'node -i', timeout_ms: 500, shell: 'cmd.exe' }
    });
    assert.equal(workspaceProcessDenied.isError, true);
    assert.match(JSON.stringify(workspaceProcessDenied.content), /full-control/);

    const read = await client.callTool({
      name: 'desktop_read_file',
      arguments: { path: READ_TEST_FILE, offset: 0, length: 20 }
    });
    assert.equal(read.isError, undefined);
    assert.match(JSON.stringify(read.content), /DESKTOP_MCP_READ_TEST_OK/);

    const listing = await client.callTool({
      name: 'desktop_list_directory',
      arguments: { path: TEST_AREA, depth: 1 }
    });
    assert.equal(listing.isError, undefined);
    assert.match(JSON.stringify(listing.content), /test\.txt/);

    const info = await client.callTool({
      name: 'desktop_get_file_info',
      arguments: { path: READ_TEST_FILE }
    });
    assert.equal(info.isError, undefined);
    assert.match(JSON.stringify(info.content), /isFile|fileType|size/i);

    const search = await client.callTool({
      name: 'desktop_search',
      arguments: {
        path: TEST_AREA,
        pattern: 'SEARCH_E2E_COMMON',
        search_type: 'content',
        ignore_case: false,
        max_results: 20,
        include_hidden: true,
        literal_search: true,
        timeout_ms: 5000
      }
    });
    assert.equal(search.isError, undefined);
    const searchText = JSON.stringify(search.content);
    assert.match(searchText, /search-public-visible\.txt/);
    assert.doesNotMatch(searchText, /\.env\.search-e2e/);
    assert.doesNotMatch(searchText, /search_\d+/);
    assert.doesNotMatch(searchText, /sessionId/i);



    const marker = `DC_POLICY_WRITE_${Date.now()}`;
    const write = await client.callTool({
      name: 'desktop_write_file',
      arguments: {
        path: bridgeWritePath,
        content: marker,
        mode: 'rewrite'
      }
    });
    assert.equal(write.isError, undefined);
    assert.equal(await readFile(bridgeWritePath, 'utf8'), marker);

    const deniedTarget = path.join(PROJECT_ROOT, 'src', 'index.ts');
    const denied = await client.callTool({
      name: 'desktop_read_file',
      arguments: { path: deniedTarget }
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /outside DESKTOP_MCP_ALLOWED_ROOTS/);

    const writeTool = listed.tools.find(tool => tool.name === 'desktop_write_file');
    assert.ok(writeTool);
    const required = (writeTool.inputSchema as { required?: unknown }).required;
    assert.ok(Array.isArray(required) && required.includes('mode'));

    const health = await fetch(`${running.url}/health`);
    const healthBody = await health.json() as {
      desktopCommander?: Record<string, unknown>;
      policy?: Record<string, unknown> & { profile?: string; writeEnabled?: boolean };
      auditEnabled?: boolean;
      observationStoreEnabled?: boolean;
    };
    assert.equal(healthBody.policy?.profile, 'workspace-write');
    assert.equal(healthBody.policy?.writeEnabled, true);
    assert.equal(healthBody.auditEnabled, true);
    assert.equal(healthBody.observationStoreEnabled, true);
    assert.equal('entry' in (healthBody.desktopCommander ?? {}), false);
    const startupTiming = healthBody.desktopCommander?.startupTiming as
      | Record<string, unknown>
      | undefined;
    assert.ok(startupTiming);
    for (const key of ['accessMs', 'connectMs', 'listToolsMs', 'validationMs', 'totalMs']) {
      assert.equal(typeof startupTiming[key], 'number');
      assert.ok((startupTiming[key] as number) >= 0);
    }
    assert.equal('allowedRoots' in (healthBody.policy ?? {}), false);

    const existingWriteDenied = await client.callTool({
      name: 'desktop_write_file',
      arguments: {
        path: existingWritePath,
        content: 'SHOULD_NOT_WRITE',
        mode: 'rewrite'
      }
    });
    assert.equal(existingWriteDenied.isError, true);
    assert.match(JSON.stringify(existingWriteDenied.content), /Read-before-write required/);
    assert.equal(await readFile(existingWritePath, 'utf8'), 'ORIGINAL');

    const existingRead = await client.callTool({
      name: 'desktop_read_file',
      arguments: { path: existingWritePath }
    });
    assert.equal(existingRead.isError, undefined);

    await writeFile(existingWritePath, 'EXTERNAL', 'utf8');
    const staleWrite = await client.callTool({
      name: 'desktop_write_file',
      arguments: {
        path: existingWritePath,
        content: 'SHOULD_STILL_NOT_WRITE',
        mode: 'rewrite'
      }
    });
    assert.equal(staleWrite.isError, true);
    assert.match(JSON.stringify(staleWrite.content), /STALE observation/);
    assert.equal(await readFile(existingWritePath, 'utf8'), 'EXTERNAL');

    const existingReread = await client.callTool({
      name: 'desktop_read_file',
      arguments: { path: existingWritePath }
    });
    assert.equal(existingReread.isError, undefined);
    const existingWriteAllowed = await client.callTool({
      name: 'desktop_write_file',
      arguments: { path: existingWritePath, content: 'AFTER', mode: 'rewrite' }
    });
    assert.equal(existingWriteAllowed.isError, undefined);
    assert.equal(await readFile(existingWritePath, 'utf8'), 'AFTER');

    const editWithoutRead = await client.callTool({
      name: 'desktop_edit_file',
      arguments: {
        path: editPath,
        old_string: 'alpha',
        new_string: 'gamma',
        expected_replacements: 1
      }
    });
    assert.equal(editWithoutRead.isError, true);
    assert.match(JSON.stringify(editWithoutRead.content), /Read-before-write required/);

    const editRead = await client.callTool({
      name: 'desktop_read_file',
      arguments: { path: editPath }
    });
    assert.equal(editRead.isError, undefined);
    await writeFile(editPath, 'external beta alpha', 'utf8');

    const staleEdit = await client.callTool({
      name: 'desktop_edit_file',
      arguments: {
        path: editPath,
        old_string: 'external',
        new_string: 'gamma',
        expected_replacements: 1
      }
    });
    assert.equal(staleEdit.isError, true);
    assert.match(JSON.stringify(staleEdit.content), /STALE observation/);
    assert.equal(await readFile(editPath, 'utf8'), 'external beta alpha');

    const editReread = await client.callTool({
      name: 'desktop_read_file',
      arguments: { path: editPath }
    });
    assert.equal(editReread.isError, undefined);
    const editAllowed = await client.callTool({
      name: 'desktop_edit_file',
      arguments: {
        path: editPath,
        old_string: 'external',
        new_string: 'gamma',
        expected_replacements: 1
      }
    });
    assert.equal(editAllowed.isError, undefined);
    assert.equal(await readFile(editPath, 'utf8'), 'gamma beta alpha');
    const createDir = await client.callTool({
      name: 'desktop_create_directory',
      arguments: { path: createdDirPath }
    });
    assert.equal(createDir.isError, undefined);

    const moveWithoutRead = await client.callTool({
      name: 'desktop_move_file',
      arguments: { source: moveSourcePath, destination: moveDestPath }
    });
    assert.equal(moveWithoutRead.isError, true);
    assert.match(JSON.stringify(moveWithoutRead.content), /Read-before-write required/);

    const moveRead = await client.callTool({
      name: 'desktop_read_file',
      arguments: { path: moveSourcePath }
    });
    assert.equal(moveRead.isError, undefined);

    const moveAllowed = await client.callTool({
      name: 'desktop_move_file',
      arguments: { source: moveSourcePath, destination: moveDestPath }
    });
    assert.equal(moveAllowed.isError, undefined);
    await assert.rejects(readFile(moveSourcePath, 'utf8'), /ENOENT/);
    assert.equal(await readFile(moveDestPath, 'utf8'), 'MOVE_ME');

    const auditText = await readFile(auditPath, 'utf8');
    const records = parseAudit(auditText);
    const writeFinish = records.find(record =>
      record.phase === 'finish' && record.tool === 'desktop_write_file'
    );
    assert.ok(writeFinish?.phase === 'finish');
    assert.equal(writeFinish.outcome, 'allow');

    const deniedFinish = records.find(record =>
      record.phase === 'finish' &&
      record.tool === 'desktop_read_file' &&
      record.target === deniedTarget
    );
    assert.ok(deniedFinish?.phase === 'finish');
    assert.equal(deniedFinish.outcome, 'deny');
    assert.equal(deniedFinish.errorType, 'PolicyDeniedError');
    assert.equal(auditText.includes(marker), false);
    assert.equal(auditText.includes('SEARCH_E2E_COMMON'), false);
    const searchAllowedAudit = records.find(record =>
      record.phase === 'finish' &&
      record.tool === 'desktop_search' &&
      record.outcome === 'allow'
    );
    assert.ok(searchAllowedAudit?.phase === 'finish');
    const observationRequired = records.find(record =>
      record.phase === 'finish' && record.errorType === 'ObservationRequiredError'
    );
    assert.ok(observationRequired?.phase === 'finish');
    assert.equal(observationRequired.outcome, 'deny');

    const staleDenied = records.find(record =>
      record.phase === 'finish' && record.errorType === 'StaleObservationError'
    );
    assert.ok(staleDenied?.phase === 'finish');
    assert.equal(staleDenied.outcome, 'deny');

    const editAllowedAudit = records.find(record =>
      record.phase === 'finish' &&
      record.tool === 'desktop_edit_file' &&
      record.outcome === 'allow'
    );
    assert.ok(editAllowedAudit?.phase === 'finish');

    const createAllowedAudit = records.find(record =>
      record.phase === 'finish' &&
      record.tool === 'desktop_create_directory' &&
      record.outcome === 'allow'
    );
    assert.ok(createAllowedAudit?.phase === 'finish');

    const moveDeniedAudit = records.find(record =>
      record.phase === 'finish' &&
      record.tool === 'desktop_move_file' &&
      record.outcome === 'deny'
    );
    assert.ok(moveDeniedAudit?.phase === 'finish');
    assert.equal(moveDeniedAudit.errorType, 'ObservationRequiredError');

    const moveAllowedAudit = records.find(record =>
      record.phase === 'finish' &&
      record.tool === 'desktop_move_file' &&
      record.outcome === 'allow'
    );
    assert.ok(moveAllowedAudit?.phase === 'finish');


    const readOnlyPolicy = await DesktopPolicy.create({
      profile: 'read-only',
      allowedRoots: [TEST_AREA]
    });
    const readOnlyServer = await startHttpServer(
      '127.0.0.1', 0, bridge, readOnlyPolicy, audit, observations, processSessions
    );
    const readOnlyClient = makeClient('0.9.0-read-only');
    try {
      await readOnlyClient.connect(new StreamableHTTPClientTransport(
        new URL(`${readOnlyServer.url}/mcp`)
      ));
      const readOnlyTools = await readOnlyClient.listTools();
      assert.deepEqual(
        readOnlyTools.tools.map(tool => tool.name).sort(),
          [
          'desktop_create_directory',
          'desktop_edit_file',
          'desktop_get_file_info',
          'desktop_interact_process',
          'desktop_list_directory',
          'desktop_move_file',
          'desktop_policy_status',
          'desktop_read_file',
          'desktop_read_process',
          'desktop_search',
          'desktop_start_process',
          'desktop_terminate_process',
          'desktop_write_file'
        ]
      );

      const readOnlyWriteDenied = await readOnlyClient.callTool({
        name: 'desktop_write_file',
        arguments: { path: path.join(TEST_AREA, 'read-only-denied.txt'), content: 'DENIED', mode: 'rewrite' }
      });
      assert.equal(readOnlyWriteDenied.isError, true);
      assert.match(JSON.stringify(readOnlyWriteDenied.content), /Write denied/);

      const readOnlyProcessDenied = await readOnlyClient.callTool({
        name: 'desktop_start_process',
        arguments: { command: 'node -i', timeout_ms: 500, shell: 'cmd.exe' }
      });
      assert.equal(readOnlyProcessDenied.isError, true);
      assert.match(JSON.stringify(readOnlyProcessDenied.content), /full-control/);
    } finally {
      await readOnlyClient.close();
      await readOnlyServer.close();
    }

    const fullControlPolicy = await DesktopPolicy.create({
      profile: 'full-control',
      allowedRoots: [TEST_AREA]
    });
    const fullControlServer = await startHttpServer(
      '127.0.0.1', 0, bridge, fullControlPolicy, audit, observations, processSessions
    );
    const fullControlClient = makeClient('0.9.0-full-control');
    try {
      await fullControlClient.connect(new StreamableHTTPClientTransport(
        new URL(`${fullControlServer.url}/mcp`)
      ));
      const fullControlTools = await fullControlClient.listTools();
      for (const name of [
        'desktop_start_process',
        'desktop_read_process',
        'desktop_interact_process',
        'desktop_terminate_process'
      ]) {
        assert.ok(fullControlTools.tools.some(tool => tool.name === name));
      }

      const processCommand = 'node -i';
      const started = await fullControlClient.callTool({
        name: 'desktop_start_process',
        arguments: {
          command: processCommand, timeout_ms: 1000,
          ...(process.platform === 'win32' ? { shell: 'cmd.exe' } : {})
        }
      });
      assert.equal(started.isError, undefined);
      const startedText = JSON.stringify(started.content);
      assert.doesNotMatch(startedText, /PID\s+\d+/i);
      const sessionMatch = startedText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
      assert.ok(sessionMatch);
      const sessionId = sessionMatch[0];

      const readProcess = await fullControlClient.callTool({
        name: 'desktop_read_process',
        arguments: { session_id: sessionId, timeout_ms: 500, offset: 0, length: 100 }
      });
      assert.equal(readProcess.isError, undefined);

      const interacted = await fullControlClient.callTool({
        name: 'desktop_interact_process',
        arguments: {
          session_id: sessionId,
          input: 'console.log("ECHO:HELLO_PROCESS")',
          timeout_ms: 3000,
          wait_for_prompt: true
        }
      });
      assert.equal(interacted.isError, undefined);
      assert.match(JSON.stringify(interacted.content), /ECHO:HELLO_PROCESS/);

      const fakeSession = await fullControlClient.callTool({
        name: 'desktop_read_process',
        arguments: {
          session_id: '00000000-0000-4000-8000-000000000000',
          timeout_ms: 0
        }
      });
      assert.equal(fakeSession.isError, true);
      assert.match(JSON.stringify(fakeSession.content), /Unknown or unowned process session/);

      const terminated = await fullControlClient.callTool({
        name: 'desktop_terminate_process',
        arguments: { session_id: sessionId }
      });
      assert.equal(terminated.isError, undefined);
      assert.equal(processSessions.size(), 0);

      const afterTerminate = await fullControlClient.callTool({
        name: 'desktop_read_process',
        arguments: { session_id: sessionId, timeout_ms: 0 }
      });
      assert.equal(afterTerminate.isError, true);
      assert.match(JSON.stringify(afterTerminate.content), /Unknown or unowned process session/);

      const processAuditText = await readFile(auditPath, 'utf8');
      assert.equal(processAuditText.includes(processCommand), false);
      assert.equal(processAuditText.includes('HELLO_PROCESS'), false);
    } finally {
      for (const session of processSessions.ownedSessions()) {
        const cleanup = await bridge.forceTerminateProcess(session.pid);
        processSessions.forget(session.id);
        if (cleanup.isError) throw new Error(`Process E2E cleanup failed for ${session.id}`);
      }
      await fullControlClient.close();
      await fullControlServer.close();
    }
  } finally {
    await client.close();
    await running.close();
    await bridge.close();
    await rm(auditPath, { force: true });
    await rm(bridgeWritePath, { force: true });
    await rm(createdDirPath, { recursive: true, force: true });
    await rm(moveSourcePath, { force: true });
    await rm(editPath, { force: true });
    await rm(existingWritePath, { force: true });
    await rm(searchPublicPath, { force: true });
    await rm(searchSensitivePath, { force: true });
  }
});
