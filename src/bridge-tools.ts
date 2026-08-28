import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger, AuditRisk } from './audit.js';
import type { DesktopCommanderBridge } from './desktop-commander-bridge.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import type { ObservationStore } from './observation-store.js';
import { SafeSearchRunner } from './search-runner.js';
import { PROJECT_ROOT } from './paths.js';

function failure(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
    isError: true as const
  };
}

function resultText(result: { text: string; isError: boolean }) {
  return {
    content: [{ type: 'text' as const, text: result.text }],
    ...(result.isError ? { isError: true as const } : {})
  };
}

const pathSchema = z.string().min(1).max(4096);
function lexicalTarget(rawPath: string): string {
  return path.resolve(PROJECT_ROOT, rawPath);
}

async function auditedCall(
  audit: AuditLogger,
  policy: DesktopPolicy,
  tool: string,
  risk: AuditRisk,
  target: string | undefined,
  prefix: string,
  action: () => Promise<{ text: string; isError: boolean }>
) {
  let operation;
  try {
    operation = await audit.begin(tool, risk, policy.profile, target);
  } catch (error) {
    return failure('Audit start failed', error);
  }

  try {
    const result = await action();
    if (result.isError) {
      await audit.finish(operation, 'fail', new Error('DownstreamToolError'));
    } else {
      await audit.finish(operation, 'allow');
    }
    return resultText(result);
  } catch (error) {
    const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
    try {
      await audit.finish(operation, outcome, error);
    } catch (auditError) {
      return failure('Audit finalization failed', auditError);
    }
    return failure(prefix, error);
  }
}

