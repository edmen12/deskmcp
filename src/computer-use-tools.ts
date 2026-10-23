import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import type { ComputerWindow, UiAction, UiElementSummary } from './computer-use-backend.js';
import type { ComputerUseRuntime } from './computer-use-runtime.js';
import { diffUiSnapshots, waitForUiCondition, type WaitCondition } from './computer-use-read-model.js';

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
    case 'wait':
    case 'invoke':
    case 'set_value':
      return action;
    case 'scroll':
      if (action.wheel !== undefined) {
        throw new RequiresForegroundInputError('mouse-wheel injection is disabled in Agent Desktop isolated-desktop mode because global wheel delivery has not yet been proven to stay off the user input desktop.');
      }
      return action;
    case 'send_keys':
      throw new RequiresForegroundInputError('keyboard injection is disabled in Agent Desktop isolated-desktop mode until a transport is proven not to target the user input desktop.');
    case 'click':
      throw new RequiresForegroundInputError('physical mouse click is disabled in Agent Desktop isolated-desktop mode. Use invoke when the control exposes an invoke pattern.');
    case 'hover':
      throw new RequiresForegroundInputError('physical mouse hover is disabled in Agent Desktop isolated-desktop mode.');
    case 'drag':
      throw new RequiresForegroundInputError('physical drag is disabled in Agent Desktop isolated-desktop mode.');
  }
}

function usesGlobalDesktopInput(action: UiAction): boolean {
  switch (action.type) {
    case 'click':
    case 'hover':
    case 'drag':
      return true;
    case 'scroll':
      return action.wheel !== undefined;
    case 'send_keys':
      return action.transport !== 'post-message';
    default:
      return false;
  }
}

function isAgentDesktopSafetyWindow(window: ComputerWindow): boolean {
  return window.title?.startsWith('DeskMCP Agent Desktop') === true;
}

export async function resolveAgentDesktopWindowLease(
  agentDesktop: AgentDesktopManager | undefined,
  hwnd: number,
  requestedLeaseId?: string
): Promise<string | undefined> {
  if (requestedLeaseId) return requestedLeaseId;
  return agentDesktop ? agentDesktop.activeLeaseForWindow(hwnd) : undefined;
}

export async function assertUnscopedUserDesktopActionAllowed(
  agentDesktop: AgentDesktopManager | undefined,
  effectiveAgentDesktopLeaseId: string | undefined,
  allowUserDesktop: boolean
): Promise<void> {
  if (
    !effectiveAgentDesktopLeaseId &&
    agentDesktop &&
    !allowUserDesktop &&
    await agentDesktop.hasActiveControls()
  ) {
    throw new PolicyDeniedError(
      'Unscoped user-desktop actions are blocked while Agent Desktop control is active. ' +
      'Pass allow_user_desktop=true only for intentional control of Desktop 1.'
    );
  }
}

export function agentDesktopSemanticTreeWarning(
  window: ComputerWindow,
  elements: readonly UiElementSummary[]
): string | undefined {
  if (!window.className?.startsWith('WindowsForms10.')) return undefined;
  const hasWinFormsDescendant = elements.some(element =>
    element.type !== 'Window' && element.className?.startsWith('WindowsForms10.') === true
  );
  if (hasWinFormsDescendant) return undefined;
  return 'semantic_tree_limited: Windows Forms child controls are not exposed by Windows UI Automation while this window is isolated on a non-current Agent Desktop. Do not treat the returned elements as a complete tree; semantic actions may be unavailable.';
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
    case 'wait_for':
      if (!input.selector) throw new Error('wait_for requires selector.');
      return { type: 'wait', milliseconds: 0 };
    default:
      throw new Error(`Unsupported computer action: ${input.action}`);
  }
}

type ObserveMode = 'none' | 'tree' | 'screenshot' | 'both';

