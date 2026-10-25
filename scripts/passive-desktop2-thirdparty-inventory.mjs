// Diagnostic only. Never launches an app, creates a Desktop2 lease,
// targets a window, captures UIA/screenshots, sends input or switches desktop.
// Explicit native host + VDA capability are required. Output redacts HWND,
// PID, titles and all process names outside a small inert system-app allowlist.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentDesktopNativeBridge } from '../dist/src/agent-desktop-native.js';
import { AgentDesktopManager } from '../dist/src/agent-desktop-state.js';
import { resolveDeskMcpStateRoot } from '../dist/src/data-root.js';
import { inspectPassiveDesktop2 } from '../dist/src/computer-use-passive-d2.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = path.join(root, 'agent-desktop-host', 'bin', 'Release', 'net10.0-windows',
  'DeskMCP.AgentDesktopHost.exe');
const vda = process.env.DESKTOP_MCP_VDA_PATH?.trim();
if (process.platform !== 'win32' || process.argv.length !== 2
  || !existsSync(host) || !vda || !path.isAbsolute(vda) || !existsSync(vda)
  || path.basename(vda).toLowerCase() !== 'virtualdesktopaccessor.dll') {
  console.error('PASSIVE_D2_EXPLICIT_NATIVE_HOST_AND_VDA_PATH_REQUIRED');
  process.exit(2);
}
try {
  const native = new AgentDesktopNativeBridge(() => host);
  const manager = new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'), native);
  // Reading status is permitted. NEVER call manager.init(), startControl,
  // moveWindow, or any method that may mutate installed Agent Desktop state.
  const value = await inspectPassiveDesktop2({
    info: () => native.info(),
    status: () => manager.status(),
    listVirtualWindows: desktopId => native.listVirtualWindows(desktopId)
  });
  console.log(JSON.stringify(value));
} catch (error) {
  const message = error instanceof Error ? error.message : 'PASSIVE_D2_UNKNOWN_FAILURE';
  const safe = /^PASSIVE_D2_[A-Z_]+$/.test(message) ? message : 'PASSIVE_D2_BACKEND_UNAVAILABLE';
  console.error(safe);
  process.exitCode = 1;
}
