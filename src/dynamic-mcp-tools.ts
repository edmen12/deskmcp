import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger, AuditRisk } from './audit.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import { DynamicMcpHub } from './dynamic-mcp-hub.js';

const MANAGE_ACTIONS = ['list', 'inspect', 'add', 'remove', 'enable', 'disable', 'refresh'] as const;
type ManageAction = typeof MANAGE_ACTIONS[number];

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

function requireFullControl(policy: DesktopPolicy): void {
  if (policy.profile !== 'full-control' && policy.profile !== 'fully-unlocked') {
    throw new PolicyDeniedError(
      'Dynamic MCP network operations require DESKTOP_MCP_PROFILE=full-control or fully-unlocked.'
    );
  }
}

function manageRisk(action: ManageAction): AuditRisk {
  return action === 'list' || action === 'inspect' ? 'read' : 'write';
}

async function audited<T>(
  audit: AuditLogger,
  policy: DesktopPolicy,
  tool: string,
  risk: AuditRisk,
  target: string | undefined,
  prefix: string,
  action: () => Promise<T>
) {
  let operation;
  try {
    operation = await audit.begin(tool, risk, policy.profile, target);
  } catch (error) {
    return failure(`${prefix} audit start failed`, error);
  }
  try {
    const result = await action();
    await audit.finish(operation, 'allow');
    return jsonResult(result);
  } catch (error) {
    const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
    try {
      await audit.finish(operation, outcome, error);
    } catch (auditError) {
      return failure(`${prefix} audit finalization failed`, auditError);
    }
    return failure(prefix, error);
  }
}

export function registerDynamicMcpTools(
  server: McpServer,
  policy: DesktopPolicy,
  audit: AuditLogger,
  hub: DynamicMcpHub
): void {
  server.registerTool(
    'desktop_mcp_manage',
    {
      title: 'Manage Dynamic MCP Servers',
      description: 'Manage DeskMCP\'s dynamic Streamable HTTP MCP registry. Registry entries store only endpoint metadata and environment-variable names for headers; secret values are never persisted or returned. Remote HTTP is rejected; remote endpoints must use HTTPS, while loopback HTTP is allowed.',
      inputSchema: z.object({
        action: z.enum(MANAGE_ACTIONS),
        name: z.string().max(64).optional(),
        description: z.string().max(1024).optional(),
        url: z.string().max(4096).optional(),
        header_env: z.record(z.string(), z.string()).optional(),
        enabled: z.boolean().optional(),
        timeout_ms: z.number().int().min(250).max(300000).optional()
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async input => audited(
      audit,
      policy,
      'desktop_mcp_manage',
      manageRisk(input.action),
      input.name,
      'Dynamic MCP management failed',
      async () => {
        switch (input.action) {
          case 'list':
            return { action: input.action, servers: await hub.listServers() };
          case 'inspect':
            if (!input.name) throw new Error('inspect requires name.');
            return { action: input.action, server: await hub.inspectServer(input.name) };
          case 'add':
            policy.assertCanWrite();
            if (!input.name || !input.url) throw new Error('add requires name and url.');
            return {
              action: input.action,
              server: await hub.addServer({
                name: input.name,
                url: input.url,
                ...(input.description ? { description: input.description } : {}),
                ...(input.header_env ? { header_env: input.header_env } : {}),
                ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
                ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {})
              })
            };
          case 'remove':
            policy.assertCanWrite();
            if (!input.name) throw new Error('remove requires name.');
            return { action: input.action, name: input.name, removed: await hub.removeServer(input.name) };
          case 'enable':
            policy.assertCanWrite();
            if (!input.name) throw new Error('enable requires name.');
            return { action: input.action, server: await hub.setEnabled(input.name, true) };
          case 'disable':
            policy.assertCanWrite();
            if (!input.name) throw new Error('disable requires name.');
            return { action: input.action, server: await hub.setEnabled(input.name, false) };
          case 'refresh':
            requireFullControl(policy);
            return { action: input.action, results: await hub.refresh(input.name) };
        }
      }
    )
  );

  server.registerTool(
    'desktop_mcp_tool_search',
    {
      title: 'Search Cached Dynamic MCP Tools',
      description: 'Search lightweight tool metadata cached by desktop_mcp_manage refresh. This search does not contact upstream MCP servers.',
      inputSchema: z.object({
        query: z.string().min(1).max(1024),
        server: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(100).optional()
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async input => audited(
      audit,
      policy,
      'desktop_mcp_tool_search',
      'read',
      input.server,
      'Dynamic MCP tool search failed',
      async () => {
        const tools = await hub.searchTools(input.query, input.server, input.limit ?? 10);
        return { query: input.query, ...(input.server ? { server: input.server } : {}), tools, count: tools.length };
      }
    )
  );

  server.registerTool(
    'desktop_mcp_tool_inspect',
    {
      title: 'Inspect Cached Dynamic MCP Tool',
      description: 'Return the cached upstream schema and annotations for a qualified <server>:<tool> name without contacting the upstream server.',
      inputSchema: z.object({ name: z.string().min(3).max(512) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async input => audited(
      audit,
      policy,
      'desktop_mcp_tool_inspect',
      'read',
      input.name,
      'Dynamic MCP tool inspect failed',
      async () => ({ name: input.name, tool: await hub.inspectTool(input.name) })
    )
  );

  server.registerTool(
    'desktop_mcp_tool_call',
    {
      title: 'Call Dynamic MCP Tool',
      description: 'Call an upstream MCP tool by qualified <server>:<tool> name. DeskMCP reconnects transiently, refreshes the live tool definition before the call, and requires full-control or fully-unlocked. Header secrets are read from the local process environment only at call time and are never stored in the registry.',
      inputSchema: z.object({
        name: z.string().min(3).max(512),
        arguments: z.record(z.string(), z.unknown()).default({})
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async input => audited(
      audit,
      policy,
      'desktop_mcp_tool_call',
      'write',
      input.name,
      'Dynamic MCP tool call failed',
      async () => {
        requireFullControl(policy);
        return await hub.callTool(input.name, input.arguments);
      }
    )
  );
}