/** Legacy succeeded=true only acknowledges the backend call; it never proves an app outcome. */
export function computerActionDispatchResult(
  action: UiAction['type'],
  postActionState: 'not_observed' | 'window_closed' | 'snapshot_available' | 'observation_unavailable'
) {
  return {
    action,
    succeeded: true,
    action_dispatched: action !== 'wait',
    outcome_verified: false,
    outcome_status: 'unverified' as const,
    post_action_state: postActionState,
    requires_outcome_check: action !== 'wait'
  };
}

async function snapshotContent(
  runtime: ComputerUseRuntime,
  window: ComputerWindow,
  options: { includeTree: boolean; includeScreenshot: boolean; interactiveOnly: boolean; maxElements: number; agentDesktopLeaseId?: string; desktopObjectName?: string; diffFromObservationId?: string; diffOnly?: boolean }
) {
  const windowId = runtime.windows.issue(window);
  if (options.diffFromObservationId && !options.includeTree) throw new Error('UI diff requires include_tree=true.');
  if (options.diffOnly && !options.diffFromObservationId) throw new Error('diff_only requires diff_from_observation_id.');
  const baseline = options.diffFromObservationId
    ? runtime.snapshots.get(options.diffFromObservationId, windowId, options.agentDesktopLeaseId)
    : undefined;
  if (baseline && (baseline.maxElements !== options.maxElements || baseline.interactiveOnly !== options.interactiveOnly)) {
    throw new Error('UI diff requires the same max_elements and interactive_only as the baseline.');
  }
  const [inspection, screenshot] = await Promise.all([
    options.includeTree
      ? runtime.backend.inspect(window.hwnd, options.interactiveOnly, options.maxElements, options.desktopObjectName)
      : Promise.resolve(undefined),
    options.includeScreenshot
      ? runtime.backend.screenshot(window.hwnd, {}, options.desktopObjectName)
      : Promise.resolve(undefined)
  ]);

  const observationId = runtime.observations.issue(windowId, Date.now(), options.agentDesktopLeaseId);
  const current = inspection ? {
    windowId, ...(options.agentDesktopLeaseId ? { leaseId: options.agentDesktopLeaseId } : {}), capturedAt: Date.now(),
    elements: inspection.elements, truncated: inspection.elementsTruncated === true,
    maxElements: options.maxElements, interactiveOnly: options.interactiveOnly
  } : undefined;
  if (current) runtime.snapshots.add(observationId, current);
  const uiDiff = baseline && current ? diffUiSnapshots(baseline, current) : undefined;
  const agentDesktopWarning = options.agentDesktopLeaseId && inspection
    ? agentDesktopSemanticTreeWarning(window, inspection.elements)
    : undefined;
  const truncationWarning = inspection?.elementsTruncated
    ? `semantic_tree_truncated: DeskMCP returned at most ${options.maxElements} controls from WinApp's depth-limited result; omitted controls must not be treated as absent. Increase max_elements (up to 200) or narrow the target.`
    : undefined;
  const semanticTreeWarning = [agentDesktopWarning, truncationWarning].filter(Boolean).join(' ');
  const metadata = {
    computer_observation_id: observationId,
    captured_at: new Date().toISOString(),
    window: publicWindow(window, windowId),
    ...(screenshot ? { screenshot: { width: screenshot.width, height: screenshot.height } } : {}),
    ...(inspection ? {
      ...(!options.diffOnly ? { elements: inspection.elements } : {}),
      ...(uiDiff ? { ui_diff: uiDiff, diff_from_observation_id: options.diffFromObservationId } : {}),
      semantic_tree_truncated: inspection.elementsTruncated === true,
      semantic_tree_scope: 'winapp_depth_and_filter_limited'
    } : {}),
    ...(semanticTreeWarning ? {
      semantic_tree_status: 'limited',
      semantic_tree_warning: semanticTreeWarning
    } : {})
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
  mode: ObserveMode,
  agentDesktopLeaseId?: string,
  desktopObjectName?: string
) {
  return snapshotContent(runtime, window, {
    includeTree: mode === 'tree' || mode === 'both',
    includeScreenshot: mode === 'screenshot' || mode === 'both',
    interactiveOnly: true,
    maxElements: 80,
    ...(agentDesktopLeaseId ? { agentDesktopLeaseId } : {}),
    ...(desktopObjectName ? { desktopObjectName } : {})
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
      if (agent_desktop_lease_id && !agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
      const windows = await runtime.coordinator.exclusive(() => runtime.backend.listWindows(app));
      // A Windows virtual desktop is NOT an isolated Win32 Desktop object.
      // The caller's lease is enforced by verified window desktop GUIDs.
      const scopedWindows = agent_desktop_lease_id
        ? await agentDesktop!.filterWindowsForLease(windows, agent_desktop_lease_id)
        : windows;
      const visible = scopedWindows
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
        diff_from_observation_id: z.string().uuid().optional(),
        diff_only: z.boolean().optional().default(false),
        agent_desktop_lease_id: z.string().uuid().optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ window_id, app, include_tree, include_screenshot, interactive_only, max_elements, diff_from_observation_id, diff_only, agent_desktop_lease_id }) => auditedComputerCall(
      audit,
      policy,
      'desktop_ui_snapshot',
      window_id ? `window:${window_id}` : undefined,
      async () => runtime.coordinator.exclusive(async () => {
        if (agent_desktop_lease_id) {
          if (!agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
          await agentDesktop.assertLease(agent_desktop_lease_id);
        }
        const all = window_id
          ? await runtime.backend.listWindows()
          : await runtime.backend.listWindows(app);
        const scopedWindows = agent_desktop_lease_id
          ? await agentDesktop!.filterWindowsForLease(all, agent_desktop_lease_id)
          : all;
        const target = window_id
          ? runtime.windows.resolve(window_id, scopedWindows)
          : selectForegroundOrSingle(scopedWindows);
        if (isAgentDesktopSafetyWindow(target)) throw new Error('DeskMCP Agent Desktop safety HUD cannot be targeted by Computer Use.');
        const effectiveAgentDesktopLeaseId = await resolveAgentDesktopWindowLease(
          agentDesktop,
          target.hwnd,
          agent_desktop_lease_id
        );
        if (effectiveAgentDesktopLeaseId) {
          if (!agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
          if (agent_desktop_lease_id) await agentDesktop.assertLease(effectiveAgentDesktopLeaseId);
          else await agentDesktop.assertWindowOnLease(target.hwnd, effectiveAgentDesktopLeaseId);
        }
        const snapshot = await snapshotContent(runtime, target, {
          includeTree: include_tree,
          includeScreenshot: include_screenshot,
          interactiveOnly: interactive_only,
          maxElements: max_elements,
          ...(diff_from_observation_id ? { diffFromObservationId: diff_from_observation_id } : {}),
          diffOnly: diff_only,
          ...(effectiveAgentDesktopLeaseId ? { agentDesktopLeaseId: effectiveAgentDesktopLeaseId } : {})
        });
        if (effectiveAgentDesktopLeaseId) await agentDesktop!.assertWindowOnLease(target.hwnd, effectiveAgentDesktopLeaseId);
        return snapshot;
      })
    )
  );

  server.registerTool(
    'desktop_ui_action',
    {
      title: 'Act on Desktop UI',
      description: 'Perform one globally serialized semantic Windows UI action. Requires a fresh one-time computer_observation_id from desktop_ui_snapshot. Agent Desktop Computer Use targets windows by their verified Windows virtual-desktop GUID (not by a separate Win32 desktop object), and the observation retains its lease even if the caller omits agent_desktop_lease_id on the following action. In isolated mode, invoke, set_value, semantic direction/to scroll, and wait are allowed. Physical click, hover, drag, wheel injection, and keyboard injection remain fail-closed until those global-input paths are proven not to target the user input desktop. While any Agent Desktop lease is active, unscoped user-desktop actions require allow_user_desktop=true.',
      inputSchema: z.object({
        window_id: z.string().uuid(),
        computer_observation_id: z.string().uuid(),
        action: z.enum(['invoke', 'set_value', 'click', 'hover', 'scroll', 'send_keys', 'drag', 'wait', 'wait_for']),
        selector: z.string().min(1).max(512).optional(),
        value: z.string().max(65536).optional(),
        keys: z.string().max(4096).optional(),
        button: z.enum(['left', 'right']).optional(),
        double: z.boolean().optional().default(false),
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        to: z.enum(['top', 'bottom']).optional(),
        wheel: z.number().int().min(-100).max(100).optional(),
        transport: z.literal('send-input').optional().describe('Remote callers may request normal SendInput only. DeskMCP may select a restricted window-targeted transport internally for Agent Desktop background mode.'),
        verbatim: z.boolean().optional().default(false),
        allow_system_keys: z.boolean().optional().default(false),
        allow_user_desktop: z.boolean().optional().default(false).describe('Explicitly allow an unscoped action on the normal user desktop while an Agent Desktop lease is active.'),
        from: z.string().min(1).max(512).optional(),
        drag_to: z.string().min(1).max(512).optional(),
        hold_ms: z.number().int().min(0).max(5000).optional(),
        dwell_ms: z.number().int().min(0).max(5000).optional(),
        wait_ms: z.number().int().min(0).max(10000).optional(),
        wait_condition: z.enum(['present', 'enabled', 'value_equals']).optional().default('present'),
        expected_value: z.string().max(65536).optional(),
        poll_ms: z.number().int().min(100).max(1000).optional().default(250),
        settle_ms: z.number().int().min(0).max(5000).optional().default(150),
        observe_after: z.enum(['none', 'tree', 'screenshot', 'both']).optional().default('tree'),
        agent_desktop_lease_id: z.string().uuid().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async input => auditedComputerCall(audit, policy, 'desktop_ui_action', `window:${input.window_id}`, async () => runtime.coordinator.exclusive(async () => {
      const parsedAction = parseAction(input);
      const observationLeaseHint = runtime.observations.peekLease(
        input.computer_observation_id,
        input.window_id,
        Date.now()
      );
      const scopedLeaseId = input.agent_desktop_lease_id ?? observationLeaseHint;
      if (scopedLeaseId) {
        if (!agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
        await agentDesktop.assertLease(scopedLeaseId);
      }

      const liveWindows = await runtime.backend.listWindows();
      const scopedWindows = scopedLeaseId
        ? await agentDesktop!.filterWindowsForLease(liveWindows, scopedLeaseId)
        : liveWindows;
      const target = runtime.windows.resolve(input.window_id, scopedWindows);
      if (isAgentDesktopSafetyWindow(target)) throw new Error('DeskMCP Agent Desktop safety HUD cannot be targeted by Computer Use.');

      const requestedAgentDesktopLeaseId = scopedLeaseId ?? await resolveAgentDesktopWindowLease(
        agentDesktop,
        target.hwnd
      );
      const observationLeaseId = runtime.observations.consume(
        input.computer_observation_id,
        input.window_id,
        Date.now(),
        requestedAgentDesktopLeaseId
      );
      const effectiveAgentDesktopLeaseId = observationLeaseId ?? requestedAgentDesktopLeaseId;
      await assertUnscopedUserDesktopActionAllowed(
        agentDesktop,
        effectiveAgentDesktopLeaseId,
        input.allow_user_desktop
      );
      if (input.allow_system_keys && !effectiveAgentDesktopLeaseId && !policy.isFullyUnlocked()) {
        throw new PolicyDeniedError('System-wide key injection requires Fully Unlocked.');
      }
      const action = effectiveAgentDesktopLeaseId ? prepareAgentDesktopAction(parsedAction) : parsedAction;
      if (effectiveAgentDesktopLeaseId) {
        if (!agentDesktop) throw new Error('Agent Desktop runtime is unavailable.');
        await agentDesktop.assertWindowOnLease(target.hwnd, effectiveAgentDesktopLeaseId);
      }

      if (input.action === 'wait_for') {
        // This is an observational poll, not global input. Retain sibling observations,
        // but revalidate window identity and exact lease around every UIA inspection.
        const verifyTarget = async () => {
          const live = await runtime.backend.listWindows();
          runtime.windows.resolve(input.window_id, live);
          if (effectiveAgentDesktopLeaseId) {
            await agentDesktop!.assertWindowOnLease(target.hwnd, effectiveAgentDesktopLeaseId);
          }
        };
        const result = await waitForUiCondition(
          () => runtime.backend.inspect(target.hwnd, true, 200),
          verifyTarget,
          input.selector!,
          input.wait_condition as WaitCondition,
          input.expected_value,
          input.wait_ms ?? 5000,
          input.poll_ms
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          action: 'wait_for',
          succeeded: result.condition_met,
          check_completed: true,
          action_dispatched: false,
          condition: input.wait_condition,
          condition_met: result.condition_met,
          outcome_verified: result.condition_met,
          outcome_status: result.condition_met ? 'condition_verified' : 'timeout_inconclusive',
          selector: input.selector,
          attempts: result.attempts,
          timed_out: result.timed_out,
          semantic_tree_truncated: result.last_inspection_truncated,
          semantic_tree_scope: 'winapp_depth_and_filter_limited',
          observation_required_before_next_action: true
        }, null, 2) }] };
      }

      // Invalidate every sibling observation before attempting the action. Even a
      // backend error can be partial, so all clients must re-observe afterward.
      runtime.observations.advance(input.window_id, usesGlobalDesktopInput(action));

      await runtime.backend.act(target.hwnd, action);
      if (effectiveAgentDesktopLeaseId) await agentDesktop!.assertLease(effectiveAgentDesktopLeaseId);
      if (input.settle_ms > 0 && action.type !== 'wait') {
        await new Promise(resolve => setTimeout(resolve, input.settle_ms));
      }

      // The backend may have already delivered a non-idempotent click even if a later
      // observation fails. Do not misreport that as a safe-to-retry action failure.
      let refreshedWindows: ComputerWindow[];
      try {
        refreshedWindows = await runtime.backend.listWindows();
      } catch {
        if (effectiveAgentDesktopLeaseId) await agentDesktop!.assertLease(effectiveAgentDesktopLeaseId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ...computerActionDispatchResult(action.type, 'observation_unavailable'),
            post_action_warning: 'Post-action window listing was unavailable. Inspect current app state before considering a retry.'
          }, null, 2) }]
        };
      }
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
            text: JSON.stringify({ ...computerActionDispatchResult(action.type, 'window_closed'), window_closed: true }, null, 2)
          }]
        };
      }
      if (effectiveAgentDesktopLeaseId) {
        await agentDesktop!.assertWindowOnLease(refreshed.hwnd, effectiveAgentDesktopLeaseId);
      }
      if (input.observe_after === 'none') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ...computerActionDispatchResult(action.type, 'not_observed'), observation_required_before_next_action: true }, null, 2)
          }]
        };
      }

      let snapshot;
      try {
        snapshot = await observeAfter(
          runtime,
          refreshed,
          input.observe_after,
          effectiveAgentDesktopLeaseId
        );
      } catch {
        if (effectiveAgentDesktopLeaseId) await agentDesktop!.assertWindowOnLease(target.hwnd, effectiveAgentDesktopLeaseId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ...computerActionDispatchResult(action.type, 'observation_unavailable'),
            post_action_warning: 'Post-action snapshot was unavailable. Observe the app before deciding whether to retry.'
          }, null, 2) }]
        };
      }
      if (effectiveAgentDesktopLeaseId) await agentDesktop!.assertLease(effectiveAgentDesktopLeaseId);
      const first = snapshot.content[0];
      if (first?.type !== 'text') throw new Error('Computer observation metadata was unavailable.');
      first.text = JSON.stringify({
        ...computerActionDispatchResult(action.type, 'snapshot_available'),
        state: JSON.parse(first.text) as unknown
      }, null, 2);
      return snapshot;
    }))
  );
}
