import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import type { ComputerWindow, UiAction } from './computer-use-backend.js';
import type { ComputerUseRuntime } from './computer-use-runtime.js';

function failure(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
    isError: true as const
  };
}

function publicWindow(window: ComputerWindow, windowId: string) {
  return {
    window_id: windowId,
    app: window.processName,
    ...(window.title ? { title: window.title } : {}),
    ...(window.className ? { class_name: window.className } : {}),
    width: window.width,
    height: window.height,
    foreground: window.isForeground
  };
}

async function auditedComputerCall<T>(
  audit: AuditLogger,
  policy: DesktopPolicy,
  tool: string,
  target: string | undefined,
  action: () => Promise<T>
): Promise<T | ReturnType<typeof failure>> {
  let operation;
  try {
    operation = await audit.begin(tool, 'computer', policy.profile, target);
  } catch (error) {
    return failure('Audit start failed', error);
  }
  try {
    policy.assertCanUseComputer();
    const result = await action();
    await audit.finish(operation, 'allow');
    return result;
  } catch (error) {
    const outcome = error instanceof PolicyDeniedError ? 'deny' : 'fail';
    try { await audit.finish(operation, outcome, error); }
    catch (auditError) { return failure('Audit finalization failed', auditError); }
    return failure('Computer use denied or failed', error);
  }
}

function selectForegroundOrSingle(windows: readonly ComputerWindow[]): ComputerWindow {
  if (windows.length === 0) throw new Error('No matching visible Windows desktop window was found.');
  if (windows.length === 1) return windows[0]!;
  const foreground = windows.find(window => window.isForeground);
  if (foreground) return foreground;
  throw new Error('Multiple windows matched. Call desktop_ui_windows and pass the returned window_id.');
}

export class RequiresForegroundInputError extends Error {
  readonly code = 'requires_foreground_input';

  constructor(message: string) {
    super(`requires_foreground_input: ${message}`);
    this.name = 'RequiresForegroundInputError';
  }
}

export function prepareAgentDesktopAction(action: UiAction): UiAction {
  switch (action.type) {
    case 'invoke':
    case 'set_value':
    case 'wait':
      return action;
    case 'scroll':
      if (action.wheel !== undefined) {
        throw new RequiresForegroundInputError('mouse-wheel scrolling is disabled in Agent Desktop background mode. Use semantic direction/to scrolling when supported.');
      }
      return action;
    case 'send_keys':
      if (action.allowSystemKeys) {
        throw new RequiresForegroundInputError('system-wide key injection is never allowed in Agent Desktop background mode.');
      }
      if (action.transport === 'send-input') {
        throw new RequiresForegroundInputError('SendInput is disabled in Agent Desktop background mode. Use post-message or set_value.');
      }
      return { ...action, transport: 'post-message', allowSystemKeys: false };
    case 'click':
      throw new RequiresForegroundInputError('physical mouse click is disabled in Agent Desktop background mode. Use invoke when the element exposes an invoke pattern.');
    case 'hover':
      throw new RequiresForegroundInputError('physical mouse hover is disabled in Agent Desktop background mode.');
    case 'drag':
      throw new RequiresForegroundInputError('physical drag is disabled in Agent Desktop background mode.');
  }
}

function isAgentDesktopSafetyWindow(window: ComputerWindow): boolean {
  return window.title?.startsWith('DeskMCP Agent Desktop') === true;
}

