import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger, AuditRisk } from './audit.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import { SkillStore, type SkillPackageSource } from './skill-store.js';

const ACTIONS = ['list', 'get', 'read', 'validate', 'install', 'activate', 'rollback'] as const;
type SkillAction = typeof ACTIONS[number];

function failure(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
    isError: true as const
  };
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
  };
}

function riskForAction(action: SkillAction): AuditRisk {
  return action === 'install' || action === 'activate' || action === 'rollback' ? 'write' : 'read';
}

function requireRemoteSkillPermission(policy: DesktopPolicy): void {
  if (policy.profile !== 'full-control' && policy.profile !== 'fully-unlocked') {
    throw new PolicyDeniedError('Remote Skill download requires session-only Full Control or Fully Unlocked.');
  }
}

function compactSkill(skill: Awaited<ReturnType<SkillStore['get']>>) {
  const active = skill.active_version_id
    ? skill.versions.find(version => version.version_id === skill.active_version_id)
    : undefined;
  return {
    name: skill.name,
    ...(active ? {
      active: {
        version_id: active.version_id,
        ...(active.declared_version ? { declared_version: active.declared_version } : {}),
        digest_sha256: active.digest_sha256,
        description: active.description,
        installed_at: active.installed_at
      }
    } : {}),
    version_count: skill.versions.length,
    rollback_available: Boolean(skill.previous_active_version_id)
  };
}

async function resolveSource(
  policy: DesktopPolicy,
  sourcePath: string | undefined,
  sourceUrl: string | undefined,
  expectedSha256: string | undefined
): Promise<SkillPackageSource> {
  if (Boolean(sourcePath) === Boolean(sourceUrl)) {
    throw new Error('Exactly one of source_path or source_url is required.');
  }
  if (sourceUrl) {
    requireRemoteSkillPermission(policy);
    if (!expectedSha256) throw new Error('Remote Skill source_url requires expected_sha256.');
    return { kind: 'remote', url: sourceUrl, expected_sha256: expectedSha256 };
  }
  const canonical = await policy.resolveReadPath(sourcePath!);
  return {
    kind: 'local',
    path: canonical,
    ...(expectedSha256 ? { expected_sha256: expectedSha256 } : {})
  };
}

export function registerSkillTools(
  server: McpServer,
  policy: DesktopPolicy,
  audit: AuditLogger,
  store: SkillStore
): void {
  server.registerTool(
    'desktop_skill_manage',
    {
      title: 'Manage Versioned DeskMCP Skills',
      description: 'Discover, validate, install, read, activate, and roll back versioned Agent Skills packages. Skills are model-readable instructions/resources, not hidden executors: bundled scripts are never auto-run by this subsystem. Local sources stay under DeskMCP path policy; remote ZIPs require Full/Unlock, HTTPS, and an expected SHA-256 digest.',
      inputSchema: z.object({
        action: z.enum(ACTIONS),
        name: z.string().min(1).max(64).optional(),
        source_path: z.string().min(1).max(4096).optional(),
        source_url: z.string().url().max(8192).optional(),
        expected_sha256: z.string().length(64).optional(),
        activate: z.boolean().optional().default(true),
        version: z.string().min(1).max(256).optional(),
        resource_path: z.string().min(1).max(512).optional(),
        max_chars: z.number().int().min(1).max(200000).optional().default(100000)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async input => {
      const action = input.action;
      let operation;
      let auditTarget = input.name;
      if (!auditTarget && input.source_path) auditTarget = input.source_path;
      if (!auditTarget && input.source_url) {
        try { auditTarget = new URL(input.source_url).origin; }
        catch { auditTarget = 'remote-skill-source'; }
      }
      try {
        operation = await audit.begin('desktop_skill_manage', riskForAction(action), policy.profile, auditTarget);
      } catch (error) {
        return failure('Skill audit start failed', error);
      }

      try {
        let result: unknown;
        switch (action) {
          case 'list': {
            const skills = await store.list();
            result = { action, skills: skills.map(compactSkill), count: skills.length };
            break;
          }
          case 'get': {
            if (!input.name) throw new Error('get requires name.');
            result = { action, skill: await store.get(input.name) };
            break;
          }
          case 'read': {
            if (!input.name) throw new Error('read requires name.');
            result = {
              action,
              resource: await store.read(input.name, input.resource_path, input.version, input.max_chars)
            };
            break;
          }
          case 'validate': {
            const source = await resolveSource(policy, input.source_path, input.source_url, input.expected_sha256);
            result = { action, validation: await store.validate(source) };
            break;
          }
          case 'install': {
            policy.assertCanWrite();
            const source = await resolveSource(policy, input.source_path, input.source_url, input.expected_sha256);
            result = { action, result: await store.install(source, input.activate) };
            break;
          }
          case 'activate': {
            policy.assertCanWrite();
            if (!input.name || !input.version) throw new Error('activate requires name and version.');
            result = { action, skill: await store.activate(input.name, input.version) };
            break;
          }
          case 'rollback': {
            policy.assertCanWrite();
            if (!input.name) throw new Error('rollback requires name.');
            result = { action, skill: await store.rollback(input.name) };
            break;
          }
        }
        await audit.finish(operation, 'allow');
        return jsonResult(result);
      } catch (error) {
        const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
        try { await audit.finish(operation, outcome, error); }
        catch (auditError) { return failure('Skill audit finalization failed', auditError); }
        return failure('Skill operation failed', error);
      }
    }
  );
}
