import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger, AuditRisk } from './audit.js';
import { ArtifactStore } from './artifact-store.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';

const ACTIONS = ['publish', 'list', 'get', 'read', 'delete'] as const;
type ArtifactAction = typeof ACTIONS[number];

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

function riskForAction(action: ArtifactAction): AuditRisk {
  return action === 'publish' || action === 'delete' ? 'write' : 'read';
}

export function registerArtifactTools(
  server: McpServer,
  policy: DesktopPolicy,
  audit: AuditLogger,
  store: ArtifactStore
): void {
  server.registerTool(
    'desktop_artifact_manage',
    {
      title: 'Manage DeskMCP Artifacts',
      description: 'Publish a policy-approved workspace file into a temporary checksum-verified DeskMCP artifact, list or inspect artifacts, read bounded chunks, or delete an artifact. Publishing never expands workspace access and requires a writable DeskMCP profile.',
      inputSchema: z.object({
        action: z.enum(ACTIONS),
        path: z.string().max(4096).optional(),
        artifact_id: z.string().optional(),
        retention_seconds: z.number().int().min(60).max(604800).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        length: z.number().int().min(1).max(262144).optional(),
        encoding: z.enum(['utf8', 'base64']).optional()
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
      try {
        operation = await audit.begin(
          'desktop_artifact_manage',
          riskForAction(action),
          policy.profile,
          input.path ?? input.artifact_id
        );
      } catch (error) {
        return failure('Artifact audit start failed', error);
      }

      try {
        let result: unknown;
        switch (action) {
          case 'publish': {
            if (!input.path) throw new Error('publish requires path.');
            policy.assertCanWrite();
            const artifact = await store.publishFromPath(input.path, policy, {
              ...(input.retention_seconds !== undefined ? { retention_seconds: input.retention_seconds } : {})
            });
            result = { action, artifact };
            break;
          }
          case 'list': {
            const artifacts = await store.list(input.limit ?? 50);
            result = { action, artifacts, count: artifacts.length };
            break;
          }
          case 'get': {
            if (!input.artifact_id) throw new Error('get requires artifact_id.');
            result = { action, artifact: await store.get(input.artifact_id) };
            break;
          }
          case 'read': {
            if (!input.artifact_id) throw new Error('read requires artifact_id.');
            result = {
              action,
              ...(await store.read(
                input.artifact_id,
                input.offset ?? 0,
                input.length ?? 65536,
                input.encoding ?? 'base64'
              ))
            };
            break;
          }
          case 'delete': {
            policy.assertCanWrite();
            if (!input.artifact_id) throw new Error('delete requires artifact_id.');
            result = { action, artifact_id: input.artifact_id, removed: await store.delete(input.artifact_id) };
            break;
          }
        }
        await audit.finish(operation, 'allow');
        return jsonResult(result);
      } catch (error) {
        const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
        try {
          await audit.finish(operation, outcome, error);
        } catch (auditError) {
          return failure('Artifact audit finalization failed', auditError);
        }
        return failure('Artifact operation failed', error);
      }
    }
  );
}
