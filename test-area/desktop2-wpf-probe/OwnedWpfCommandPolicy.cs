using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Executes no Windows UI calls and can be tested on a headless Windows host.
// This protects ONLY the opt-in, app-owned WPF fixture pipe, not external apps.
internal static class OwnedWpfCommandPolicy {
 internal readonly record struct Parsed(long Sequence,string Action,string? Expected,string? Value);
 internal static Parsed Authorize(string? line,string token,long lastSequence) {
  if(line is null||line.Length<2||line.Length>4096)
   throw new InvalidOperationException("INVALID_COMMAND_LENGTH");
  using var json=JsonDocument.Parse(line);
  var root=json.RootElement;
  if(root.ValueKind!=JsonValueKind.Object)
   throw new InvalidOperationException("INVALID_COMMAND_OBJECT");
  var names=new HashSet<string>(StringComparer.Ordinal);
  foreach(var property in root.EnumerateObject()){
   if(!names.Add(property.Name)||property.Name is not ("token" or "sequence" or "action" or "expected" or "value"))
    throw new InvalidOperationException("UNKNOWN_OR_DUPLICATED_COMMAND_FIELD");
  }
  var given=root.GetProperty("token").GetString()??"";
  // No token text appears in errors or result logs.
  if(given.Length!=token.Length||
     !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(given),
                                              Encoding.UTF8.GetBytes(token)))
   throw new InvalidOperationException("INVALID_FIXTURE_CAPABILITY");
  var sequence=root.GetProperty("sequence").GetInt64();
  if(lastSequence==long.MaxValue||sequence!=lastSequence+1)
   throw new InvalidOperationException("STALE_OR_REPLAYED_COMMAND");
  var action=root.GetProperty("action").GetString()??"";
  if(action is not ("edit" or "button" or "scroll"))
   throw new InvalidOperationException("UNSUPPORTED_APP_OWNED_ACTION");
  var hasBefore=root.TryGetProperty("expected",out var old);
  var hasValue=root.TryGetProperty("value",out var requested);
  if(action=="edit"){
   var expected=hasBefore?old.GetString():null;
   var value=hasValue?requested.GetString():null;
   if(expected is null||value is null||expected.Length>128||value.Length>128||
      ContainsControls(expected)||ContainsControls(value))
    throw new InvalidOperationException("STALE_OR_INVALID_EDIT");
   return new Parsed(sequence,action,expected,value);
  }
  if(hasBefore||hasValue)
   throw new InvalidOperationException("UNEXPECTED_NONEDIT_PAYLOAD");
  return new Parsed(sequence,action,null,null);
 }
 static bool ContainsControls(string text){
  foreach(var c in text)if(char.IsControl(c))return true;
  return false;
 }
 internal static int SelfTest() {
  const string token="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  static string Cmd(string cap,long sequence,string action,string? previous=null,string? value=null){
   if(action=="edit")return JsonSerializer.Serialize(new {token=cap,sequence,action,expected=previous,value});
   return JsonSerializer.Serialize(new {token=cap,sequence,action});
  }
  var first=Authorize(Cmd(token,1,"edit","","SAFE"),token,0);
  if(first.Sequence!=1||first.Expected!=""||first.Value!="SAFE")
   throw new Exception("POLICY_VALID_EDIT_FAILED");
  var denied=0;
  void Reject(string input,long prior,string message){
   try{Authorize(input,token,prior);}
   catch(InvalidOperationException error)when(error.Message==message){denied++;return;}
   throw new Exception("POLICY_FAILED_TO_REJECT_"+message);
  }
  Reject(Cmd(new string('b',64),2,"edit","","X"),1,"INVALID_FIXTURE_CAPABILITY");
  Reject(Cmd(token,1,"edit","","X"),1,"STALE_OR_REPLAYED_COMMAND");
  Reject(Cmd(token,3,"button"),1,"STALE_OR_REPLAYED_COMMAND");
  Reject(Cmd(token,2,"inject"),1,"UNSUPPORTED_APP_OWNED_ACTION");
  Reject(Cmd(token,2,"edit",null,"X"),1,"STALE_OR_INVALID_EDIT");
  Reject(Cmd(token,2,"edit","","X\nY"),1,"STALE_OR_INVALID_EDIT");
  Reject(Cmd(token,2,"edit","",new string('Z',129)),1,"STALE_OR_INVALID_EDIT");
  Reject(JsonSerializer.Serialize(new {token,sequence=2,action="button",value="X"}),1,"UNEXPECTED_NONEDIT_PAYLOAD");
  Reject("{\"token\":\""+token+"\",\"sequence\":2,\"sequence\":2,\"action\":\"button\"}",1,
         "UNKNOWN_OR_DUPLICATED_COMMAND_FIELD");
  Reject(JsonSerializer.Serialize(new {token,sequence=2,action="button",unsafeFlag=true}),1,
         "UNKNOWN_OR_DUPLICATED_COMMAND_FIELD");
  Reject("[]",1,"INVALID_COMMAND_OBJECT");
  Reject("",1,"INVALID_COMMAND_LENGTH");
  var next=Authorize(Cmd(token,2,"scroll"),token,1);
  if(next.Sequence!=2||next.Action!="scroll")throw new Exception("POLICY_VALID_SCROLL_FAILED");
  Console.WriteLine("WPF_APP_OWNED_COMMAND_POLICY_SELF_TEST_PASS denied="+denied);
  return 0;
 }
}
