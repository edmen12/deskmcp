import type { AgentDesktopManager } from './agent-desktop-state.js';
import type { AgentDesktopNativeBridge, AgentDesktopPassiveInventory } from './agent-desktop-native.js';
import type { ComputerWindow } from './computer-use-backend.js';

// Real Windows virtual Desktop2 only. Does not invoke WinApp/UIA, activate
// targets, take screenshots, or issue Computer Use observation tokens.
// A separate verified semantic snapshot must precede any mutating action.
type LeaseAuthority = Pick<AgentDesktopManager, 'assertLease'>;
type InventoryAuthority = Pick<AgentDesktopNativeBridge, 'info' | 'listVirtualWindows'>;

export class Desktop2WindowInventory {
  constructor(
    private readonly leases: LeaseAuthority,
    private readonly native: InventoryAuthority,
    private readonly leaseId: string
  ) {}

  async list(): Promise<readonly ComputerWindow[]> {
    const initial = await this.leases.assertLease(this.leaseId);
    const desktopId = initial.control.desktopId?.toLowerCase();
    if (!initial.control.active || !desktopId
        || initial.control.leaseId?.toLowerCase() !== this.leaseId.toLowerCase()
        || initial.binding.desktopId.toLowerCase() !== desktopId
        || initial.control.desktopNumber !== 2) {
      throw new Error('Passive Desktop2 enumeration requires an active matching HUD-backed lease.');
    }
    const start = await this.native.info();
    if (!start.virtualDesktopAccessor || start.currentDesktopNumber !== 1)
      throw new Error('Passive Desktop2 enumeration requires owner still on Desktop1.');

    const inventory: AgentDesktopPassiveInventory = await this.native.listVirtualWindows(desktopId);
    if (inventory.desktopId.toLowerCase() !== desktopId
        || inventory.desktopNumber !== 2 || inventory.currentDesktopNumber !== 1
        || !Array.isArray(inventory.windows) || inventory.windows.length > 100) {
      throw new Error('Passive Desktop2 native inventory desktop identity is invalid.');
    }
    const handles = new Set<number>();
    const windows: ComputerWindow[] = [];
    for (const item of inventory.windows) {
      if (!Number.isSafeInteger(item.hwnd) || item.hwnd <= 0
          || handles.has(item.hwnd)
          || !Number.isSafeInteger(item.processId) || item.processId <= 0
          || typeof item.processName !== 'string' || item.processName.length < 1
          || item.processName.length > 260
          || typeof item.className !== 'string' || item.className.length < 1
          || item.className.length > 260
          || typeof item.title !== 'string' || item.title.length > 512
          || !Number.isInteger(item.width) || item.width < 32
          || !Number.isInteger(item.height) || item.height < 24
          || item.desktopId.toLowerCase() !== desktopId
          || item.desktopNumber !== 2 || item.onCurrentDesktop !== false
          || item.isForeground !== false) {
        // Unlike a normal search API, a corrupt/mixed desktop batch must
        // abort entirely rather than grant capabilities from a partial set.
        throw new Error('Desktop2 native inventory includes invalid, pinned or untrusted window.');
      }
      if (item.title.startsWith('DeskMCP Agent Desktop'))
        continue;
      handles.add(item.hwnd);
      windows.push({
        hwnd: item.hwnd, processId: item.processId,
        processName: item.processName, title: item.title,
        className: item.className,
        width: item.width, height: item.height, isForeground: false
      });
    }
    const end = await this.native.info();
    const after = await this.leases.assertLease(this.leaseId);
    if (!end.virtualDesktopAccessor || end.currentDesktopNumber !== 1
        || !after.control.active
        || after.control.leaseId?.toLowerCase() !== this.leaseId.toLowerCase()
        || after.control.desktopId?.toLowerCase() !== desktopId
        || after.control.generation !== initial.control.generation) {
      throw new Error('Passive Desktop2 inventory invalidated by owner switch or lease replacement.');
    }
    return windows;
  }
}