export function registerDesktopCommanderBridgeTools(
  server: McpServer,
  bridge: DesktopCommanderBridge,
  policy: DesktopPolicy,
  audit: AuditLogger,
  observations: ObservationStore
): void {
  const searches = new SafeSearchRunner(bridge, policy);

  server.registerTool(
    'desktop_policy_status',
    {
      title: 'DeskMCP Policy Status',
      description: 'Show the locally configured DeskMCP permission profile and allowed roots.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => auditedCall(
      audit,
      policy,
      'desktop_policy_status',
      'read',
      undefined,
      'Policy status failed',
      async () => ({ text: JSON.stringify(policy.info(), null, 2), isError: false })
    )
  );

  server.registerTool(
    'desktop_read_file',
    {
      title: 'Read Desktop File',
      description: 'Read a local file through Desktop Commander after DeskMCP path-policy checks.',
      inputSchema: z.object({
        path: pathSchema,
        offset: z.number().int().optional().default(0),
        length: z.number().int().min(1).max(5000).optional().default(1000)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path: rawPath, offset, length }) => auditedCall(
      audit,
      policy,
      'desktop_read_file',
      'read',
      lexicalTarget(rawPath),
      'Desktop read denied or failed',
      async () => {
        const safePath = await policy.resolveReadPath(rawPath);
        const before = await observations.capture(safePath);
        const result = await bridge.readFile(safePath, offset, length);
        if (!result.isError) {
          await observations.recordIfUnchanged(safePath, before);
        }
        return result;
      }
    )
  );

  server.registerTool(
    'desktop_list_directory',
    {
      title: 'List Desktop Directory',
      description: 'List a local directory through Desktop Commander after DeskMCP path-policy checks.',
      inputSchema: z.object({
        path: pathSchema,
        depth: z.number().int().min(1).max(4).optional().default(2)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path: rawPath, depth }) => auditedCall(
      audit,
      policy,
      'desktop_list_directory',
      'read',
      lexicalTarget(rawPath),
      'Desktop directory list denied or failed',
      async () => {
        const safePath = await policy.resolveReadPath(rawPath);
        return bridge.listDirectory(safePath, depth);
      }
    )
  );

  server.registerTool(
    'desktop_get_file_info',
    {
      title: 'Get Desktop File Info',
      description: 'Read metadata for a local file or directory after DeskMCP path-policy checks.',
      inputSchema: z.object({ path: pathSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path: rawPath }) => auditedCall(
      audit,
      policy,
      'desktop_get_file_info',
      'read',
      lexicalTarget(rawPath),
      'Desktop file info denied or failed',
      async () => {
        const safePath = await policy.resolveReadPath(rawPath);
        return bridge.getFileInfo(safePath);
      }
    )
  );

  server.registerTool(
    'desktop_search',
    {
      title: 'Search Desktop Files',
      description: 'Run a bounded one-shot file or content search inside allowed roots. Internal search sessions are never exposed.',
      inputSchema: z.object({
        path: pathSchema,
        pattern: z.string().min(1).max(500),
        search_type: z.enum(['files', 'content']).optional().default('files'),
        file_pattern: z.string().min(1).max(256).optional(),
        ignore_case: z.boolean().optional().default(true),
        max_results: z.number().int().min(1).max(100).optional().default(50),
        include_hidden: z.boolean().optional().default(false),
        literal_search: z.boolean().optional().default(false),
        timeout_ms: z.number().int().min(500).max(10000).optional().default(5000)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({
      path: rawPath,
      pattern,
      search_type,
      file_pattern,
      ignore_case,
      max_results,
      include_hidden,
      literal_search,
      timeout_ms
    }) => auditedCall(
      audit,
      policy,
      'desktop_search',
      'read',
      lexicalTarget(rawPath),
      'Desktop search denied or failed',
      async () => {
        const safePath = await policy.resolveReadPath(rawPath);
        return searches.run({
          rootPath: safePath,
          pattern,
          searchType: search_type,
          ...(file_pattern ? { filePattern: file_pattern } : {}),
          ignoreCase: ignore_case,
          maxResults: max_results,
          includeHidden: include_hidden,
          literalSearch: literal_search,
          timeoutMs: timeout_ms
        });
      }
    )
  );

  server.registerTool(
    'desktop_create_directory',
    {
      title: 'Create Desktop Directory',
      description: 'Create a directory through Desktop Commander inside locally allowed roots.',
      inputSchema: z.object({ path: pathSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path: rawPath }) => auditedCall(
      audit,
      policy,
      'desktop_create_directory',
      'write',
      lexicalTarget(rawPath),
      'Desktop directory creation denied or failed',
      async () => {
        const safePath = await policy.resolveWritePath(rawPath);
        return bridge.createDirectory(safePath);
      }
    )
  );

  server.registerTool(
    'desktop_move_file',
    {
      title: 'Move Desktop File',
      description: 'Move one observed regular file to a new path inside allowed roots. Destination must not exist.',
      inputSchema: z.object({
        source: pathSchema,
        destination: pathSchema
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ source, destination }) => auditedCall(
      audit,
      policy,
      'desktop_move_file',
      'write',
      `${lexicalTarget(source)} -> ${lexicalTarget(destination)}`,
      'Desktop move denied or failed',
      async () => {
        policy.assertCanWrite();
        const safeSource = await policy.resolveReadPath(source);
        await observations.requireFresh(safeSource);
        const safeDestination = await policy.resolveNewWritePath(destination);
        const result = await bridge.moveFile(safeSource, safeDestination);
        if (!result.isError) {
          observations.forget(safeSource);
          await observations.observe(safeDestination);
        }
        return result;
      }
    )
  );
  server.registerTool(
    'desktop_edit_file',
    {
      title: 'Edit Desktop Text File',
      description: 'Replace exact text through Desktop Commander. Requires a fresh prior desktop_read_file observation.',
      inputSchema: z.object({
        path: pathSchema,
        old_string: z.string().min(1).max(128 * 1024),
        new_string: z.string().max(128 * 1024),
        expected_replacements: z.number().int().min(1).max(100).optional().default(1)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ path: rawPath, old_string, new_string, expected_replacements }) => auditedCall(
      audit,
      policy,
      'desktop_edit_file',
      'write',
      lexicalTarget(rawPath),
      'Desktop edit denied or failed',
      async () => {
        policy.assertCanWrite();
        const safePath = await policy.resolveReadPath(rawPath);
        await observations.requireFresh(safePath);
        const result = await bridge.editTextFile(
          safePath,
          old_string,
          new_string,
          expected_replacements
        );
        if (!result.isError) await observations.observe(safePath);
        return result;
      }
    )
  );
  server.registerTool(
    'desktop_write_file',
    {
      title: 'Write Desktop File',
      description: 'Write or append a local file through Desktop Commander after DeskMCP policy checks.',
      inputSchema: z.object({
        path: pathSchema,
        content: z.string().min(1).max(1024 * 1024),
        mode: z.enum(['rewrite', 'append'])
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ path: rawPath, content, mode }) => auditedCall(
      audit,
      policy,
      'desktop_write_file',
      'write',
      lexicalTarget(rawPath),
      'Desktop write denied or failed',
      async () => {
        const safePath = await policy.resolveWritePath(rawPath);
        await observations.requireFreshIfExists(safePath);
        const result = await bridge.writeFile(safePath, content, mode);
        if (!result.isError) await observations.observe(safePath);
        return result;
      }
    )
  );
}
