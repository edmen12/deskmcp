// Only for opt-in, fixture-owned WPF Named Pipe; not external desktop control.
// Retry ONLY ENOENT from a failed connect (no request bytes were sent).
// Ambiguous errors after connect must fail, never replay app side effects.
import net from 'node:net';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function oneAttempt({pipe,token,sequence,action,extra,timeoutMs}){
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection('\\\\.\\pipe\\'+pipe);
  let connected=false,settled=false,buffer='';
  const timeout=setTimeout(()=>finish(new Error('WPF_PIPE_COMMAND_TIMEOUT')),timeoutMs);
  function finish(error,value){
   if(settled)return;
   settled=true;clearTimeout(timeout);socket.destroy();
   if(error)reject(error);else resolve(value);
  }
  socket.on('error',error=>{
   // Only the initial connection's missing endpoint can be retried.
   if(connected && error?.code==='ENOENT'){
    const ambiguous=new Error('WPF_PIPE_ERROR_AFTER_CONNECT_NOT_RETRYABLE');
    finish(ambiguous);
   }else finish(error);
  });
  socket.on('connect',()=>{
   connected=true;
   socket.write(JSON.stringify({...extra,token,sequence,action})+'\n');
  });
  socket.on('data',chunk=>{
   buffer+=chunk.toString('utf8');
   if(buffer.length>4096)return finish(new Error('WPF_PIPE_REPLY_TOO_LARGE'));
   const end=buffer.indexOf('\n');
   if(end>=0){
    try{finish(null,JSON.parse(buffer.slice(0,end)));}
    catch(error){finish(error);}
   }
  });
  socket.on('end',()=>{if(!settled)finish(new Error('WPF_PIPE_END_BEFORE_ACK'));});
 });
}

export async function sendOwnedWpfPipeCommand({pipe,token,sequence,action,extra={},
 onBeforeReconnect=async()=>{},maxEnoentRetries=10,delayMs=40,timeoutMs=7000}){
 if(!/^deskmcp-d2-wpf-[0-9a-f-]{36}$/iu.test(pipe)||
    !/^[a-f0-9]{64}$/iu.test(token)||
    !Number.isSafeInteger(sequence)||sequence<1||
    !['edit','button','scroll'].includes(action)||
    !Number.isInteger(maxEnoentRetries)||maxEnoentRetries<0||maxEnoentRetries>10)
  throw new Error('INVALID_WPF_OWNED_PIPE_CALL');
 for(let attempt=0;;attempt++){
  try{return await oneAttempt({pipe,token,sequence,action,extra,timeoutMs});}
  catch(error){
   if(error?.code!=='ENOENT'||attempt>=maxEnoentRetries)throw error;
   // No socket connection took place, hence safe to attempt the same command.
   await onBeforeReconnect();
   await sleep(delayMs);
  }
 }
}
