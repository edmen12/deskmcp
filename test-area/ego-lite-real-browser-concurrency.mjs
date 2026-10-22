import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { BrowserRuntime } from '../dist/src/browser-runtime.js';
import { createBrowserHandoffBoundary } from '../dist/src/browser-handoff-boundary.js';
import { PlaywrightBrowserDriver } from '../dist/src/browser-playwright.js';
import { ArtifactStore } from '../dist/src/artifact-store.js';

const browserExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const testHtml = '<!doctype html><title>DeskMCP real browser fixture</title><label for="field">Message</label><input id="field" aria-label="Message"><button id="go" onclick="document.querySelector(\'#out\').textContent=\'Clicked: \'+document.querySelector(\'#field\').value">Go</button><output id="out">Ready</output>';
function requireCondition(value, message) { assert.ok(value, message); }
function gated() {
  let entry;
  let release;
  const entered = new Promise(r => { entry = r; });
  const blocker = new Promise(r => { release = r; });
  return { entered, release, signal: entry, blocker };
}
class ControlledPlaywrightDriver extends PlaywrightBrowserDriver {
  barrier;
  arm() { this.barrier = gated(); return this.barrier; }
  async act(port, pageId, actions, timeout) {
    if (this.barrier && actions.some(a => a.type === 'fill')) {
      const barrier = this.barrier;
      this.barrier = undefined;
      barrier.signal();
      await barrier.blocker;
    }
    return super.act(port, pageId, actions, timeout);
  }
}
class OwnedTestEdge {
  processes = new Map();
  terminated = [];
  constructor(executable) { this.executable = executable; }
  async start(command) {
    const match = command.match(/--user-data-dir=([^"]+)"/u);
    if (!match) throw new Error('Could not parse isolated profile directory from DeskMCP launch command');
    const profileDir = match[1];
    if (!profileDir.includes('ego-real-browser-test-')) throw new Error('Profile outside test fixture root');
    const child = spawn(this.executable, [
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir, '--headless=new', '--no-first-run',
      '--no-default-browser-check', '--disable-sync', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update',
      '--window-size=1024,768', 'about:blank'
    ], { windowsHide: true, stdio: 'ignore' });
    const id = randomUUID();
    this.processes.set(id, { child, profileDir, createdAt: Date.now() });
    await sleep(100);
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error('Owned test browser exited unsuccessfully: ' + child.exitCode);
    return id;
  }
  async active(id) {
    const record = this.processes.get(id);
    if (!record) return false;
    if (record.child.exitCode === null && record.child.signalCode === null) return true;
    if (Date.now() - record.createdAt < 12000) return true;
    try {
      const port = Number((await readFile(path.join(record.profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
      const result = await fetch('http://127.0.0.1:' + port + '/json/version', {signal: AbortSignal.timeout(1200)});
      return result.ok;
    } catch { return false; }
  }
  async place(_id, leaseId) {
    // Test-only simulated lease placement: browser remains headless, so this
    // is NOT a real Windows Desktop 2 takeover or HUD user-presence test.
    if (!leaseId || leaseId !== '99999999-9999-4999-8999-999999999999') {
      throw new Error('Refused a non-fixture visible desktop placement');
    }
    return {moved:1,windows:1};
  }
  async terminate(id) {
    const record = this.processes.get(id);
    if (!record) return;
    this.processes.delete(id);
    this.terminated.push(id);
    if (!record.profileDir.includes('ego-real-browser-test-')) throw new Error('Refused cleanup outside test-owned profile');
    const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
    const ps = '$profile=' + psQuote(record.profileDir) + '; Get-CimInstance Win32_Process -Filter "name=\'msedge.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    const cleanup = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
    await limit(new Promise(r => cleanup.once('exit', r)), 10000, 'owned Edge cleanup');
    if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill();
  }
  async cleanup() {
    for (const id of [...this.processes.keys()]) await this.terminate(id);
  }
}
function limit(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('TIMEOUT ' + label)), ms);
    Promise.resolve(promise).then(
      value => { clearTimeout(deadline); resolve(value); },
      error => { clearTimeout(deadline); reject(error); }
    );
  });
}
const root = await mkdtemp(path.join(tmpdir(), 'ego-real-browser-test-'));
const controller = new OwnedTestEdge(browserExe);
const driver = new ControlledPlaywrightDriver();
const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(testHtml);
});
let runtime;
let handoffRuntime;
let started1;
let started2;
const facts = { date: new Date().toISOString(), chromium: browserExe, result: 'FAILED', checks: [], isolated_profile_root: root };
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = 'http://127.0.0.1:' + address.port + '/';
  await artifacts.init();
  runtime = new BrowserRuntime(path.join(root,'browser'), controller, artifacts, driver, browserExe);
  await runtime.init();
  console.log('STEP=start1');
  started1 = await limit(runtime.start({ url, timeout_ms: 25000, headless: true }), 30000, 'start 1');
  console.log('STEP=start2');
  started2 = await limit(runtime.start({ url, timeout_ms: 25000, headless: true }), 30000, 'start 2');
  facts.checks.push({ check: 'two actual headless Chromium sessions started with separate ephemeral profiles', pass: started1.profile_id !== started2.profile_id, first: started1.session_id, second: started2.session_id });
  requireCondition(started1.profile_id !== started2.profile_id, 'profile isolation');

  console.log('STEP=action_gate');
  const observation = await limit(runtime.snapshot(started1.session_id, started1.page_id, { screenshot: false }), 15000, 'initial snapshot');
  const barrier = driver.arm();
  let actionDone = false;
  const activeAction = runtime.act(started1.session_id, started1.page_id, observation.browser_observation_id, [{type:'fill',selector:'#field',value:'alpha'}], {screenshot:false}).then(v=>{actionDone=true;return v;});
  await limit(barrier.entered, 15000, 'first action entered');
  let sameDone = false;
  const sameSnapshot = runtime.snapshot(started1.session_id, started1.page_id, {screenshot:false}).then(v=>{sameDone=true;return v;});
  const otherSnapshot = await limit(runtime.snapshot(started2.session_id, started2.page_id, {screenshot:false}), 15000, 'other session snapshot');
  requireCondition(!actionDone && !sameDone, 'same-session snapshot should wait until first action finishes');
  requireCondition(otherSnapshot.session_id === started2.session_id, 'cross-session snapshot should remain independent');
  facts.checks.push({check:'same session observes only after action, independent session snapshot works during held action',pass:true});
  console.log('STEP=cross_session_pass');
  barrier.release();
  await limit(activeAction, 15000, 'first action completed');
  await limit(sameSnapshot, 15000, 'first session queued snapshot');
  facts.checks.push({check:'held action and queued snapshot resolved without deadlock',pass:true});

  console.log('STEP=action_gate_pass');
  const a1 = await runtime.snapshot(started1.session_id, started1.page_id,{screenshot:false});
  const clicked = await runtime.act(started1.session_id, started1.page_id, a1.browser_observation_id, [{type:'click',selector:'#go'}],{screenshot:false});
  requireCondition(clicked.text.includes('Clicked: alpha'), 'real Chrome page must show clicked alpha text');
  facts.checks.push({check:'real Edge DOM updated with input/click callback and read through BrowserRuntime snapshot',pass:true});

  console.log('STEP=dom_verified');

  const sibling = await runtime.snapshot(started1.session_id, started1.page_id, {screenshot:false});
  const selected = await runtime.snapshot(started1.session_id, started1.page_id, {screenshot:false});
  await runtime.act(started1.session_id, started1.page_id, selected.browser_observation_id,
    [{type:'click',selector:'#go'}], {screenshot:false});
  await assert.rejects(
    runtime.act(started1.session_id, started1.page_id, sibling.browser_observation_id,
      [{type:'click',selector:'#go'}],{screenshot:false}),
    /already-consumed|Unknown|expired/
  );
  facts.checks.push({check:'real browser sibling observation becomes invalid after one action',pass:true});

  const a2 = await runtime.snapshot(started1.session_id, started1.page_id,{screenshot:false});
  const closeBarrier = driver.arm();
  const secondAction = runtime.act(started1.session_id, started1.page_id,a2.browser_observation_id,[{type:'fill',selector:'#field',value:'beta'}],{screenshot:false});
  await limit(closeBarrier.entered,15000,'second action entered');
  let closed = false;
  const closing = runtime.close(started1.session_id).then(v=>{closed=true;return v;});
  await sleep(100);
  requireCondition(!closed, 'close must not finish during in-flight action');
  closeBarrier.release();
  await limit(secondAction, 15000, 'second action completed');
  const closedResult = await limit(closing, 15000, 'closing');
  requireCondition(closedResult.closed === true && controller.terminated.length === 1, 'one owned Chrome terminated after action');
  facts.checks.push({check:'session close waits for in-flight real-browser action then terminates owned Edge process',pass:true});

  console.log('STEP=close_gate_pass');
  const b = await runtime.snapshot(started2.session_id,started2.page_id,{screenshot:false});
  const bAction = await runtime.act(started2.session_id,started2.page_id,b.browser_observation_id,[{type:'fill',selector:'#field',value:'independent'}],{screenshot:false});
  requireCondition(bAction.session_id === started2.session_id, 'second session remains usable');
  facts.checks.push({check:'other browser session survives first session close',pass:true});

  console.log('STEP=workflow_real_edge');
  const workflowStarting = await runtime.snapshot(started2.session_id, started2.page_id, {screenshot:false});
  const workflow = await runtime.runGuardedWorkflow(started2.session_id, started2.page_id, workflowStarting.browser_observation_id, [
    { action:{type:'fill',selector:'#field',value:'workflow-real-edge'},expected_url:url },
    { action:{type:'click',selector:'#go'},expected_url:url,after_text:'Clicked: workflow-real-edge' }
  ]);
  requireCondition(workflow.completed_steps === 2 && workflow.final_snapshot.text.includes('Clicked: workflow-real-edge'),
    'two-step real Chromium workflow must produce actual final DOM effect');
  facts.checks.push({check:'real Edge two-step bounded workflow: fresh observation for each mutation and DOM confirmation',pass:true});

  const workflowNegativeStarting = await runtime.snapshot(started2.session_id, started2.page_id,{screenshot:false});
  await assert.rejects(runtime.runGuardedWorkflow(started2.session_id,started2.page_id,workflowNegativeStarting.browser_observation_id,[
    {action:{type:'fill',selector:'#field',value:'should-not-be-clicked'},expected_url:url},
    {action:{type:'click',selector:'#go'},expected_url:url+'wrong'}
  ]), error => error?.name==='BrowserWorkflowInterrupted' && error.completed_steps===1 && error.step_index===1 && error.dispatch_uncertain===false);
  const verifyNoRepeat = await runtime.snapshot(started2.session_id,started2.page_id,{screenshot:false});
  requireCondition(verifyNoRepeat.text.includes('Clicked: workflow-real-edge'), 'guard mismatch must not click');
  facts.checks.push({check:'real Edge wrong URL guard prevents later click after prior fill',pass:true});
  const [remainingId] = controller.processes.keys();
  requireCondition(Boolean(remainingId) && controller.processes.size === 1, 'second owned browser process remains');
  await controller.terminate(remainingId);
  const recovered = await runtime.list();
  requireCondition(recovered.length === 0, 'runtime must reconcile unexpected browser-process termination');
  facts.checks.push({check:'unexpected browser-process termination reconciles session and releases its profile ownership',pass:true});
  console.log('STEP=second_session_pass');
  const fakeLeaseId='99999999-9999-4999-8999-999999999999';
  const fakeDesktop={
    async assertLease(id){assert.equal(id,fakeLeaseId);return{};},
    async isLeaseActive(id){return id===fakeLeaseId;}
  };
  const authority=createBrowserHandoffBoundary(id=>handoffRuntime.invalidateForLocalHandoff(id));
  handoffRuntime=new BrowserRuntime(
    path.join(root,'human-privacy-browser'),controller,artifacts,driver,browserExe,
    fakeDesktop,undefined,authority.agent,undefined,authority.runtime
  );
  await handoffRuntime.init();
  const handoffSession=await limit(handoffRuntime.start({
    url,timeout_ms:25000,agent_desktop_lease_id:fakeLeaseId
  }),30000,'isolated real Chromium simulated-lease start');
  const before=await handoffRuntime.snapshot(handoffSession.session_id,handoffSession.page_id,{screenshot:false});
  await handoffRuntime.act(handoffSession.session_id,handoffSession.page_id,before.browser_observation_id,
    [{type:'fill',selector:'#field',value:'PRIVATE-OTP-EXAMPLE'}],{screenshot:false});
  const otherTab=await handoffRuntime.newPage(handoffSession.session_id,url);
  requireCondition(Boolean(otherTab.page_id),'second real Edge tab created for cleanup test');
  await handoffRuntime.requestLocalBrowserHandoff(handoffSession.session_id);
  authority.local.accept(handoffSession.session_id);
  requireCondition(authority.local.resume(handoffSession.session_id).state==='privacy-reset',
    'local signal cannot instantly grant Agent visibility');
  await assert.rejects(
    handoffRuntime.snapshot(handoffSession.session_id,handoffSession.page_id,{screenshot:false}),
    /human control/i
  );
  facts.checks.push({check:'real Edge under simulated lease: privacy-reset denies snapshot before cleanup',pass:true});
  const safelyReturned=await limit(handoffRuntime.completeLocalBrowserHandback(handoffSession.session_id),
    30000,'safe post-human blank reset');
  const returnedSnapshot=await handoffRuntime.snapshot(handoffSession.session_id,safelyReturned.page_id,{screenshot:false});
  requireCondition(returnedSnapshot.url==='about:blank'
    && returnedSnapshot.text.length===0
    && !JSON.stringify(returnedSnapshot).includes('PRIVATE-OTP-EXAMPLE'),
    'old human-entered form and tabs must be gone before Agent can read');
  requireCondition((await handoffRuntime.list())[0]?.pages.length===1,
    'verified reset leaves exactly one blank tab');
  facts.checks.push({check:'real Edge simulated-lease handback closes prior tabs and returns only a new blank page',pass:true});
  await handoffRuntime.closeAll();
  console.log('STEP=real_handback_privacy_pass');
  facts.result = 'PASS';
} catch (e) {
  facts.error = String(e?.stack || e);
} finally {
  await limit(handoffRuntime?.closeAll() ?? Promise.resolve(),15000,'handoff runtime closeAll').catch(e => { facts.cleanup_error=String(e); });
  await limit(runtime?.closeAll() ?? Promise.resolve(),15000,'runtime closeAll').catch(e => { facts.cleanup_error=String(e); });
  await controller.cleanup().catch(e => { facts.cleanup_error=String(e); });
  await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(e=>{facts.profile_cleanup_error=String(e)});
  facts.test_browser_processes_remaining=controller.processes.size;
  facts.profile_root_present=await (await import('node:fs/promises')).access(root).then(()=>true,()=>false);
  console.log('EGO_REAL_BROWSER_RESULT='+JSON.stringify(facts));
  if(facts.result!=='PASS'||facts.cleanup_error||facts.profile_cleanup_error||facts.profile_root_present||facts.test_browser_processes_remaining) process.exitCode=1;
}
