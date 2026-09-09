import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import type { BrowserAction } from './browser-cdp.js';
import type { BrowserRuntime } from './browser-runtime.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';

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

function requireBrowserControl(policy: DesktopPolicy): void {
  if (policy.profile !== 'full-control' && policy.profile !== 'fully-unlocked') {
    throw new PolicyDeniedError('Browser automation requires DESKTOP_MCP_PROFILE=full-control or fully-unlocked.');
  }
}

const timeoutSchema = z.number().int().min(1000).max(60000).optional();
const sessionIdSchema = z.string().uuid();
const pageIdSchema = z.string().min(1).max(512).optional();
const snapshotOptionsSchema = {
  full_page: z.boolean().optional().default(false),
  screenshot: z.boolean().optional().default(true),
  max_text_chars: z.number().int().min(1).max(50000).optional().default(8000),
  max_interactive_elements: z.number().int().min(1).max(500).optional().default(100),
  timeout_ms: timeoutSchema
};

const browserActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('goto'),
    url: z.string().url().max(8192),
    wait_until: z.enum(['domcontentloaded', 'load']).optional().default('domcontentloaded'),
    timeout_ms: timeoutSchema
  }),
  z.object({ type: z.literal('click'), selector: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('fill'), selector: z.string().min(1).max(4096), value: z.string().max(65536) }),
  z.object({ type: z.literal('press'), selector: z.string().min(1).max(4096).optional(), key: z.string().min(1).max(64) }),
  z.object({ type: z.literal('wait'), duration_ms: z.number().int().min(0).max(30000) }),
  z.object({
    type: z.literal('wait_selector'),
    selector: z.string().min(1).max(4096),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().default('visible'),
    timeout_ms: timeoutSchema
  }),
  z.object({ type: z.literal('wait_url'), url: z.string().url().max(8192), timeout_ms: timeoutSchema }),
  z.object({
    type: z.literal('wait_text'),
    text: z.string().min(1).max(4096),
    exact: z.boolean().optional().default(false),
    state: z.enum(['visible', 'hidden']).optional().default('visible'),
    timeout_ms: timeoutSchema
  }),
  z.object({ type: z.literal('select'), selector: z.string().min(1).max(4096), value: z.string().max(4096) }),
  z.object({
    type: z.literal('scroll'),
    delta_x: z.number().int().min(-100000).max(100000).optional().default(0),
    delta_y: z.number().int().min(-100000).max(100000).optional().default(0)
  }),
  z.object({
    type: z.literal('navigation'),
    direction: z.enum(['back', 'forward', 'reload']),
    timeout_ms: timeoutSchema
  })
]);

export function registerBrowserTools(
  server: McpServer,
  policy: DesktopPolicy,
  audit: AuditLogger,
  browser: BrowserRuntime
): void {
  server.registerTool(
    'desktop_browser_session',
    {
      title: 'Manage Isolated Browser Session',
      description: 'Start, list, or close DeskMCP-owned isolated Chromium browser sessions. Browser start requires a locally configured DESKTOP_MCP_BROWSER_EXECUTABLE and never reuses a personal browser/CDP session.',
      inputSchema: z.object({
        action: z.enum(['start', 'list', 'close']),
        session_id: sessionIdSchema.optional(),
        url: z.string().url().max(8192).optional(),
        headless: z.boolean().optional().default(true),
        profile_id: z.string().min(1).max(64).optional(),
        viewport: z.object({
          width: z.number().int().min(320).max(7680),
          height: z.number().int().min(240).max(4320)
        }).optional(),
        timeout_ms: timeoutSchema,
        agent_desktop_lease_id: z.string().uuid().optional()
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async input => {
      let operation;
      try {
        operation = await audit.begin('desktop_browser_session', 'process', policy.profile, input.session_id);
      } catch (error) {
        return failure('Browser audit start failed', error);
      }
      try {
        requireBrowserControl(policy);
        let result: unknown;
        if (input.action === 'start') {
          result = await browser.start({
            ...(input.url ? { url: input.url } : {}),
            headless: input.headless,
            ...(input.profile_id ? { profile_id: input.profile_id } : {}),
            ...(input.viewport ? { viewport: input.viewport } : {}),
            ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
            ...(input.agent_desktop_lease_id ? { agent_desktop_lease_id: input.agent_desktop_lease_id } : {})
          });
        } else if (input.action === 'list') {
          const sessions = await browser.list();
          result = { sessions, count: sessions.length };
        } else {
          if (!input.session_id) throw new Error('Browser close requires session_id.');
          result = await browser.close(input.session_id);
        }
        await audit.finish(operation, 'allow');
        return jsonResult(result);
      } catch (error) {
        const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
        try { await audit.finish(operation, outcome, error); }
        catch (auditError) { return failure('Browser audit finalization failed', auditError); }
        return failure('Browser session operation failed', error);
      }
    }
  );

  server.registerTool(
    'desktop_browser_snapshot',
    {
      title: 'Snapshot Isolated Browser Page',
      description: 'Read a typed snapshot from a DeskMCP-owned browser page, including text, interactive elements, focus state, page list, and an optional verified screenshot Artifact.',
      inputSchema: z.object({
        session_id: sessionIdSchema,
        page_id: pageIdSchema,
        ...snapshotOptionsSchema
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ session_id, page_id, full_page, screenshot, max_text_chars, max_interactive_elements, timeout_ms }) => {
      let operation;
      try {
        operation = await audit.begin('desktop_browser_snapshot', 'read', policy.profile, session_id);
      } catch (error) {
        return failure('Browser audit start failed', error);
      }
      try {
        requireBrowserControl(policy);
        const result = await browser.snapshot(session_id, page_id, {
          full_page,
          screenshot,
          max_text_chars,
          max_interactive_elements,
          ...(timeout_ms !== undefined ? { timeout_ms } : {})
        });
        await audit.finish(operation, 'allow');
        return jsonResult(result);
      } catch (error) {
        const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
        try { await audit.finish(operation, outcome, error); }
        catch (auditError) { return failure('Browser audit finalization failed', auditError); }
        return failure('Browser snapshot failed', error);
      }
    }
  );

  server.registerTool(
    'desktop_browser_act',
    {
      title: 'Act In Isolated Browser Page',
      description: 'Run a bounded sequence of validated browser actions against a DeskMCP-owned isolated browser page, then return a fresh typed snapshot and optional screenshot Artifact.',
      inputSchema: z.object({
        session_id: sessionIdSchema,
        page_id: pageIdSchema,
        actions: z.array(browserActionSchema).min(1).max(20),
        ...snapshotOptionsSchema
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ session_id, page_id, actions, full_page, screenshot, max_text_chars, max_interactive_elements, timeout_ms }) => {
      let operation;
      try {
        operation = await audit.begin('desktop_browser_act', 'process', policy.profile, session_id);
      } catch (error) {
        return failure('Browser audit start failed', error);
      }
      try {
        requireBrowserControl(policy);
        const result = await browser.act(
          session_id,
          page_id,
          actions as readonly BrowserAction[],
          {
            full_page,
            screenshot,
            max_text_chars,
            max_interactive_elements,
            ...(timeout_ms !== undefined ? { timeout_ms } : {})
          }
        );
        await audit.finish(operation, 'allow');
        return jsonResult(result);
      } catch (error) {
        const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
        try { await audit.finish(operation, outcome, error); }
        catch (auditError) { return failure('Browser audit finalization failed', auditError); }
        return failure('Browser action failed', error);
      }
    }
  );
}
