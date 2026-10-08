// Manual candidate E2E: visible Chrome in real Windows Desktop2 while Desktop1 remains active.
// Separate temporary Chrome profile; never touches existing users' browser sessions.
// Run with: node test-area/desktop2-chrome-e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { PlaywrightBrowserDriver } from '../dist/src/browser-playwright.js';
import { AgentClipboardStore } from '../dist/src/desktop2-clipboard.js';

const root=process.cwd();
const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const native=path.join(process.env.LOCALAPPDATA,'Programs','DesktopMCP','DeskMCP.AgentDesktopHost.exe');
const runDir=path.join(root,'test-area','desktop2-chrome-'+randomUUID().slice(0,8));
const profile=path.join(runDir,'profile');
const htmlPath=path.join(runDir,'test.html');
const resultPath=path.join(runDir,'result.json');
const screenshotPath=path.join(runDir,'chrome-desktop2.png');
const until=(ms)=>new Promise(r=>setTimeout(r,ms));
const host=(...args)=>JSON.parse(execFileSync(native,args,{encoding:'utf8',timeout:16000,windowsHide:true}).trim());
const show=(k,obj)=>console.log(k+'='+JSON.stringify(obj));
let chromeProcess;
let browser;
let profileCreated=false;
let beforeVirtualDesktop;
let targetDesktop;

async function waitFor(predicate,ms,name){
 const deadline=Date.now()+ms;
 while(Date.now()<deadline){
  // Chromium may hand off startup to a second browser process and its
  // initial launcher exits 0. The unique profile + live CDP port establish
  // session identity; a launcher exit alone is not proof of browser exit.
  const v=await predicate();
  if(v)return v;
  await until(150);
 }
 throw Error('Timeout: '+name);
}

function ownedChromeMainPids(){
 if(!profileCreated)return [];
 // Only browser root processes with this exact newly generated temporary
 // profile, not user Chrome and not other renderer/crashpad processes.
 const escaped=profile.replaceAll("'","''");
 const ps = `$dir='${escaped}'; Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$dir*" -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }`;
 try{
   const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',timeout:7000,windowsHide:true});
   return [...new Set(raw.trim().split(/\s+/u).map(Number).filter(n=>Number.isInteger(n)&&n>0))];
 }catch{return [];}
}

function onlyOurChromeCleanup(){
 const ids=ownedChromeMainPids();
 for(const pid of ids){
   try{
     execFileSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{timeout:9000,windowsHide:true,stdio:'ignore'});
     console.log('OWNED_CHROME_TREE_CLEANED_PID='+pid);
   }catch(error){
     console.log('OWNED_CHROME_TREE_CLEANUP_ERROR='+String(error.message).slice(0,180));
   }
 }
 if(ids.length===0)console.log('OWNED_CHROME_TREE_ABSENT=true');
}

