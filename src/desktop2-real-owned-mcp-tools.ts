import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import type { DesktopPolicy } from './desktop-policy.js';
import type { RealDesktop2OwnedControl } from './desktop2-real-owned-control.js';

// EXPLICITLY INJECTED source-only candidate. Not registered by default.
// RealDesktop2OwnedControl must have an independently trusted owned-launch
// attestor; a caller-provided title, PID, HWND or app string never suffices.
interface Permit {
  readonly leaseId:string;
  readonly windowId:string;
  readonly observationId:string;
  readonly automationId:string;
  readonly type:'edit'|'button'|'list';
}
const id = z.string().uuid();
const edit = z.object({
  type:z.literal('set_native_edit'),
  value:z.string().max(512),
  expected_previous_value:z.string().max(512)
}).strict();
const button = z.object({type:z.literal('click_native_button')}).strict();
const list = z.object({
  type:z.literal('scroll_native_list'),
  top_index:z.number().int().min(0).max(511),
  expected_previous_top_index:z.number().int().min(0).max(511)
}).strict();

export function registerRealDesktop2OwnedControlTools(
  server:McpServer,policy:DesktopPolicy,audit:AuditLogger,
  bridge:Pick<RealDesktop2OwnedControl,'start'|'list'|'snapshot'|'perform'|'stop'>
):void {
  const permits=new Map<string,Permit>();
  async function guarded(name:string,leaseId:string,fn:()=>Promise<unknown>) {
    let operation;
    try {
      operation=await audit.begin(name,'computer',policy.profile,'real-vda-d2-owned');
      policy.assertCanUseComputer();
      const result=await fn();
      await audit.finish(operation,'allow');
      return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
    } catch(error) {
      // A failed audit, policy check or unknown native outcome revokes every
      // outstanding public control permit; never leave a replay handle live.
      permits.clear();
      if(operation) await audit.finish(operation,'deny',error).catch(()=>undefined);
      return {isError:true as const,content:[{type:'text' as const,
        text:'Real Desktop2 owned operation denied: '+
        (error instanceof Error?error.message:'unknown failure').slice(0,240)}]};
    }
  }
  server.registerTool('desktop2_real_owned_start', {
    title:'Arm a verified real Desktop 2 owned session (candidate)',
    description:'EXPERIMENTAL: requires an existing HUD lease and a trusted owned-launch authority. Arms independent VDA/WinEvent observer; never switches Desktop1 or launches a GUI.',
    inputSchema:z.object({agent_desktop_lease_id:id}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },({agent_desktop_lease_id})=>guarded('desktop2_real_owned_start',agent_desktop_lease_id,
    async()=>{await bridge.start(agent_desktop_lease_id);return {desktop_scope:'windows_virtual_desktop2',observer_armed:true};}));

  server.registerTool('desktop2_real_owned_windows', {
    title:'Read attested real Desktop 2 windows (candidate)',
    description:'Returns opaque window IDs from actual VDA Desktop2, never private Win32 Desktop Objects. No raw native HWND/PID or window title.',
    inputSchema:z.object({agent_desktop_lease_id:id}).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },({agent_desktop_lease_id})=>guarded('desktop2_real_owned_windows',agent_desktop_lease_id,
    async()=>{permits.clear();return {
      desktop_scope:'windows_virtual_desktop2',action_authorized:false,
      windows:await bridge.list(agent_desktop_lease_id)};}));

  server.registerTool('desktop2_real_owned_snapshot', {
    title:'Snapshot native controls of an attested owned D2 window (candidate)',
    description:'A strict observer is armed before native HWND-only inspection. The returned control IDs are opaque and short lived.',
    inputSchema:z.object({
      agent_desktop_lease_id:id,window_id:id,
      kind:z.enum(['edit','button','list'])
    }).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },({agent_desktop_lease_id,window_id,kind})=>
    guarded('desktop2_real_owned_snapshot',agent_desktop_lease_id,async()=>{
      permits.clear();
      const observed=await bridge.snapshot(agent_desktop_lease_id,window_id,kind);
      if(!observed.one_shot_native_permit)throw new Error('NATIVE_PERMIT_NOT_VALIDATED');
      if(observed.controls.length>16)throw new Error('UNBOUNDED_CONTROL_SNAPSHOT');
      const controls=observed.controls.map(control=>{
        const controlId=randomUUID();
        permits.set(controlId,{
          leaseId:agent_desktop_lease_id.toLowerCase(),windowId:window_id,
          observationId:observed.computer_observation_id,
          automationId:control.automationId,type:kind
        });
        return {control_id:controlId,control_type:control.controlType,
          class_name:control.className};
      });
      return {desktop_scope:'windows_virtual_desktop2',
        computer_observation_id:observed.computer_observation_id,
        controls,app_event_verified:false,business_outcome_verified:false};
    }));

  server.registerTool('desktop2_real_owned_action', {
    title:'Single guarded native control action on owned D2 fixture (candidate)',
    description:'Source-only candidate. One-use observation, native Edit compare-and-swap, PushButton or ListBox top-index. No UIA ValuePattern, SendInput or clipboard. Delivery is NOT a verified app event.',
    inputSchema:z.object({
      agent_desktop_lease_id:id,window_id:id,
      computer_observation_id:id,control_id:id,
      action:z.discriminatedUnion('type',[edit,button,list])
    }).strict(),
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
  },({agent_desktop_lease_id,window_id,computer_observation_id,control_id,action})=>
    guarded('desktop2_real_owned_action',agent_desktop_lease_id,async()=>{
      const permit=permits.get(control_id);
      // ALL permits from that snapshot are consumed before calling the
      // native provider, including unknown delivery or ownership failure.
      for(const [key,other] of permits) {
        if(other.observationId===computer_observation_id)permits.delete(key);
      }
      permits.delete(control_id);
      if(!permit || permit.leaseId!==agent_desktop_lease_id.toLowerCase()
        ||permit.windowId!==window_id ||
        permit.observationId!==computer_observation_id ||
        (permit.type==='edit'&&action.type!=='set_native_edit') ||
        (permit.type==='button'&&action.type!=='click_native_button') ||
        (permit.type==='list'&&action.type!=='scroll_native_list'))
        throw new Error('OPAQUE_ONESHOT_REAL_D2_PERMIT_INVALID');
      const nativeAction=action.type==='set_native_edit'
        ? {type:'set_native_edit' as const,automationId:permit.automationId,
          value:action.value,expectedPreviousValue:action.expected_previous_value}
        : action.type==='click_native_button'
        ? {type:'click_native_button' as const,automationId:permit.automationId}
        : {type:'scroll_native_list' as const,automationId:permit.automationId,
          topIndex:action.top_index,expectedPreviousTopIndex:action.expected_previous_top_index};
      const result=await bridge.perform(agent_desktop_lease_id,window_id,
        computer_observation_id,nativeAction);
      return {desktop_scope:'windows_virtual_desktop2',...result};
    }));

  server.registerTool('desktop2_real_owned_stop', {
    title:'Release real D2 owned observer session (candidate)',
    description:'Stops owned-window action authority and waits for in-flight native work before the caller releases HUD lease. Does NOT automatically stop or replace the HUD lease.',
    inputSchema:z.object({agent_desktop_lease_id:id}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },({agent_desktop_lease_id})=>guarded('desktop2_real_owned_stop',agent_desktop_lease_id,
    async()=>{permits.clear();await bridge.stop(agent_desktop_lease_id);return {observer_stopped:true,lease_still_caller_owned:true};}));
}
