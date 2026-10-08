import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAgentDesktopProcessLaunchScope, requireSupportedProcessPresentation, windowsRelativePathBudget } from '../src/process-tools.js';
import type { AgentDesktopManager } from '../src/agent-desktop-state.js';

test('Windows keeps console visibility independent from privilege elevation', () => {
  assert.doesNotThrow(() => requireSupportedProcessPresentation('hidden', 'standard', 'win32'));
  assert.doesNotThrow(() => requireSupportedProcessPresentation('visible', 'standard', 'win32'));
  assert.doesNotThrow(() => requireSupportedProcessPresentation('hidden', 'admin', 'win32'));
  assert.doesNotThrow(() => requireSupportedProcessPresentation('visible', 'admin', 'win32'));
});

test('non-Windows platforms still reject visible console and admin elevation modes', () => {
  assert.doesNotThrow(() => requireSupportedProcessPresentation('hidden', 'standard', 'darwin'));
  assert.throws(
    () => requireSupportedProcessPresentation('visible', 'standard', 'darwin'),
    /supported on Windows only/
  );
  assert.throws(
    () => requireSupportedProcessPresentation('hidden', 'admin', 'darwin'),
    /supported on Windows only/
  );
});

test('Windows legacy path budget reports remaining relative headroom', () => {
  assert.equal(windowsRelativePathBudget('C:\\work'), 251);
  assert.equal(windowsRelativePathBudget('C:\\Users\\User\\Desktop\\DeskMCP'), 229);
});

test('Agent Desktop blocks every unscoped process launch while a control lease is active', async () => {
  const active = { hasActiveControls: async () => true } as unknown as AgentDesktopManager;
  const idle = { hasActiveControls: async () => false } as unknown as AgentDesktopManager;
  await assert.rejects(
    assertAgentDesktopProcessLaunchScope(active, undefined),
    /requires its agent_desktop_lease_id/i
  );
  await assert.doesNotReject(
    assertAgentDesktopProcessLaunchScope(active, '11111111-1111-4111-8111-111111111111')
  );
  await assert.doesNotReject(assertAgentDesktopProcessLaunchScope(idle, undefined));
  await assert.doesNotReject(assertAgentDesktopProcessLaunchScope(undefined, undefined));
});