try {
 if(!existsSync(chrome)||!existsSync(native))throw Error('Chrome or installed DesktopMCP native window helper missing.');
 beforeVirtualDesktop=host('current-desktop');
 targetDesktop=host('desktop-info','--desktop-number','2');
 show('BEFORE_DESKTOP',beforeVirtualDesktop);
 show('TARGET_DESKTOP',targetDesktop);
 if(beforeVirtualDesktop.desktopNumber!==1||targetDesktop.desktopNumber!==2||targetDesktop.currentDesktopNumber!==1)throw Error('Baseline must have user on Desktop1 and real Desktop2 available.');
 mkdirSync(profile,{recursive:true});profileCreated=true;
 const html=`<!DOCTYPE html>
 <html><head><meta charset="utf-8"><title>DeskMCP Desktop2 Chrome probe</title>
 <style>body{font:20px sans-serif;padding:30px;height:1500px;background:#e9f0fc}
 #source,#target{margin-top:20px;padding:20px;border:2px solid #567;display:inline-block;min-width:90px}
 #target{background:#fdf7c7}#bottom{position:absolute;top:1150px}</style></head>
 <body><label>Agent input <input id="entry" aria-label="Agent input"></label>
 <button id="submit" onclick="document.querySelector('#result').textContent='CLICKED:'+document.querySelector('#entry').value">Submit</button>
 <div id="result" role="status">PENDING</div>
 <button id="dbl" ondblclick="document.querySelector('#double').textContent='DOUBLE_OK'">Double</button>
 <div id="double">DOUBLE_PENDING</div>
 <div id="source" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','DRAG_OK')">DRAG SOURCE</div>
 <div id="target" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.querySelector('#drag').textContent=event.dataTransfer.getData('text/plain')">DROP TARGET</div>
 <div id="drag">DRAG_PENDING</div>
 <p id="bottom">SCROLL TARGET</p></body></html>`;
 writeFileSync(htmlPath,html,'utf8');
 const url=pathToFileURL(htmlPath).href;
 chromeProcess=spawn(chrome,[
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  '--user-data-dir='+profile,
  '--no-first-run','--no-default-browser-check','--disable-sync',
  '--disable-extensions','--disable-background-networking',
  '--disable-component-update','--window-size=960,720','--new-window',url
 ],{windowsHide:true,stdio:'ignore'});
 show('CHROME_STARTED',{pid:chromeProcess.pid,temporaryProfile:profile});
 const portFile=path.join(profile,'DevToolsActivePort');
 const port=await waitFor(()=>{
   if(!existsSync(portFile))return null;
   const n=Number(readFileSync(portFile,'utf8').split(/\r?\n/)[0]);
   return n>0&&n<65536?n:null;
 },16000,'Chrome DevToolsActivePort');
 console.log('CDP_PORT='+port);
 // Chrome's launcher may exit 0 after handing off to an owned browser root.
 // Locate only the root with this exact unique profile; do not touch an
 // existing user Chrome process or perform any virtual desktop switch.
 const ownedPid=await waitFor(()=>ownedChromeMainPids()[0]??null,9000,'isolated profile browser root PID');
 console.log('CHROME_OWNED_BROWSER_PID='+ownedPid);
 const moved=host('move-process-tree','--pid',String(ownedPid),'--desktop-id',targetDesktop.desktopId,'--timeout-ms','13000','--show-no-activate');
 show('MOVE_PROCESS_TREE',moved);
 if(!moved.windows?.length)throw Error('No Chrome top level windows moved.');
 for(const w of moved.windows){
   const info=host('window-info','--hwnd',w.hwnd);
   if(info.desktopId!==targetDesktop.desktopId||info.desktopNumber!==2||info.onCurrentDesktop!==false)throw Error('Chrome HWND was not exclusively on Desktop2: '+JSON.stringify(info));
 }
 console.log('CHROME_WINDOWS_DESKTOP2_ONLY_PASS=true');
 if(host('current-desktop').desktopNumber!==1)throw Error('Agent switched user desktop during Chrome placement.');
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:16000});
 const context=browser.contexts()[0];
 const page=await waitFor(()=>context.pages().find(p=>p.url().startsWith('file:'))||null,8000,'Chrome local test page');
 await page.waitForSelector('#submit',{timeout:5000});
 // Autonomous CDP actions: not OS-global mouse/keyboard input.
 await page.locator('#entry').fill('DESKTOP2_AGENT_OK');
 await page.locator('#submit').click();
 const clickText=await page.locator('#result').textContent();
 const textValue=await page.locator('#entry').inputValue();
 show('CHROME_BUTTON_AND_TEXTBOX',{clickText,textValue});
 if(clickText!=='CLICKED:DESKTOP2_AGENT_OK'||textValue!=='DESKTOP2_AGENT_OK')throw Error('CDP button/textbox readback failed');
 if(host('current-desktop').desktopNumber!==1)throw Error('Desktop switched during click and typing.');
 const clipboardSequence=()=>{
   // Read only the clipboard change counter, NEVER read the user's clipboard payload.
   const ps=`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DeskMcpClipSeq { [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }'; [Console]::Write([DeskMcpClipSeq]::GetClipboardSequenceNumber())`;
   return Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',windowsHide:true,timeout:7500}).trim());
 };
 const seqBefore=clipboardSequence();
 const driver=new PlaywrightBrowserDriver();
 const driverPage=(await driver.listPages(port)).find(item=>item.url.startsWith('file:'));
 if(!driverPage) throw Error('No clipboard test page in CDP driver');
 const clip=new AgentClipboardStore();
 const leaseA='11111111-1111-4111-8111-111111111111';
 const leaseB='22222222-2222-4222-8222-222222222222';
 await page.locator('#entry').fill('AGENT_CLIPBOARD_中文');
 await page.locator('#entry').evaluate(el=>{el.focus();el.setSelectionRange(0,el.value.length)});
 const copied=await driver.copyElementText(port,driverPage.page_id,'#entry');
 clip.put(leaseA,copied);
 try {clip.read(leaseB);throw Error('Clipboard leaked across leases');}
 catch(e){if(!String(e.message).includes('empty or expired'))throw e;}
 await page.locator('#entry').fill('');
 await driver.pasteElementText(port,driverPage.page_id,clip.read(leaseA),'#entry');
 const pasted=await page.locator('#entry').inputValue();
 const seqAfter=clipboardSequence();
 show('AGENT_CLIPBOARD_ISOLATION',{pasted,sequenceBefore:seqBefore,sequenceAfter:seqAfter,secondLeaseBlocked:true});
 if(pasted!=='AGENT_CLIPBOARD_中文')throw Error('Virtual clipboard paste did not reach the input field');
 if(seqAfter!==seqBefore)throw Error('Windows system clipboard changed during virtual copy/paste (could also be external user activity)');
 clip.clearAll();
 await page.locator('#entry').fill('DESKTOP2_AGENT_OK');
 if(host('current-desktop').desktopNumber!==1)throw Error('Virtual clipboard changed active Desktop1');
 // Test a real Control+A shortcut + non-ASCII text insertion, routed by CDP.
 // This must not press the human's keyboard or change their active desktop.
 await page.locator('#entry').focus();
 await page.keyboard.press('Control+A');
 await page.keyboard.insertText('中文桌面二✓');
 const unicode=await page.locator('#entry').inputValue();
 console.log('CHROME_KEYBOARD_SHORTCUT_UNICODE='+unicode);
 if(unicode!=='中文桌面二✓')throw Error('Chrome Ctrl+A or Unicode input failed');
 await page.evaluate(()=>{
    document.querySelector('#source').addEventListener('contextmenu',e=>{
      e.preventDefault();document.querySelector('#result').dataset.rightClick='yes';
    },{once:true});
 });
 await page.locator('#source').click({button:'right'});
 const right=await page.locator('#result').getAttribute('data-right-click');
 console.log('CHROME_CONTEXT_MENU_EVENT='+right);
 if(right!=='yes')throw Error('Chrome right-click event did not arrive');
 if(host('current-desktop').desktopNumber!==1)throw Error('Chrome keyboard/right-click affected Desktop1');
 await page.locator('#entry').fill('DESKTOP2_AGENT_OK');
 await page.locator('#dbl').dblclick();
 const dbl=await page.locator('#double').textContent();
 console.log('CHROME_DOUBLE='+dbl);
 if(dbl!=='DOUBLE_OK')throw Error('Browser doubleclick did not produce application event.');
 await page.locator('#source').dragTo(page.locator('#target'),{timeout:9000});
 const drag=await page.locator('#drag').textContent();
 console.log('CHROME_DRAG='+drag);
 if(drag!=='DRAG_OK')throw Error('Browser drag drop did not update app state.');
 await page.mouse.wheel(0,650);
 await until(120);
 const scrollY=await page.evaluate(()=>window.scrollY);
 console.log('CHROME_SCROLL_Y='+scrollY);
 if(scrollY<100)throw Error('Browser wheel scroll did not move document.');
 await page.screenshot({path:screenshotPath});
 console.log('CHROME_CDP_SCREENSHOT_BYTES='+readFileSync(screenshotPath).byteLength);
 const winapp=path.join(process.env.LOCALAPPDATA,'Programs','DesktopMCP','gateway','winapp','winapp.exe');
 let nativeCaptureBytes=0;
 if(existsSync(winapp)){
   try{
     const file=path.join(runDir,'chrome-desktop2-native.png');
     const nativeCapture=JSON.parse(execFileSync(winapp,['ui','screenshot','-w',String(BigInt(moved.windows[0].hwnd)),'--output',file,'--json'],{
       encoding:'utf8',timeout:14000,windowsHide:true
     }));
     if(nativeCapture.processId!==undefined && !existsSync(file))throw Error('WinApp output missing');
     const bytes=readFileSync(file);
     if(bytes.length<100 || bytes[0]!==137 || bytes[1]!==80)throw Error('Invalid native PNG');
     nativeCaptureBytes=bytes.length;
     show('CHROME_WINAPP_WINDOW_CAPTURE',{nativeCaptureBytes,...nativeCapture});
   }catch(error){
     console.log('CHROME_WINAPP_WINDOW_CAPTURE_UNVERIFIED='+String(error.message).slice(0,300));
   }
 }
 // A native second window/popup is more challenging than a tab. It may first
 // appear on Desktop1; promptly relocate only our Chrome-owned process tree.
 await page.evaluate(()=>{
   const button=document.createElement('button');
   button.id='open-popup';
   button.textContent='Open independent window';
   button.onclick=()=>window.open('about:blank','agent_desktop2_popup','width=500,height=380');
   document.body.prepend(button);
 });
 const popupReady=context.waitForEvent('page',{timeout:8000});
 await page.locator('#open-popup').click();
 const popup=await popupReady;
 console.log('SECOND_CHROME_WINDOW_PAGE_OPENED='+popup.url());
 if(host('current-desktop').desktopNumber!==1)throw Error('Second Chrome window switched user desktop.');
 const popWindows=host('move-process-tree','--pid',String(ownedPid),'--desktop-id',targetDesktop.desktopId,'--timeout-ms','10000','--show-no-activate');
 show('CHROME_SECOND_WINDOW_MOVE',popWindows);
 if(popWindows.windows.length<2)throw Error('Chrome second-window test did not create two independent top-level windows');
 for(const w of popWindows.windows){
   const state=host('window-info','--hwnd',w.hwnd);
   if(state.desktopId!==targetDesktop.desktopId || state.desktopNumber!==2 || state.onCurrentDesktop!==false)
     throw Error('Chrome new window is visible on Desktop1 after placement');
 }
 await popup.evaluate(()=>{ document.body.textContent='POPUP_BACKGROUND_AGENT_OK'; });
 const popupReadback=await popup.locator('body').textContent();
 if(popupReadback!=='POPUP_BACKGROUND_AGENT_OK')throw Error('Popup failed CDP input/readback');
 console.log('CHROME_SECOND_WINDOW_BACKGROUND_PASS='+popWindows.windows.length);
 const after=host('current-desktop');
 show('AFTER_DESKTOP',after);
 if(after.desktopId!==beforeVirtualDesktop.desktopId||after.desktopNumber!==1)throw Error('Autonomous Chrome changed active Desktop1.');
 for(const w of moved.windows){
   const info=host('window-info','--hwnd',w.hwnd);
   if(info.desktopId!==targetDesktop.desktopId||info.onCurrentDesktop!==false)throw Error('Chrome window reappeared on Desktop1 after autonomous actions.');
 }
 show('RESULT',{success:true,headful:true,desktop2:true,click:clickText,double:dbl,drag,scrollY,screenshotBytes:readFileSync(screenshotPath).byteLength,activeDesktop:1});
 writeFileSync(resultPath,JSON.stringify({ok:true,clickText,dbl,drag,scrollY},null,2));
} catch(error){
 console.log('RESULT_ERROR='+String(error?.stack??error).slice(0,2200));
 process.exitCode=2;
} finally {
 if(browser)await browser.close().catch(()=>{});
 onlyOurChromeCleanup();
 console.log('TEST_ASSETS_PATH='+runDir);
}
