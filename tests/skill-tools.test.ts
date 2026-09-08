import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AuditLogger } from '../src/audit.js';
import { DesktopBackendBridge } from '../src/desktop-backend-bridge.js';
import { DesktopPolicy, type PermissionProfile } from '../src/desktop-policy.js';
import { startHttpServer } from '../src/http-server.js';
import { ObservationStore } from '../src/observation-store.js';
import { ProcessSessionRegistry } from '../src/process-session-registry.js';
import { SkillStore } from '../src/skill-store.js';

async function createSkill(
  workspace: string,
  name: string,
  version = '1.0.0',
  markerPath?: string
): Promise<string> {
  const root = path.join(workspace, name);
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(
    path.join(root, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Safe test skill ${name}.`,
      'metadata:',
      `  version: "${version}"`,
      '---',
      '',
      `# ${name}`,
      '',
      'Follow the documented workflow. Scripts are resources only.',
      ''
    ].join('\n'),
    'utf8'
  );
  const markerLiteral = JSON.stringify(markerPath ?? path.join(workspace, 'should-never-exist.txt'));
  await writeFile(
    path.join(root, 'scripts', 'danger.cjs'),
    `require('node:fs').writeFileSync(${markerLiteral}, 'executed');\n`,
    'utf8'
  );
  return root;
}

async function pathExists(value: string): Promise<boolean> {
  return stat(value).then(() => true, () => false);
}

function contentText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n');
}

async function withSkillClient<T>(
  profile: PermissionProfile,
  prepare: (store: SkillStore, workspace: string) => Promise<void>,
  operation: (client: Client, store: SkillStore, workspace: string) => Promise<T>
): Promise<T> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-skill-tools-'));
  const stateRoot = path.join(workspace, '.state', 'skills');
  const store = new SkillStore(stateRoot);
  await store.init();
  await prepare(store, workspace);

  const policy = await DesktopPolicy.create({ profile, allowedRoots: [workspace] });
  const audit = new AuditLogger(path.join(workspace, 'audit.jsonl'));
  await audit.init();
  const bridge = new DesktopBackendBridge();
  const observations = new ObservationStore();
  const sessions = new ProcessSessionRegistry();
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
    undefined,
    store
  );
  const client = new Client(
    { name: 'deskmcp-skill-tools-test', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } }
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));
    return await operation(client, store, workspace);
  } finally {
    await client.close().catch(() => undefined);
    await running.close();
    await bridge.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

test('Read profile can discover, inspect, validate, and read Skills but cannot mutate Skill state', async () => {
  let source = '';
  let marker = '';
  await withSkillClient(
    'read-only',
    async (store, workspace) => {
      marker = path.join(workspace, 'SCRIPT_EXECUTED.txt');
      source = await createSkill(workspace, 'read-skill', '1.0.0', marker);
      await store.install({ kind: 'local', path: source }, true);
    },
    async client => {
      const listedTools = await client.listTools();
      assert.equal(listedTools.tools.filter(tool => tool.name === 'desktop_skill_manage').length, 1);

      const listed = await client.callTool({ name: 'desktop_skill_manage', arguments: { action: 'list' } });
      assert.equal(listed.isError, undefined);
      assert.match(contentText(listed), /read-skill/);

      const read = await client.callTool({
        name: 'desktop_skill_manage',
        arguments: { action: 'read', name: 'read-skill', resource_path: 'SKILL.md' }
      });
      assert.equal(read.isError, undefined);
      assert.match(contentText(read), /Follow the documented workflow/);

      const validated = await client.callTool({
        name: 'desktop_skill_manage',
        arguments: { action: 'validate', source_path: source }
      });
      assert.equal(validated.isError, undefined);
      assert.match(contentText(validated), /"name": "read-skill"/);

      for (const request of [
        { action: 'install', source_path: source },
        { action: 'activate', name: 'read-skill', version: '1.0.0' },
        { action: 'rollback', name: 'read-skill' }
      ]) {
        const denied = await client.callTool({ name: 'desktop_skill_manage', arguments: request });
        assert.equal(denied.isError, true);
        assert.match(contentText(denied), /write|permission|profile/i);
      }
      assert.equal(await pathExists(marker), false, 'Skill scripts must never auto-execute');
    }
  );
});

test('Write profile can install local Workspace Skills but remote Skill downloads still require Full or Unlock', async () => {
  let source = '';
  await withSkillClient(
    'workspace-write',
    async (_store, workspace) => {
      source = await createSkill(workspace, 'write-skill');
    },
    async client => {
      const installed = await client.callTool({
        name: 'desktop_skill_manage',
        arguments: { action: 'install', source_path: source, activate: true }
      });
      assert.equal(installed.isError, undefined);
      assert.match(contentText(installed), /write-skill/);

      const remoteDenied = await client.callTool({
        name: 'desktop_skill_manage',
        arguments: {
          action: 'validate',
          source_url: 'https://example.invalid/skill.zip',
          expected_sha256: '0'.repeat(64)
        }
      });
      assert.equal(remoteDenied.isError, true);
      assert.match(contentText(remoteDenied), /Full Control|Fully Unlocked/i);
    }
  );
});

test('Full profile still enforces HTTPS and rejects credential-bearing remote Skill URLs before download', async () => {
  await withSkillClient(
    'full-control',
    async () => undefined,
    async client => {
      const plainHttp = await client.callTool({
        name: 'desktop_skill_manage',
        arguments: {
          action: 'validate',
          source_url: 'http://example.invalid/skill.zip',
          expected_sha256: '1'.repeat(64)
        }
      });
      assert.equal(plainHttp.isError, true);
      assert.match(contentText(plainHttp), /HTTPS/i);

      const credentials = await client.callTool({
        name: 'desktop_skill_manage',
        arguments: {
          action: 'validate',
          source_url: 'https://user:secret@example.invalid/skill.zip',
          expected_sha256: '2'.repeat(64)
        }
      });
      assert.equal(credentials.isError, true);
      assert.match(contentText(credentials), /embedded credentials/i);
    }
  );
});
