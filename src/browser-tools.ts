import type { McpServer } from '@modelcontextprotocol/server';
import { stat } from 'node:fs/promises';
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
  include_console: z.boolean().optional().default(false),
  max_console_messages: z.number().int().min(1).max(200).optional().default(50),
  include_network: z.boolean().optional().default(false),
  max_network_events: z.number().int().min(1).max(500).optional().default(100),
  timeout_ms: timeoutSchema
};

const elementSelectorSchema = z.string().min(1).max(4096).optional();
const elementRefSchema = z.string().regex(/^(?:f[1-9][0-9]{0,6})*e[1-9][0-9]{0,6}$/u).optional();
const exactlyOneElementTarget = (value: { selector?: string | undefined; ref?: string | undefined }) =>
  Boolean(value.selector) !== Boolean(value.ref);
const atMostOneElementTarget = (value: { selector?: string | undefined; ref?: string | undefined }) =>
  !(value.selector && value.ref);

const browserActionSchema = z.union([
  z.object({
    type: z.literal('goto'),
    url: z.string().url().max(8192),
    wait_until: z.enum(['domcontentloaded', 'load']).optional().default('domcontentloaded'),
    timeout_ms: timeoutSchema
  }),
  z.object({ type: z.literal('click'), selector: elementSelectorSchema, ref: elementRefSchema })
    .refine(exactlyOneElementTarget, { message: 'Browser click requires exactly one of selector or ref.' }),
  z.object({ type: z.literal('hover'), selector: elementSelectorSchema, ref: elementRefSchema })
    .refine(exactlyOneElementTarget, { message: 'Browser hover requires exactly one of selector or ref.' }),
  z.object({
    type: z.literal('drag'),
    source_selector: elementSelectorSchema,
    source_ref: elementRefSchema,
    target_selector: elementSelectorSchema,
    target_ref: elementRefSchema
  })
    .refine(value => Boolean(value.source_selector) !== Boolean(value.source_ref), { message: 'Browser drag source requires exactly one of source_selector or source_ref.' })
    .refine(value => Boolean(value.target_selector) !== Boolean(value.target_ref), { message: 'Browser drag target requires exactly one of target_selector or target_ref.' }),
  z.object({ type: z.literal('fill'), selector: elementSelectorSchema, ref: elementRefSchema, value: z.string().max(65536) })
    .refine(exactlyOneElementTarget, { message: 'Browser fill requires exactly one of selector or ref.' }),
  z.object({
    type: z.literal('type_text'),
    selector: elementSelectorSchema,
    ref: elementRefSchema,
    text: z.string().max(65536),
    delay_ms: z.number().int().min(0).max(250).optional().default(0)
  }).refine(exactlyOneElementTarget, { message: 'Browser type_text requires exactly one of selector or ref.' }),
  z.object({
    type: z.literal('set_checked'),
    selector: elementSelectorSchema,
    ref: elementRefSchema,
    checked: z.boolean()
  }).refine(exactlyOneElementTarget, { message: 'Browser set_checked requires exactly one of selector or ref.' }),
  z.object({ type: z.literal('press'), selector: elementSelectorSchema, ref: elementRefSchema, key: z.string().min(1).max(64) })
    .refine(atMostOneElementTarget, { message: 'Browser press accepts at most one of selector or ref.' }),
  z.object({ type: z.literal('wait'), duration_ms: z.number().int().min(0).max(30000) }),
  z.object({
    type: z.literal('wait_selector'),
    selector: elementSelectorSchema,
    ref: elementRefSchema,
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().default('visible'),
    timeout_ms: timeoutSchema
  }).refine(exactlyOneElementTarget, { message: 'Browser wait_selector requires exactly one of selector or ref.' }),
  z.object({ type: z.literal('wait_url'), url: z.string().url().max(8192), timeout_ms: timeoutSchema }),
  z.object({
    type: z.literal('wait_text'),
    text: z.string().min(1).max(4096),
    exact: z.boolean().optional().default(false),
    state: z.enum(['visible', 'hidden']).optional().default('visible'),
    timeout_ms: timeoutSchema
  }),
  z.object({ type: z.literal('select'), selector: elementSelectorSchema, ref: elementRefSchema, value: z.string().max(4096) })
    .refine(exactlyOneElementTarget, { message: 'Browser select requires exactly one of selector or ref.' }),
  z.object({
    type: z.literal('set_files'),
    selector: elementSelectorSchema,
    ref: elementRefSchema,
    files: z.array(z.string().min(1).max(4096)).min(1).max(10)
  }).refine(exactlyOneElementTarget, { message: 'Browser set_files requires exactly one of selector or ref.' }),
  z.object({
    type: z.literal('download'),
    selector: elementSelectorSchema,
    ref: elementRefSchema
  }).refine(exactlyOneElementTarget, { message: 'Browser download requires exactly one of selector or ref.' }),
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

type BrowserActionInput = z.infer<typeof browserActionSchema>;
type BrowserDownloadAction = Extract<BrowserActionInput, { type: 'download' }>;
type ResolvedBrowserToolAction = BrowserAction | BrowserDownloadAction;

async function resolveBrowserActions(policy: DesktopPolicy, actions: readonly BrowserActionInput[]): Promise<ResolvedBrowserToolAction[]> {
  const resolved: ResolvedBrowserToolAction[] = [];
  for (const action of actions) {
    if (action.type !== 'set_files') {
      resolved.push(action as ResolvedBrowserToolAction);
      continue;
    }
    const files: string[] = [];
    for (const requested of action.files) {
      const canonical = await policy.resolveReadPath(requested);
      const info = await stat(canonical);
      if (!info.isFile()) throw new Error(`Browser upload path is not a regular file: ${requested}.`);
      files.push(canonical);
    }
    resolved.push({
      type: 'set_files',
      ...(action.selector ? { selector: action.selector } : {}),
      ...(action.ref ? { ref: action.ref } : {}),
      files
    });
  }
  return resolved;
}

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
      description: 'Start, list, or close DeskMCP-owned isolated Chromium browser sessions, create/select/close tabs, handle a blocking JavaScript dialog, and list or delete persistent DeskMCP browser profiles. Browser start requires a locally configured DESKTOP_MCP_BROWSER_EXECUTABLE and never reuses a personal browser/CDP session.',
      inputSchema: z.object({
        action: z.enum(['start', 'list', 'close', 'new_page', 'select_page', 'close_page', 'handle_dialog', 'list_profiles', 'delete_profile']),
        session_id: sessionIdSchema.optional(),
        page_id: pageIdSchema,
        url: z.string().url().max(8192).optional(),
        accept: z.boolean().optional(),
        prompt_text: z.string().max(4096).optional(),
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
        operation = await audit.begin('desktop_browser_session', 'process', policy.profile, input.session_id ?? input.profile_id);
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
        } else if (input.action === 'new_page') {
          if (!input.session_id) throw new Error('Browser new_page requires session_id.');
          result = await browser.newPage(input.session_id, input.url, input.timeout_ms);
        } else if (input.action === 'select_page') {
          if (!input.session_id || !input.page_id) throw new Error('Browser select_page requires session_id and page_id.');
          result = await browser.selectPage(input.session_id, input.page_id, input.timeout_ms);
        } else if (input.action === 'close_page') {
          if (!input.session_id || !input.page_id) throw new Error('Browser close_page requires session_id and page_id.');
          result = await browser.closePage(input.session_id, input.page_id, input.timeout_ms);
        } else if (input.action === 'handle_dialog') {
          if (!input.session_id || !input.page_id || input.accept === undefined) throw new Error('Browser handle_dialog requires session_id, page_id, and accept.');
          result = await browser.handleDialog(input.session_id, input.page_id, input.accept, input.prompt_text, input.timeout_ms);
        } else if (input.action === 'list_profiles') {
          const profiles = await browser.listProfiles();
          result = { profiles, count: profiles.length };
        } else if (input.action === 'delete_profile') {
          if (!input.profile_id) throw new Error('Browser delete_profile requires profile_id.');
          result = await browser.deleteProfile(input.profile_id);
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
      description: 'Read a typed snapshot from a DeskMCP-owned browser page. mode=full returns the bounded page snapshot; mode=find searches the sanitized Playwright AI accessibility tree and returns compact matching nodes with refs plus a fresh browser_observation_id.',
      inputSchema: z.object({
        session_id: sessionIdSchema,
        page_id: pageIdSchema,
        mode: z.enum(['full', 'find']).optional().default('full'),
        find_query: z.string().min(1).max(1024).optional(),
        find_case_sensitive: z.boolean().optional().default(false),
        max_find_results: z.number().int().min(1).max(50).optional().default(20),
        ...snapshotOptionsSchema
      }).superRefine((value, context) => {
        if (value.mode === 'find' && !value.find_query?.trim()) {
          context.addIssue({ code: 'custom', path: ['find_query'], message: 'Browser snapshot mode=find requires find_query.' });
        }
        if (value.mode === 'full' && value.find_query !== undefined) {
          context.addIssue({ code: 'custom', path: ['find_query'], message: 'find_query is only valid when mode=find.' });
        }
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ session_id, page_id, mode, find_query, find_case_sensitive, max_find_results, full_page, screenshot, max_text_chars, max_interactive_elements, include_console, max_console_messages, include_network, max_network_events, timeout_ms }) => {
      let operation;
      try {
        operation = await audit.begin('desktop_browser_snapshot', 'read', policy.profile, session_id);
      } catch (error) {
        return failure('Browser audit start failed', error);
      }
      try {
        requireBrowserControl(policy);
        const result = mode === 'find'
          ? await browser.find(session_id, page_id, {
              query: find_query!,
              case_sensitive: find_case_sensitive,
              max_results: max_find_results,
              ...(timeout_ms !== undefined ? { timeout_ms } : {})
            })
          : await browser.snapshot(session_id, page_id, {
              full_page,
              screenshot,
              max_text_chars,
              max_interactive_elements,
              include_console,
              max_console_messages,
              include_network,
              max_network_events,
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
      description: 'Run a bounded sequence of validated browser actions using a fresh one-time browser_observation_id from desktop_browser_snapshot. The observation is consumed before the action and stale page state is rejected. Returns a fresh snapshot and observation afterward.',
      inputSchema: z.object({
        session_id: sessionIdSchema,
        page_id: pageIdSchema,
        browser_observation_id: z.string().uuid(),
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
    async ({ session_id, page_id, browser_observation_id, actions, full_page, screenshot, max_text_chars, max_interactive_elements, include_console, max_console_messages, include_network, max_network_events, timeout_ms }) => {
      let operation;
      try {
        operation = await audit.begin('desktop_browser_act', 'process', policy.profile, session_id);
      } catch (error) {
        return failure('Browser audit start failed', error);
      }
      try {
        requireBrowserControl(policy);
        const resolvedActions = await resolveBrowserActions(policy, actions);
        const snapshotOptions = {
          full_page,
          screenshot,
          max_text_chars,
          max_interactive_elements,
          include_console,
          max_console_messages,
          include_network,
          max_network_events,
          ...(timeout_ms !== undefined ? { timeout_ms } : {})
        };
        const downloadAction = resolvedActions.find((action): action is BrowserDownloadAction => action.type === 'download');
        let result;
        if (downloadAction) {
          if (resolvedActions.length !== 1) {
            throw new Error('Browser download must be the only action authorized by this browser observation.');
          }
          result = await browser.download(
            session_id,
            page_id,
            browser_observation_id,
            downloadAction.selector,
            downloadAction.ref,
            snapshotOptions
          );
        } else {
          result = await browser.act(
            session_id,
            page_id,
            browser_observation_id,
            resolvedActions as BrowserAction[],
            snapshotOptions
          );
        }
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
