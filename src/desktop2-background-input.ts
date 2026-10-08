/**
 * Windows *virtual* Desktop 2+ background-window input.
 * No Win32 Desktop Object, no VM, no host SendInput or desktop switching.
 * Source-only: do NOT register in MCP until dedicated GUI acceptance passes.
 */
export type Desktop2MessageAction =
  | Readonly<{type:'move'|'click'|'right-click'|'double-click';x:number;y:number}>
  | Readonly<{type:'drag';x:number;y:number;toX:number;toY:number;steps?:number}>
  | Readonly<{type:'wheel';x:number;y:number;delta:number}>
  | Readonly<{type:'key';vk:number}>
  | Readonly<{type:'text';text:string}>
  | Readonly<{type:'invoke-button'}>;

export function buildDesktop2BackgroundInputArgs(
  hwnd:number,
  processId:number,
  desktopId:string,
  action:Desktop2MessageAction
):readonly string[] {
  if(!Number.isSafeInteger(hwnd)||hwnd<1||!Number.isSafeInteger(processId)||processId<1)
    throw new Error('Desktop 2 background input requires a live HWND and positive expected owner PID.');
  const d=desktopId.toLowerCase();
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(d))
    throw new Error('Desktop 2 background input requires a verified virtual-desktop GUID.');
  const args=['background-input','--hwnd',String(hwnd),'--pid',String(processId),'--desktop-id',d,'--action',action.type];
  const number=(key:string,value:number,min:number,max:number)=>{
    if(!Number.isInteger(value)||value<min||value>max) throw new Error(`Invalid Desktop 2 ${key}: expected integer in ${min}..${max}.`);
    args.push('--'+key,String(value));
  };
  switch(action.type){
    case 'invoke-button':
      break;
    case 'move':
    case 'click':
    case 'right-click':
    case 'double-click':
      number('x',action.x,0,32767); number('y',action.y,0,32767);
      break;
    case 'drag':
      number('x',action.x,0,32767); number('y',action.y,0,32767);
      number('to-x',action.toX,0,32767); number('to-y',action.toY,0,32767);
      number('steps',action.steps??8,2,60);
      break;
    case 'wheel':
      number('x',action.x,0,32767); number('y',action.y,0,32767);
      number('delta',action.delta,-1200,1200);
      if(action.delta===0) throw new Error('Desktop 2 wheel delta cannot be zero.');
      break;
    case 'key':
      number('vk',action.vk,1,254);
      break;
    case 'text':
      if(action.text.length<1||action.text.length>128||/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(action.text))
        throw new Error('Desktop 2 literal text must contain 1..128 permitted UTF-16 code units.');
      args.push('--text',action.text);
      break;
  }
  return args;
}
