/**
 * REAL candidate BrowserRuntime integration probe; source-only, never installed.
 * Starts a bounded Agent Desktop2 lease and a dedicated Chrome profile, and
 * attempts BrowserRuntime.start({headless:false}) with strict placement checks.
 * Guaranteed cleanup in finally: only this lease/browser/HTTP server/bridge.
 */
import {createServer} from 'node:http';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {AgentDesktopManager} from '../dist/src/agent-desktop-state.js';
import {AgentDesktopNativeBridge} from '../dist/src/agent-desktop-native.js';
import {BrowserRuntime, OwnedBrowserProcessController} from '../dist/src/browser-runtime.js';
import {ArtifactStore} from '../dist/src/artifact-store.js';
import {DesktopBackendBridge} from '../dist/src/desktop-backend-bridge.js';
import {ProcessSessionRegistry} from '../dist/src/process-session-registry.js';
import {resolveDeskMcpStateRoot} from '../dist/src/data-root.js';

process.env.DESKTOP_MCP_VDA_PATH=path.join(process.cwd(),'runtime','agent-desktop-runtime','win-x64','virtual-desktop-accessor','VirtualDesktopAccessor.dll');
const stateDir=resolveDeskMcpStateRoot('agent-desktop');
const chrome=String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const temp=await mkdtemp(path.join(os.tmpdir(),'deskmcp-runtime-d2-e2e-'));
const native=path.join(process.env.LOCALAPPDATA,'Programs','DesktopMCP','DeskMCP.AgentDesktopHost.exe');
const desktop=()=>JSON.parse(execFileSync(native,['current-desktop'],{encoding:'utf8',timeout:9000,windowsHide:true}).trim());
const monitor=()=>{const p=desktop();if(p.desktopNumber!==1)throw new Error('USER_ACTIVE_DESKTOP_NOT_1: '+JSON.stringify(p));return p;};
const pageHtml=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>DeskMCP candidate Desktop2 integration</title></head><body>
<div id="source">AGENT_RUNTIME_中文</div>
<input id="entry" aria-label="Test entry" />
<button id="send" onclick="document.querySelector('#result').textContent='DONE:'+document.querySelector('#entry').value">Submit</button>
<button id="popup" onclick="window.open('/popup','agent_popup','width=450,height=330')">Open Popup</button>
<div id="result">PENDING</div>
</body></html>`;
const http=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url==='/popup'?'<html><body><h1>SECOND_POPUP_DESKTOP2_OK</h1></body></html>':pageHtml);});
let lease;
let runtime;
let bridge;
let stopped=false;
let initialized=false;
const snap=async(sid,pid)=>runtime.snapshot(sid,pid,{screenshot:false});
const act=async(sid,pid,action)=>{
 const observation=await snap(sid,pid);
 return runtime.act(sid,pid,observation.browser_observation_id,[action],{screenshot:false});
};
try{
  console.log('PRE_CURRENT='+JSON.stringify(monitor()));
  const agent=new AgentDesktopManager(stateDir,new AgentDesktopNativeBridge());
  await agent.init();
  const status=await agent.status();
  if(status.controls?.length)throw Error('AGENT_DESKTOP_POOL_NOT_FREE');
  const started=await agent.startControl('Source-only Desktop2 BrowserRuntime trial',undefined,2);
  lease=started.control?.leaseId;
  if(!lease)throw Error('SOURCE_TRIAL_NO_LEASE');
  console.log('LEASE_ACQUIRED_DESKTOP2=true');
  console.log('AFTER_LEASE_CURRENT='+JSON.stringify(monitor()));
  try{
    await new Promise((resolve,reject)=>http.listen(0,'127.0.0.1',err=>err?reject(err):resolve()));
    const port=http.address().port;
    await mkdir(path.join(temp,'artifacts'),{recursive:true});
    const artifacts=new ArtifactStore(path.join(temp,'artifacts'));await artifacts.init();
    bridge=new DesktopBackendBridge();
    const processRegistry=new ProcessSessionRegistry();
    runtime=new BrowserRuntime(
      path.join(temp,'browser'),
      new OwnedBrowserProcessController(bridge,processRegistry,agent),
      artifacts,undefined,chrome,agent,30000,true
    );
    await runtime.init();initialized=true;
    console.log('RUNTIME_START_HEADFUL_ATTEMPT=true');
    const browser=await runtime.start({agent_desktop_lease_id:lease,headless:false,
      url:'http://127.0.0.1:'+port+'/',timeout_ms:25000});
    console.log('RUNTIME_STARTED='+JSON.stringify({session:browser.session_id,headless:browser.headless,pages:browser.pages.length}));
    if(browser.headless)throw Error('SOURCE_RUNTIME_FELL_BACK_TO_HEADLESS');
    monitor();
    await act(browser.session_id,browser.page_id,{type:'virtual_copy',selector:'#source'});
    await act(browser.session_id,browser.page_id,{type:'virtual_paste',selector:'#entry'});
    const pasted=await snap(browser.session_id,browser.page_id);
    if(!pasted.text.includes('AGENT_RUNTIME_中文'))throw Error('BROWSER_SNAPSHOT_CANNOT_READ_INSERTED_TEXT');
    await act(browser.session_id,browser.page_id,{type:'click',selector:'#send'});
    const clicked=await snap(browser.session_id,browser.page_id);
    if(!clicked.text.includes('DONE:AGENT_RUNTIME_中文'))throw Error('RUNTIME_CLICK_OR_CLIPBOARD_FAILED');
    console.log('RUNTIME_CLIPBOARD_AND_BUTTON_PASS=true');
    monitor();
    await act(browser.session_id,browser.page_id,{type:'click',selector:'#popup'});
    const popup=await snap(browser.session_id,browser.page_id);
    console.log('RUNTIME_POPUP_PAGE_COUNT='+popup.pages.length);
    if(popup.pages.length<2)throw Error('REAL_BROWSER_POPUP_NOT_CAPTURED');
    monitor();
    const closed=await runtime.close(browser.session_id);
    if(!closed.closed)throw Error('OWNED_BROWSER_NOT_CLOSED');
    console.log('RUNTIME_CLOSE_OWNED_BROWSER_PASS=true');
  } finally {
    if(runtime)await runtime.closeAll().catch(e=>console.log('CLOSE_ALL_ERROR='+String(e.message)));
    if(bridge)await bridge.close().catch(e=>console.log('BRIDGE_CLOSE_ERROR='+String(e.message)));
    if(http.listening)await new Promise(resolve=>http.close(resolve));
  }
  console.log('INTEGRATED_RUNTIME_DESKTOP2_PASS=true');
} catch(e){
 console.log('INTEGRATED_RUNTIME_TEST_FAILED='+String(e.stack||e).slice(0,3500));
 process.exitCode=2;
} finally {
 // The Agent lease is exclusively created by this probe. Never stop another
 // owner's lease, even on failure.
 if(lease) {
  try{const agent=new AgentDesktopManager(stateDir,new AgentDesktopNativeBridge());await agent.init();await agent.stopControl(lease);stopped=true;}
  catch(e){console.log('OWNED_LEASE_CLEANUP_FAILED='+String(e.message));}
 }
 if(http.listening) await new Promise(resolve=>http.close(resolve));
 await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
 console.log('OWNED_LEASE_STOPPED='+stopped);
 console.log('POST_CURRENT='+JSON.stringify(desktop()));
}
