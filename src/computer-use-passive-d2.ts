import type { AgentDesktopNativeInfo, AgentDesktopPassiveInventory } from './agent-desktop-native.js';
import type { AgentDesktopStatus } from './agent-desktop-state.js';

const SAFE_SYSTEM_NAMES = new Set([
  'notepad.exe', 'explorer.exe', 'mmc.exe', 'winver.exe',
  'mspaint.exe', 'regedit.exe', 'taskmgr.exe', 'calc.exe'
]);
const MAX_WINDOWS = 100;

export interface PassiveDesktop2Dependencies {
  readonly info: () => Promise<AgentDesktopNativeInfo>;
  readonly status: () => Promise<Pick<AgentDesktopStatus, 'bindings' | 'controls'>>;
  readonly listVirtualWindows: (desktopId: string) => Promise<AgentDesktopPassiveInventory>;
}

/**
 * Pure, privacy-redacted Desktop2 readiness probe. No GUI launch, focus,
 * input, screenshot or UIA provider invocation. Not an action capability.
 */
export async function inspectPassiveDesktop2(deps: PassiveDesktop2Dependencies) {
  const first = await deps.info();
  if (first.virtualDesktopAccessor !== true || first.currentDesktopNumber == null) {
    throw new Error('PASSIVE_D2_VDA_UNAVAILABLE');
  }
  if (first.currentDesktopNumber !== 1) {
    throw new Error('PASSIVE_D2_OWNER_NOT_DESKTOP1');
  }
  const before = await deps.status();
  if (!Array.isArray(before.bindings) || !Array.isArray(before.controls)) {
    throw new Error('PASSIVE_D2_BINDING_UNAVAILABLE');
  }
  const bindings = before.bindings.filter(row => row.desktopNumber === 2);
  if (bindings.length !== 1 || typeof bindings[0]?.desktopId !== 'string') {
    throw new Error('PASSIVE_D2_BINDING_UNAVAILABLE');
  }
  if (before.controls.some(row => row.active && row.desktopNumber === 2)) {
    throw new Error('PASSIVE_D2_LEASE_OCCUPIED');
  }
  const desktopId = bindings[0].desktopId.toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/u.test(desktopId)) {
    throw new Error('PASSIVE_D2_IDENTITY_UNAVAILABLE');
  }
  const inventory = await deps.listVirtualWindows(desktopId);
  const after = await deps.info();
  const finalStatus = await deps.status();
  if (after.virtualDesktopAccessor !== true
    || after.currentDesktopNumber !== 1
    || inventory.desktopNumber !== 2 || inventory.currentDesktopNumber !== 1
    || inventory.desktopId.toLowerCase() !== desktopId
    || !Array.isArray(inventory.windows) || inventory.windows.length > MAX_WINDOWS
    || !Array.isArray(finalStatus.bindings) || !Array.isArray(finalStatus.controls)
    || finalStatus.bindings.filter(row => row.desktopNumber === 2).length !== 1
    || finalStatus.bindings.find(row => row.desktopNumber === 2)?.desktopId.toLowerCase() !== desktopId
    || finalStatus.controls.some(row => row.active && row.desktopNumber === 2)
  ) {
    throw new Error('PASSIVE_D2_DESKTOP_OR_LEASE_CHANGED');
  }
  const seen = new Set<number>();
  const names: string[] = [];
  for (const window of inventory.windows) {
    if (!Number.isSafeInteger(window.hwnd) || window.hwnd <= 0 || seen.has(window.hwnd)
      || !Number.isSafeInteger(window.processId) || window.processId <= 0
      || typeof window.processName !== 'string' || typeof window.className !== 'string'
      || window.desktopNumber !== 2
      || window.desktopId.toLowerCase() !== desktopId
      || window.onCurrentDesktop !== false || window.isForeground !== false
    ) {
      throw new Error('PASSIVE_D2_WINDOW_IDENTITY_UNVERIFIED');
    }
    seen.add(window.hwnd);
    const processName = window.processName.toLowerCase();
    if (SAFE_SYSTEM_NAMES.has(processName)) names.push(processName);
  }
  return {
    pass: true as const,
    status: inventory.windows.length === 0 ? 'no_candidate_windows' as const : 'passive_windows_found' as const,
    owner_desktop_before: 1 as const,
    owner_desktop_after: 1 as const,
    total_windows: inventory.windows.length,
    allowlisted_process_names: names.sort(),
    signature_verified: false as const,
    authorized_for_input: false as const,
    general_native_compatibility_verified: false as const
  };
}