function parseAction(input: {
  action: string;
  selector?: string | undefined;
  value?: string | undefined;
  keys?: string | undefined;
  button?: 'left' | 'right' | undefined;
  double?: boolean | undefined;
  direction?: 'up' | 'down' | 'left' | 'right' | undefined;
  to?: 'top' | 'bottom' | undefined;
  wheel?: number | undefined;
  transport?: 'post-message' | 'send-input' | undefined;
  verbatim?: boolean | undefined;
  allow_system_keys?: boolean | undefined;
  from?: string | undefined;
  drag_to?: string | undefined;
  hold_ms?: number | undefined;
  dwell_ms?: number | undefined;
  wait_ms?: number | undefined;
}): UiAction {
  switch (input.action) {
    case 'invoke':
      if (!input.selector) throw new Error('invoke requires selector.');
      return { type: 'invoke', selector: input.selector };
    case 'set_value':
      if (!input.selector || input.value === undefined) throw new Error('set_value requires selector and value.');
      return { type: 'set_value', selector: input.selector, value: input.value };
    case 'click':
      if (!input.selector) throw new Error('click requires selector. Prefer invoke when the element exposes an invoke pattern.');
      return { type: 'click', selector: input.selector, ...(input.button ? { button: input.button } : {}), ...(input.double !== undefined ? { double: input.double } : {}) };
    case 'hover':
      if (!input.selector) throw new Error('hover requires selector.');
      return { type: 'hover', selector: input.selector, ...(input.dwell_ms !== undefined ? { dwellMs: input.dwell_ms } : {}) };
    case 'scroll':
      if (!input.direction && !input.to && input.wheel === undefined) throw new Error('scroll requires direction, to, or wheel.');
      return {
        type: 'scroll',
        ...(input.selector ? { selector: input.selector } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.to ? { to: input.to } : {}),
        ...(input.wheel !== undefined ? { wheel: input.wheel } : {})
      };
    case 'send_keys':
      if (!input.keys) throw new Error('send_keys requires keys.');
      return {
        type: 'send_keys',
        keys: input.keys,
        ...(input.selector ? { selector: input.selector } : {}),
        ...(input.transport ? { transport: input.transport } : {}),
        ...(input.verbatim !== undefined ? { verbatim: input.verbatim } : {}),
        ...(input.allow_system_keys !== undefined ? { allowSystemKeys: input.allow_system_keys } : {})
      };
    case 'drag':
      if (!input.from || !input.drag_to) throw new Error('drag requires from and drag_to selectors or x,y screen coordinates.');
      return {
        type: 'drag',
        from: input.from,
        to: input.drag_to,
        ...(input.button === 'right' ? { right: true } : {}),
        ...(input.hold_ms !== undefined ? { holdMs: input.hold_ms } : {}),
        ...(input.dwell_ms !== undefined ? { dwellMs: input.dwell_ms } : {})
      };
    case 'wait':
      return { type: 'wait', milliseconds: input.wait_ms ?? 800 };
    default:
      throw new Error(`Unsupported computer action: ${input.action}`);
  }
}

type ObserveMode = 'none' | 'tree' | 'screenshot' | 'both';

async function snapshotContent(
  runtime: ComputerUseRuntime,
  window: ComputerWindow,
  options: { includeTree: boolean; includeScreenshot: boolean; interactiveOnly: boolean; maxElements: number }
) {
  const windowId = runtime.windows.issue(window);
  const observationId = runtime.observations.issue(windowId);
  const [inspection, screenshot] = await Promise.all([
    options.includeTree
      ? runtime.backend.inspect(window.hwnd, options.interactiveOnly, options.maxElements)
      : Promise.resolve(undefined),
    options.includeScreenshot
      ? runtime.backend.screenshot(window.hwnd)
      : Promise.resolve(undefined)
  ]);

  const metadata = {
    computer_observation_id: observationId,
    captured_at: new Date().toISOString(),
    window: publicWindow(window, windowId),
    ...(screenshot ? { screenshot: { width: screenshot.width, height: screenshot.height } } : {}),
    ...(inspection ? { elements: inspection.elements } : {})
  };
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: 'image/png' }
  > = [{ type: 'text', text: JSON.stringify(metadata, null, 2) }];
  if (screenshot) {
    content.push({ type: 'image', data: screenshot.data.toString('base64'), mimeType: 'image/png' });
  }
  return { content };
}

async function observeAfter(
  runtime: ComputerUseRuntime,
  window: ComputerWindow,
  mode: ObserveMode
) {
  return snapshotContent(runtime, window, {
    includeTree: mode === 'tree' || mode === 'both',
    includeScreenshot: mode === 'screenshot' || mode === 'both',
    interactiveOnly: true,
    maxElements: 80
  });
}

