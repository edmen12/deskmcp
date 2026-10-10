import { spawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentDesktopManager } from './agent-desktop-state.js';
import type { AgentDesktopNativeBridge } from './agent-desktop-native.js';

// Source-only candidate. Does not start automatically with DeskMCP or MCP.
type Lease = Pick<AgentDesktopManager,'assertLease'>;
type Host = Pick<AgentDesktopNativeBridge,'info'>;
type Launched = Pick<ChildProcess,'pid'|'exitCode'|'signalCode'|'kill'>
  & Pick<EventEmitter,'once'|'off'>;
export type ObserverLaunch = (exe:string,args:readonly string[])=>Launched;

interface Ready {
  readonly processId: number;
  readonly expectedDesktopIndex: number;
  readonly tripwireFile: string;
  readonly watchedTargetFile: string;
  readonly hasVirtualDesktopNotifications: boolean;
  readonly hasForegroundHook: boolean;
  readonly strictForegroundArmed?: boolean;
  readonly strictWindowShowArmed?: boolean;
  readonly messagePumpRunning?: boolean;
}
export interface Desktop2ObserverSession {
  readonly readyFile: string;
  readonly eventLog: string;
  readonly tripwireFile: string;
  readonly targetFile: string;
  readonly directory: string;
}

/**
 * Start one message-only observer with a private per-lease run directory.
 * Never requests a Windows virtual desktop switch or global keyboard/mouse.
 * Logs and tripwires remain available for incident forensics on stop.
 */
export class Desktop2ObserverLifecycle {
  private child:Launched|undefined;
  private session:Desktop2ObserverSession|undefined;
  private tick:NodeJS.Timeout|undefined;
  private healthInFlight:Promise<Desktop2ObserverSession>|undefined;
  private reason:string|undefined;
  private generation:number|undefined;
  constructor(
    private readonly leases:Lease,
    private readonly native:Host,
    private readonly observerExe:string,
    private readonly vdaDll:string,
    private readonly launcher:ObserverLaunch=(exe,args)=>{
      const child=spawn(exe,[...args],{shell:false,windowsHide:true,stdio:'ignore'});
      // A missing/broken helper must never raise an unhandled 'error' event.
      child.on('error',()=>{this.reason='Native observer process failed to start.';});
      return child;
    },
    // Windows under heavy memory pressure can take several seconds to launch
    // a framework-dependent .NET watcher. This is a readiness deadline,
    // NEVER permission to send input without a fully trusted observer.
    private readonly readyTimeoutMs:number=15000,
    private readonly strictPrelaunch:boolean=false
  ) {
    if(!Number.isInteger(readyTimeoutMs) || readyTimeoutMs<100 || readyTimeoutMs>20000)
      throw new Error('Invalid passive observer startup timeout.');
  }

  private validatePaths():void {
    if (process.platform!=='win32') throw new Error('Desktop2 observer requires Windows.');
    if (!path.isAbsolute(this.observerExe)
      || path.basename(this.observerExe).toLowerCase()!=='deskmcp.desktop2switchobserver.exe'
      || !path.isAbsolute(this.vdaDll)
      || path.basename(this.vdaDll).toLowerCase()!=='virtualdesktopaccessor.dll') {
      throw new Error('Desktop2 observer binary paths do not match the trusted native helper names.');
    }
  }

