import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ComputerWindow } from './computer-use-backend.js';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import { AgentDesktopNativeBridge } from './agent-desktop-native.js';
import { ComputerWindowRegistry, ComputerUseCoordinator } from './computer-use-registry.js';
import { ComputerObservationRegistry } from './computer-use-observation.js';
import { Desktop2WindowInventory } from './desktop2-window-inventory.js';
import { Desktop2ObserverLifecycle } from './desktop2-observer-lifecycle.js';
import { Desktop2DirectUiaLeaseCoordinator, Desktop2DirectUiaProcessInvoker } from './desktop2-direct-uia-lease.js';
import { Desktop2ComputerUseCandidate } from './desktop2-computer-use-candidate.js';
import { Desktop2ComputerUseSession } from './desktop2-computer-use-session.js';
import { RealDesktop2OwnedControl } from './desktop2-real-owned-control.js';

export interface RealD2NativePaths {
  readonly observerExe: string;
  readonly uiaExe: string;
  readonly vdaDll: string;
}
export interface TrustedRealD2OwnedWindow {
  (window: ComputerWindow): Promise<boolean>;
}
// A caller MUST bring an independent owned-launch attestor. No default
// allowlist by process name or title, no caller-supplied HWND or OS PID.
// This is a source-only experiment, NOT a production/server MCP registration.
export function composeRealDesktop2OwnedControl(
  leases: AgentDesktopManager,
  paths: RealD2NativePaths,
  assertTrustedOwnedWindow: TrustedRealD2OwnedWindow,
  native = new AgentDesktopNativeBridge()
): RealDesktop2OwnedControl {
  if (process.platform !== 'win32') throw new Error('REAL_D2_WINDOWS_ONLY');
  for (const [which,file,basename] of [
    ['observer',paths.observerExe,'deskmcp.desktop2switchobserver.exe'],
    ['uia',paths.uiaExe,'deskmcp.desktop2directuia.exe'],
    ['vda',paths.vdaDll,'virtualdesktopaccessor.dll']
  ] as const) {
    if (typeof file !== 'string' || !path.isAbsolute(file) ||
        path.basename(file).toLowerCase() !== basename || !existsSync(file))
      throw new Error('REAL_D2_UNTRUSTED_NATIVE_PATH_' + which);
  }
  if (typeof assertTrustedOwnedWindow !== 'function')
    throw new Error('REAL_D2_OWNED_LAUNCH_ATTESTOR_REQUIRED');
  return new RealDesktop2OwnedControl(leaseId => {
    // Separate one-time capability registries: private-object window IDs and
    // generic desktop_ui_action tokens must never cross this trust boundary.
    const runtime = {
      windows:new ComputerWindowRegistry(),
      observations:new ComputerObservationRegistry(),
      coordinator:new ComputerUseCoordinator()
    };
    const passive = new Desktop2WindowInventory(leases,native,leaseId);
    const observer = new Desktop2ObserverLifecycle(leases,native,
      paths.observerExe,paths.vdaDll);
    const direct = new Desktop2DirectUiaLeaseCoordinator(leases,native,
      new Desktop2DirectUiaProcessInvoker(paths.uiaExe,paths.vdaDll));
    const actions = new Desktop2ComputerUseCandidate(runtime,direct,
      () => passive.list());
    return new Desktop2ComputerUseSession(leaseId,passive,observer,actions);
  },assertTrustedOwnedWindow);
}
