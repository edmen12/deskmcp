import type { ComputerWindow } from './computer-use-backend.js';
import type { Desktop2ComputerAction, Desktop2ComputerUseCandidate } from './desktop2-computer-use-candidate.js';
import type { Desktop2WindowInventory } from './desktop2-window-inventory.js';
import type { Desktop2ObserverLifecycle, Desktop2ObserverSession } from './desktop2-observer-lifecycle.js';

// Candidate composition; NOT an externally registered MCP endpoint.
// The requester cannot supply their own observer ready path or lease ID.
type Passive = Pick<Desktop2WindowInventory,'list'>;
type Observer = Pick<Desktop2ObserverLifecycle,'start'|'assertHealthy'|'stop'>;
type Actions = Pick<Desktop2ComputerUseCandidate,'dispatch'>;
type UserAction = Omit<Desktop2ComputerAction,'agentDesktopLeaseId'|'observerReadyFile'>;

export class Desktop2ComputerUseSession {
  private session:Desktop2ObserverSession|undefined;
  private opening:Promise<void>|undefined;
  private epoch=0;
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
    if(!this.session) throw new Error('Desktop2 Computer Use session is not active.');
    const active=await this.observer.assertHealthy(this.leaseId);
    if(active.readyFile!==this.session.readyFile
      || active.targetFile!==this.session.targetFile
      || active.tripwireFile!==this.session.tripwireFile) {
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

  async dispatch(input:UserAction):Promise<unknown> {
    const guarded=await this.checked();
    const output=await this.actions.dispatch({
      ...input,agentDesktopLeaseId:this.leaseId,
      observerReadyFile:guarded.readyFile
    });
    await this.checked();
    return output;
  }

  async stop():Promise<void> {
    ++this.epoch;
    this.session=undefined;
    // Stop the monitor immediately even when a competing start() is waiting
    // on a ready handshake. The pending start must never rearm after stop.
    const opening=this.opening;
    await this.observer.stop();
    if(opening)await opening.catch(()=>undefined);
  }
}
