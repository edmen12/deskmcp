// Passive real virtual Desktop2 app census; absolutely no GUI launch,
// screenshots, UIA providers, window activation or input.
// Does not store or print real window titles, HWNDs, paths or PIDs.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentDesktopNativeBridge} from '../../dist/src/agent-desktop-native.js';
import {AgentDesktopManager} from '../../dist/src/agent-desktop-state.js';
import {resolveDeskMcpStateRoot} from '../../dist/src/data-root.js';

const SAFE_SYSTEM_EXE = new Set([
 'notepad.exe','explorer.exe','mmc.exe','winver.exe','mspaint.exe',
 'regedit.exe','taskmgr.exe','calc.exe'
]);
const MAX_WINDOWS = 100;
const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export async function censusDesktop2({info,status,listVirtualWindows}) {
  const start=await info();
  if(!start || start.virtualDesktopAccessor!==true || start.currentDesktopNumber!==1)
    throw Error('CENSUS_OWNER_NOT_DESKTOP1');
  const authority=await status();
  const targets=authority.bindings?.filter(d=>d.desktopNumber===2)??[];
  if(targets.length!==1 || !Array.isArray(authority.controls)
    || authority.controls.some(c=>c.active && c.desktopNumber===2))
    throw Error('CENSUS_DESKTOP2_BINDING_MISSING_OR_OCCUPIED');
  const desktopId=targets[0].desktopId;
  if(typeof desktopId!=='string')throw Error('CENSUS_INVALID_DESKTOP_ID');
  const data=await listVirtualWindows(desktopId);
  const end=await info();
  const still=await status();
  if(end.currentDesktopNumber!==1 || !end.virtualDesktopAccessor
    ||data.desktopId?.toLowerCase()!==desktopId.toLowerCase()
    ||data.desktopNumber!==2 || data.currentDesktopNumber!==1
    ||!Array.isArray(data.windows)||data.windows.length>MAX_WINDOWS
    ||!Array.isArray(still.controls)
    ||still.controls.some(c=>c.active&&c.desktopNumber===2)
    ||still.bindings?.filter(d=>d.desktopNumber===2).length!==1
    ||still.bindings.find(d=>d.desktopNumber===2)?.desktopId?.toLowerCase()!==desktopId.toLowerCase())
    throw Error('CENSUS_DESKTOP_CHANGED_OR_UNTRUSTED_INVENTORY');
  const seen=new Set();
  const categories=[];
  for(const w of data.windows) {
    if(!Number.isSafeInteger(w.hwnd)||w.hwnd<=0||seen.has(w.hwnd)
      ||!Number.isSafeInteger(w.processId)||w.processId<=0
      ||typeof w.processName!=='string'||typeof w.className!=='string'
      ||w.desktopId?.toLowerCase()!==desktopId.toLowerCase()
      ||w.desktopNumber!==2||w.onCurrentDesktop!==false||w.isForeground!==false)
      throw Error('CENSUS_WINDOW_IDENTITY_MISMATCH');
    seen.add(w.hwnd);
    const name=w.processName.toLowerCase();
    // Only disclose an explicitly allowlisted Windows app category.
    if(SAFE_SYSTEM_EXE.has(name))categories.push(name);
  }
  // A process filename is not proof of Microsoft signing or application
  // identity. This is an inventory, never an action authorization.
  return {pass:true,ownerDesktopBefore:1,ownerDesktopAfter:1,
    totalWindows:data.windows.length,allowlistedProcessNames:categories.sort(),
    signatureVerified:false,authorizedForInput:false};
}

if(isMain) {
  if(process.platform!=='win32')throw Error('CENSUS_REQUIRES_REAL_WINDOWS');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const host=path.join(root,'agent-desktop-host','bin','Release','net10.0-windows',
    'DeskMCP.AgentDesktopHost.exe');
  const native=new AgentDesktopNativeBridge(()=>host);
  const manager=new AgentDesktopManager(resolveDeskMcpStateRoot('agent-desktop'),native);
  // Never initialize the manager: it would mutate production lease state.
  const result=await censusDesktop2({
    info:()=>native.info(),
    status:()=>manager.status(),
    listVirtualWindows:id=>native.listVirtualWindows(id)
  });
  console.log(JSON.stringify(result));
}
