using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

// Headless integration test of the exact Windows named-pipe framing and
// the same command validator used by the opt-in WPF fixture. No window exists.
internal static class OwnedWpfPipeSelfTest {
 internal static async Task<int> Run(string pipeName,string token) {
  if(!pipeName.StartsWith("deskmcp-d2-wpf-",StringComparison.Ordinal)||
     pipeName.Length>128||token.Length!=64)
   throw new InvalidOperationException("INVALID_HEADLESS_TEST_BINDING");
  using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(18));
  long last=0;
  var accepted=0;
  var denied=0;
  for(int i=0;i<6;i++){
   using var server=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,
     PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
   // Never publish READY until the actual OS pipe endpoint exists.
   if(i==0){Console.WriteLine("WPF_OWNED_PIPE_HEADLESS_READY");Console.Out.Flush();}
   await server.WaitForConnectionAsync(deadline.Token);
   using var reader=new StreamReader(server,Encoding.UTF8,false,4096,true);
   using var writer=new StreamWriter(server,new UTF8Encoding(false),4096,true){AutoFlush=true};
   object reply;
   try{
    var request=OwnedWpfCommandPolicy.Authorize(
      await reader.ReadLineAsync(deadline.Token),token,last);
    last=request.Sequence;
    accepted++;
    reply=new {ok=true,sequence=request.Sequence,action=request.Action};
   }catch(Exception e)when(e is InvalidOperationException or JsonException or KeyNotFoundException){
    denied++;
    reply=new {ok=false,error=e.Message};
   }
   await writer.WriteLineAsync(JsonSerializer.Serialize(reply).AsMemory(),deadline.Token);
  }
  if(accepted!=3||denied!=3||last!=3)
   throw new Exception("WPF_PIPE_HEADLESS_ACCEPT_REJECT_COUNT_MISMATCH");
  Console.WriteLine("WPF_OWNED_PIPE_HEADLESS_PASS accepted="+accepted+" denied="+denied);
  return 0;
 }
}