  async start(leaseId:string):Promise<Desktop2ObserverSession> {
    if (this.child || this.session) throw new Error('An observer session is already active.');
    this.validatePaths();
    const initial=await this.leases.assertLease(leaseId);
    const state=await this.native.info();
    if (!initial.control.active || initial.control.desktopNumber!==2
        || initial.control.leaseId?.toLowerCase()!==leaseId.toLowerCase()
        || !initial.control.desktopId
        || initial.binding.desktopId.toLowerCase()!==initial.control.desktopId.toLowerCase()
        || !state.virtualDesktopAccessor || state.currentDesktopNumber!==1) {
      throw new Error('Observer requires a HUD-backed Desktop2 lease and owner Desktop1.');
    }
    this.generation=initial.control.generation;
    this.reason=undefined;
    const dir=await mkdtemp(path.join(os.tmpdir(),'deskmcp-d2-lease-'+randomUUID().slice(0,8)+'-'));
    const session={
      directory:dir, readyFile:path.join(dir,'observer.ready.json'),
      eventLog:path.join(dir,'observer.events.jsonl'),
      tripwireFile:path.join(dir,'observer.tripwire.json'),
      targetFile:path.join(dir,'target.watch.json')
    };
    try {
      const child=this.launcher(this.observerExe,[
        this.strictPrelaunch ? '--observe-strict-launch' : '--observe-target',this.vdaDll,session.eventLog,
        session.readyFile,session.tripwireFile,session.targetFile
      ]);
      // Store the actual spawned ChildProcess handle BEFORE validating PID.
      // Node may return a process handle with PID not yet available; throwing
      // first would orphan a still-running native observer and its hooks.
      this.child=child;
      this.session=session;
      if (!Number.isInteger(child.pid) || (child.pid??0)<1)
        throw new Error('Passive observer did not return a native process ID.');
      let ready:Ready|undefined;
      const deadline=Date.now()+this.readyTimeoutMs;
      while(Date.now()<deadline) {
        if (child.exitCode!==null || child.signalCode!==null || this.reason)
          throw new Error('Passive observer exited before ready.');
        try {
          const parsed=JSON.parse(await readFile(session.readyFile,'utf8')) as Ready;
          ready=parsed;break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code!=='ENOENT'
            && !(e instanceof SyntaxError)) throw e;
        }
        await new Promise(resolve=>setTimeout(resolve,40));
      }
      if (!ready)
        throw new Error('PASSIVE_OBSERVER_READY_TIMEOUT_NO_GUI_STARTED');
      if (ready.processId!==child.pid || ready.expectedDesktopIndex!==0
          || ready.tripwireFile!==session.tripwireFile
          || ready.watchedTargetFile!==session.targetFile
          || ready.hasVirtualDesktopNotifications!==true
          || ready.hasForegroundHook!==true
          || ready.messagePumpRunning!==true
          || (this.strictPrelaunch && (ready.strictForegroundArmed!==true
              || ready.strictWindowShowArmed!==true))
          || (!this.strictPrelaunch && ready.strictForegroundArmed===true)
          || existsSync(session.tripwireFile)) {
        throw new Error('Desktop2 foreground/switch observer failed ready identity verification.');
      }
      await this.assertHealthy(leaseId);
      // Unref only the poll timer; the observer itself remains owned by this
      // coordinator and must be explicitly stopped after the lease ends.
      this.tick=setInterval(()=>{
        void this.assertHealthy(leaseId).catch(error=>{
          this.reason=error instanceof Error?error.message:'Observer safety check failed';
          this.child?.kill();
        });
      },250);
      this.tick.unref?.();
      return session;
    } catch(e) {
      // Startup failures (forged Ready, hook failure, timeout) need the same
      // owned-process exit confirmation as normal stop. Otherwise a late
      // observer can outlive this session and overlap the next trial.
      let cleanupFailed:unknown;
      try{await this.stop();}
      catch(error){cleanupFailed=error;}
      // Leave any incident evidence (or unconfirmed child) untouched.
      if(!cleanupFailed && !existsSync(session.eventLog)
          && !existsSync(session.tripwireFile))
        await rm(dir,{recursive:true,force:true}).catch(()=>undefined);
      if(cleanupFailed)
        throw new Error('OBSERVER_STARTUP_FAILURE_CLEANUP_UNCONFIRMED',
          {cause:cleanupFailed});
      throw e;
    }
  }

  async assertHealthy(leaseId:string):Promise<Desktop2ObserverSession> {
    const session=this.session,child=this.child;
    if(!session || !child || this.reason || child.exitCode!==null
        || child.signalCode!==null || !existsSync(session.readyFile) || existsSync(session.tripwireFile)) {
      throw new Error('Desktop2 observer stopped, missing or latched; input must remain paused.');
    }
    if(this.healthInFlight) return this.healthInFlight;
    const check=(async()=>{
      const [lease,info]=await Promise.all([this.leases.assertLease(leaseId),this.native.info()]);
      if(!lease.control.active || lease.control.desktopNumber!==2
        || lease.control.generation!==this.generation
        || lease.control.leaseId?.toLowerCase()!==leaseId.toLowerCase()
        || !info.virtualDesktopAccessor || info.currentDesktopNumber!==1)
        throw new Error('Desktop2 observer lost lease/HUD/owner Desktop1.');
      if(this.reason || this.session!==session || this.child!==child
        || child.exitCode!==null || child.signalCode!==null
        || !existsSync(session.readyFile) || existsSync(session.tripwireFile))
        throw new Error('Desktop2 observer tripped during health check.');
      return session;
    })();
    this.healthInFlight=check;
    try{return await check;}
    finally{if(this.healthInFlight===check)this.healthInFlight=undefined;}
  }

  // Candidate-only authority minted from the CURRENT HUD lease and the
  // same real native watcher this object launched. Callers cannot choose a
  // PID, executable, Ready/tripwire or desktop GUID.
  async targetBackgroundAuthority(leaseId:string):Promise<{
    readonly desktopId:string;readonly readyFile:string;
    readonly tripwireFile:string;readonly exePath:string;readonly pid:number;
  }> {
    if(this.strictPrelaunch)
      throw new Error('Background actions require a live exact-target observer, not launch-only SHOW mode.');
    const session=await this.assertHealthy(leaseId);
    const child=this.child;
    const live=await this.leases.assertLease(leaseId);
    if(!child || !Number.isSafeInteger(child.pid) || (child.pid??0)<1
      || child.exitCode!==null || child.signalCode!==null
      || this.session!==session || !existsSync(session.targetFile)
      || !live.control.active
      || live.control.desktopNumber!==2
      || live.control.leaseId?.toLowerCase()!==leaseId.toLowerCase()
      || !live.control.desktopId
      || live.binding.desktopId.toLowerCase()!==live.control.desktopId.toLowerCase())
      throw new Error('Strict background observer or matching HUD authority disappeared.');
    await this.assertHealthy(leaseId);
    return {
      desktopId:live.binding.desktopId,readyFile:session.readyFile,
      tripwireFile:session.tripwireFile,exePath:this.observerExe,pid:child.pid!
    };
  }

  async stop():Promise<{readonly stopped:boolean;readonly exitConfirmed:boolean;readonly preservedLog?:string}> {
    const child=this.child,session=this.session;
    if(this.tick)clearInterval(this.tick);
    this.tick=undefined;
    this.reason='stopped';
    // Revoke input authorization BEFORE attempting to stop the process.
    // Keep child/session identity if termination cannot be confirmed, so
    // another session cannot be started over an orphaned native observer.
    if(session)await rm(session.readyFile,{force:true});
    let exitConfirmed=!child || child.exitCode!==null || child.signalCode!==null;
    if(child && !exitConfirmed){
      exitConfirmed=await new Promise<boolean>(resolve=>{
        let resolved=false;
        const finish=(ok:boolean)=>{
          if(resolved)return;
          resolved=true;
          clearTimeout(timeout);
          child.off('exit',exited);
          resolve(ok);
        };
        const exited=()=>finish(true);
        const timeout=setTimeout(()=>finish(false),2000);
        child.once('exit',exited);
        try{
          if(child.exitCode!==null || child.signalCode!==null){
            finish(true);
          }else if(!child.kill()){
            finish(child.exitCode!==null || child.signalCode!==null);
          }else if(child.exitCode!==null || child.signalCode!==null){
            finish(true);
          }
        }catch{finish(false);}
      });
    }
    if(!exitConfirmed){
      this.reason='OBSERVER_PROCESS_EXIT_UNCONFIRMED';
      throw new Error(this.reason);
    }
    this.child=undefined;
    this.session=undefined;
    this.generation=undefined;
    if(session)await rm(session.targetFile,{force:true});
    return {stopped:Boolean(child),exitConfirmed,
      ...(session?{preservedLog:session.eventLog}:{})};
  }
}
