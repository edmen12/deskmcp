// Own-child cleanup only. Never discover a process by name, kill an
// unrelated process, call taskkill, or terminate arbitrary PID/process trees.
export async function terminateOwnedChild(child,{deadlineMs=2000}={}) {
 if(child==null)return true;
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<25||deadlineMs>3000)
  throw Error('OWNED_CHILD_CLEANUP_DEADLINE_INVALID');
 if(child.exitCode!==null||child.signalCode!==null)return true;
 if(typeof child.once!=='function'||typeof child.off!=='function'
   ||typeof child.kill!=='function')throw Error('OWNED_CHILD_HANDLE_INVALID');
 return new Promise(resolve=>{
   let done=false;
   const finish=value=>{
     if(done)return;
     done=true;
     clearTimeout(timer);
     child.off('exit',exited);
     resolve(value);
   };
   const exited=()=>finish(true);
   const timer=setTimeout(()=>finish(false),deadlineMs);
   child.once('exit',exited);
   try{
     if(child.exitCode!==null||child.signalCode!==null){
       finish(true);return;
     }
     if(!child.kill())finish(false);
   }catch{finish(false);}
 });
}