export function registerComputerUseTools(
  server: McpServer,
  policy: DesktopPolicy,
  audit: AuditLogger,
  runtime: ComputerUseRuntime,
  agentDesktop?: AgentDesktopManager
): void {
  server.registerTool(
    'desktop_ui_windows',
    {
      title: 'List Desktop UI Windows',
      description: 'List Windows desktop windows for semantic computer use. Returns opaque window_id capabilities instead of raw HWND/PID targets. Requires Full Control or Fully Unlocked.',
      inputSchema: z.object({
        app: z.string().min(1).max(256).optional(),
        include_untitled: z.boolean().optional().default(false),
        agent_desktop_lease_id: z.string().uuid().optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ app, include_untitled, agent_desktop_lease_id }) => auditedComputerCall(audit, policy, 'desktop_ui_windows', undefined, async () => {
      let windows = await runtime.coordinator.exclusive(() => runtime.backend.listWindows(app));
      if (agent_desktop_lease_id) {
        if (!agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
        windows = await agentDesktop.filterWindowsForLease(windows, agent_desktop_lease_id);
      }
      const visible = windows
        .filter(window => window.width >= 32 && window.height >= 24)
        .filter(window => !isAgentDesktopSafetyWindow(window))
        .filter(window => include_untitled || Boolean(window.title?.trim()) || window.isForeground)
        .sort((a, b) => Number(b.isForeground) - Number(a.isForeground) || (b.width * b.height) - (a.width * a.height))
        .slice(0, 100)
        .map(window => publicWindow(window, runtime.windows.issue(window)));
      return { content: [{ type: 'text' as const, text: JSON.stringify(visible, null, 2) }] };
    })
  );

  server.registerTool(
    'desktop_ui_snapshot',
    {
      title: 'Snapshot Desktop UI',
      description: 'Capture a target Windows app window with a fresh computer_observation_id. Returns an optional semantic UI Automation tree and PNG screenshot without foregrounding the window. Take a fresh snapshot before every action.',
      inputSchema: z.object({
        window_id: z.string().uuid().optional(),
        app: z.string().min(1).max(256).optional(),
        include_tree: z.boolean().optional().default(true),
        include_screenshot: z.boolean().optional().default(false),
        interactive_only: z.boolean().optional().default(true),
        max_elements: z.number().int().min(1).max(200).optional().default(80),
        agent_desktop_lease_id: z.string().uuid().optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ window_id, app, include_tree, include_screenshot, interactive_only, max_elements, agent_desktop_lease_id }) => auditedComputerCall(
      audit,
      policy,
      'desktop_ui_snapshot',
      window_id ? `window:${window_id}` : undefined,
      async () => runtime.coordinator.exclusive(async () => {
        const all = window_id ? await runtime.backend.listWindows() : await runtime.backend.listWindows(app);
        let candidates = all;
        if (agent_desktop_lease_id) {
          if (!agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
          candidates = await agentDesktop.filterWindowsForLease(all, agent_desktop_lease_id);
        }
        const target = window_id
          ? runtime.windows.resolve(window_id, all)
          : selectForegroundOrSingle(candidates);
        if (isAgentDesktopSafetyWindow(target)) throw new Error('DeskMCP Agent Desktop safety HUD cannot be targeted by Computer Use.');
        if (agent_desktop_lease_id) await agentDesktop!.assertWindowOnLease(target.hwnd, agent_desktop_lease_id);
        const snapshot = await snapshotContent(runtime, target, {
          includeTree: include_tree,
          includeScreenshot: include_screenshot,
          interactiveOnly: interactive_only,
          maxElements: max_elements
        });
        if (agent_desktop_lease_id) await agentDesktop!.assertLease(agent_desktop_lease_id);
        return snapshot;
      })
    )
  );

  server.registerTool(
    'desktop_ui_action',
    {
      title: 'Act on Desktop UI',
      description: 'Perform one globally serialized semantic Windows UI action. Requires a fresh one-time computer_observation_id from desktop_ui_snapshot. In Agent Desktop background mode, only UIA/window-targeted actions are allowed: invoke, set_value, semantic scroll, post-message send_keys, and wait. Physical mouse input, SendInput, wheel injection, drag, and hover return requires_foreground_input instead of stealing the user desktop.',
      inputSchema: z.object({
        window_id: z.string().uuid(),
        computer_observation_id: z.string().uuid(),
        action: z.enum(['invoke', 'set_value', 'click', 'hover', 'scroll', 'send_keys', 'drag', 'wait']),
        selector: z.string().min(1).max(512).optional(),
        value: z.string().max(65536).optional(),
        keys: z.string().max(4096).optional(),
        button: z.enum(['left', 'right']).optional(),
        double: z.boolean().optional().default(false),
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        to: z.enum(['top', 'bottom']).optional(),
        wheel: z.number().int().min(-100).max(100).optional(),
        transport: z.enum(['post-message', 'send-input']).optional(),
        verbatim: z.boolean().optional().default(false),
        allow_system_keys: z.boolean().optional().default(false),
        from: z.string().min(1).max(512).optional(),
        drag_to: z.string().min(1).max(512).optional(),
        hold_ms: z.number().int().min(0).max(5000).optional(),
        dwell_ms: z.number().int().min(0).max(5000).optional(),
        wait_ms: z.number().int().min(0).max(10000).optional(),
        settle_ms: z.number().int().min(0).max(5000).optional().default(150),
        observe_after: z.enum(['none', 'tree', 'screenshot', 'both']).optional().default('tree'),
        agent_desktop_lease_id: z.string().uuid().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async input => auditedComputerCall(audit, policy, 'desktop_ui_action', `window:${input.window_id}`, async () => runtime.coordinator.exclusive(async () => {
      if (input.allow_system_keys && !input.agent_desktop_lease_id && !policy.isFullyUnlocked()) {
        throw new PolicyDeniedError('System-wide key injection requires Fully Unlocked.');
      }

      const parsedAction = parseAction(input);
      const action = input.agent_desktop_lease_id ? prepareAgentDesktopAction(parsedAction) : parsedAction;
      const liveWindows = await runtime.backend.listWindows();
      const target = runtime.windows.resolve(input.window_id, liveWindows);
      if (isAgentDesktopSafetyWindow(target)) throw new Error('DeskMCP Agent Desktop safety HUD cannot be targeted by Computer Use.');
      if (input.agent_desktop_lease_id) {
        if (!agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
        await agentDesktop.assertWindowOnLease(target.hwnd, input.agent_desktop_lease_id);
      }

      runtime.observations.consume(input.computer_observation_id, input.window_id);
      // Invalidate every sibling observation before attempting the action. Even a
      // backend error can be partial, so all clients must re-observe afterward.
      runtime.observations.advance(input.window_id);

      await runtime.backend.act(target.hwnd, action);
      if (input.agent_desktop_lease_id) await agentDesktop!.assertLease(input.agent_desktop_lease_id);
      if (input.settle_ms > 0 && action.type !== 'wait') {
        await new Promise(resolve => setTimeout(resolve, input.settle_ms));
      }

      const refreshedWindows = await runtime.backend.listWindows();
      const refreshed = refreshedWindows.find(window => (
        window.hwnd === target.hwnd &&
        window.processId === target.processId &&
        window.processName === target.processName &&
        (target.className === undefined || window.className === target.className)
      ));
      if (!refreshed) {
        runtime.observations.forgetWindow(input.window_id);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ action: action.type, succeeded: true, window_closed: true }, null, 2)
          }]
        };
      }
      if (input.agent_desktop_lease_id) await agentDesktop!.assertWindowOnLease(refreshed.hwnd, input.agent_desktop_lease_id);
      if (input.observe_after === 'none') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ action: action.type, succeeded: true, observation_required_before_next_action: true }, null, 2)
          }]
        };
      }

      const snapshot = await observeAfter(runtime, refreshed, input.observe_after);
      if (input.agent_desktop_lease_id) await agentDesktop!.assertLease(input.agent_desktop_lease_id);
      const first = snapshot.content[0];
      if (first?.type !== 'text') throw new Error('Computer observation metadata was unavailable.');
      first.text = JSON.stringify({
        action: action.type,
        succeeded: true,
        state: JSON.parse(first.text) as unknown
      }, null, 2);
      return snapshot;
    }))
  );
}
