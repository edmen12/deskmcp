import type { ComputerWindow } from './computer-use-backend.js';
import type { Desktop2ComputerAction, Desktop2ComputerUseCandidate } from './desktop2-computer-use-candidate.js';
import type { Desktop2WindowInventory } from './desktop2-window-inventory.js';
import type { Desktop2ObserverLifecycle, Desktop2ObserverSession } from './desktop2-observer-lifecycle.js';

// Candidate composition; NOT an externally registered MCP endpoint.
// The requester cannot supply their own observer ready path or lease ID.
type Passive = Pick<Desktop2WindowInventory,'list'>;
type Observer = Pick<Desktop2ObserverLifecycle,'start'|'assertHealthy'|'stop'>;
type Actions = Pick<Desktop2ComputerUseCandidate,'dispatch'> & Partial<Pick<Desktop2ComputerUseCandidate,'discoverWindows'|'snapshotWindow'>>;
type UserAction = Omit<Desktop2ComputerAction,'agentDesktopLeaseId'|'observerReadyFile'>;

export class Desktop2ComputerUseSession {
  private session:Desktop2ObserverSession|undefined;
  private opening:Promise<void>|undefined;
  private readonly inFlight=new Set<Promise<unknown>>();
  private epoch=0;

  private async withMonitorHeld<T>(operation:()=>Promise<T>):Promise<T> {
    const executing=operation();
    this.inFlight.add(executing);
    try{return await executing;}
    finally{this.inFlight.delete(executing);}
  }
  constructor(
    private readonly leaseId:string,
    private readonly passive:Passive,
    private readonly observer:Observer,
    private readonly actions:Actions
  ) {}

  async start():Promise<void> {
    if(this.session || this.opening) throw new Error('Desktop2 Computer Use session already started.');
    const epoch=++this.epoch;
    const opening=(async()=>{
      const created=await this.observer.start(this.leaseId);
      try{
        await this.observer.assertHealthy(this.leaseId);
        if(this.epoch!==epoch)
          throw new Error('Desktop2 Computer Use session was stopped during startup.');
        this.session=created;
      }catch(error){
        await this.observer.stop();
        throw error;
      }
    })();
    this.opening=opening;
    try{await opening;}
    finally{if(this.opening===opening)this.opening=undefined;}
  }

  private async checked():Promise<Desktop2ObserverSession> {
    const expected=this.session;
    if(!expected) throw new Error('Desktop2 Computer Use session is not active.');
    const active=await this.observer.assertHealthy(this.leaseId);
    if(this.session!==expected)
      throw new Error('Desktop2 Computer Use session was revoked during the operation.');
    if(active.readyFile!==expected.readyFile
      || active.targetFile!==expected.targetFile
      || active.tripwireFile!==expected.tripwireFile) {
      throw new Error('Desktop2 observer identity changed during Computer Use.');
    }
    return active;
  }

  async listWindows():Promise<readonly ComputerWindow[]> {
    await this.checked();
    const windows=await this.passive.list();
    await this.checked();
    return windows;
  }

  async discoverWindows():Promise<Awaited<ReturnType<NonNullable<Actions['discoverWindows']>>>> {
    await this.checked();
    if(!this.actions.discoverWindows)
      throw new Error('Passive Desktop2 window capability provider unavailable.');
    const discovered=await this.actions.discoverWindows(this.leaseId);
    await this.checked();
    return discovered;
  }

  async snapshotWindow(windowId:string):Promise<Awaited<ReturnType<NonNullable<Actions['snapshotWindow']>>>> {
    return this.withMonitorHeld(async()=>{
      const guard=await this.checked();
      if(!this.actions.snapshotWindow)
        throw new Error('Protected Desktop2 semantic snapshot provider unavailable.');
      const observed=await this.actions.snapshotWindow({
        windowId,agentDesktopLeaseId:this.leaseId,observerReadyFile:guard.readyFile
      });
      await this.checked();
      return observed;
    });
  }

  async dispatch(input:UserAction):Promise<unknown> {
    return this.withMonitorHeld(async()=>{
      const guarded=await this.checked();
      const output=await this.actions.dispatch({
        ...input,agentDesktopLeaseId:this.leaseId,
        observerReadyFile:guarded.readyFile
      });
      await this.checked();
      return output;
    });
  }

  async stop():Promise<void> {
    ++this.epoch;
    this.session=undefined;
    // Immediately revoke ALL new input, but keep the passive observer alive
    // until any already-running bounded native UIA provider has exited.
    // Killing the observer first would create an unmonitored focus-steal gap.
    const opening=this.opening;
    await Promise.allSettled([...this.inFlight]);
    await this.observer.stop();
    if(opening)await opening.catch(()=>undefined);
  }
}
