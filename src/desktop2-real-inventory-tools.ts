import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { DesktopPolicy } from './desktop-policy.js';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import type { AgentDesktopNativeBridge } from './agent-desktop-native.js';
import { Desktop2WindowInventory } from './desktop2-window-inventory.js';

type LeaseCheck = Pick<AgentDesktopManager, 'assertLease'>;
type NativeRead = Pick<AgentDesktopNativeBridge, 'info' | 'listVirtualWindows'>;

// PRIVATE Win32 Desktop Object windows MUST NEVER be mixed into this result.
// Deliberately does not issue legacy ComputerWindowRegistry IDs, raw HWND/PID,
// action authorization tokens, or perform UIA/WinApp provider calls.
export async function readRealVirtualDesktop2Windows(
  lease: LeaseCheck,
  native: NativeRead,
  leaseId: string,
  includeTitles = false
) {
  const source = new Desktop2WindowInventory(lease, native, leaseId);
  const windows = await source.list();
  return {
    source: 'windows-virtual-desktop-2-vda' as const,
    desktop_number: 2 as const,
    is_private_win32_desktop_object: false as const,
    actionable: false as const,
    count: windows.length,
    windows: windows.map(window => ({
      app: window.processName,
      class_name: window.className ?? '',
      ...(includeTitles ? {title: window.title ?? ''} : {}),
      width: window.width,
      height: window.height,
      foreground: false as const
    }))
  };
}

export function registerRealVirtualDesktop2InventoryTool(
  server: McpServer,
  policy: DesktopPolicy,
  leases: LeaseCheck,
  native: NativeRead
): void {
  server.registerTool('desktop2_real_windows_readonly', {
    title: 'Read Real Windows Virtual Desktop 2 Windows (experimental)',
    description: 'Read ONLY actual Win+Tab Windows virtual Desktop 2 windows through native VDA with a live HUD lease and owner remaining on Desktop 1. NOT the private Win32 Desktop Object used by desktop_ui_windows(agent_desktop_lease_id). No click, input, screenshot, window_id/action capability, or launch. Source-only staged experiment; no production mutation.',
    inputSchema: z.object({
      agent_desktop_lease_id: z.string().uuid(),
      include_titles: z.boolean().optional().default(false)
    }),
    annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  }, async ({agent_desktop_lease_id,include_titles}) => {
    try {
      policy.assertCanUseComputer();
      const result=await readRealVirtualDesktop2Windows(
        leases,native,agent_desktop_lease_id,include_titles);
      return {content:[{type:'text' as const,text:JSON.stringify(result,null,2)}]};
    } catch(error) {
      return {content:[{type:'text' as const,text:'Real virtual Desktop2 read denied: '+
        (error instanceof Error?error.message:String(error))}],isError:true as const};
    }
  });
}
