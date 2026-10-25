using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Candidate-only real virtual Desktop2 Win32 ListBox transport.
// No UIA provider, OS mouse/wheel, focus, clipboard or global keyboard.
internal static class NativeList
{
    private const uint LbGetCount=0x018B, LbGetTopIndex=0x018E, LbSetTopIndex=0x0197;
    private const uint Flags=0x0001|0x0002; // SMTO_BLOCK | SMTO_ABORTIFHUNG
    private const int MaxChildren=128, MaxLists=16, MaxItems=512;
    private const long UnsafeStyles=0x0010|0x0020|0x0200|0x2000;
    private delegate bool ChildCallback(IntPtr hwnd,IntPtr data);
    [DllImport("user32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr root,ChildCallback fn,IntPtr data);
    [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")]private static extern IntPtr GetAncestor(IntPtr hwnd,uint kind);
    [DllImport("user32.dll")]private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW",SetLastError=true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
    [DllImport("user32.dll",EntryPoint="GetClassNameW",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern int GetClassName(IntPtr hwnd,StringBuilder target,int max);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",SetLastError=true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint msg,IntPtr a,IntPtr b,
        uint flags,uint timeout,out IntPtr result);
    private static bool IsList(string name)=>name.Equals("ListBox",StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("WindowsForms10.LISTBOX.",StringComparison.OrdinalIgnoreCase);
    private static string Verified(IntPtr root,IntPtr child,int pid)
    {
        if(child==IntPtr.Zero||child==root||!IsWindow(root)||!IsWindow(child)
            ||GetAncestor(child,2)!=root||!IsWindowVisible(child)||!IsWindowEnabled(child))
            throw new InvalidOperationException("NATIVE_LIST_CHILD_NOT_VISIBLE_OWNED");
        GetWindowThreadProcessId(root,out uint rootPid);
        GetWindowThreadProcessId(child,out uint childPid);
        if(rootPid!=(uint)pid||childPid!=rootPid)
            throw new InvalidOperationException("NATIVE_LIST_PID_MISMATCH");
        StringBuilder text=new(256);
        if(GetClassName(child,text,text.Capacity)<=0||!IsList(text.ToString()))
            throw new InvalidOperationException("NATIVE_LIST_CLASS_UNSUPPORTED");
        long styles=GetWindowLongPtr(child,-16).ToInt64();
        if((styles&UnsafeStyles)!=0)
            throw new InvalidOperationException("NATIVE_LIST_OWNERDRAW_MULTICOLUMN_VIRTUAL_DENIED");
        return text.ToString();
    }
    private static List<(IntPtr hwnd,string className)> Children(IntPtr root,int pid,Action guard,out int scanned)
    {
        List<IntPtr> candidates=new();
        int visited=0;bool exceeded=false;
        guard();
        bool complete=EnumChildWindows(root,(child,_)=>{
            if(++visited>MaxChildren){exceeded=true;return false;}
            if(IsWindow(child)){
                StringBuilder name=new(256);
                if(GetClassName(child,name,name.Capacity)>0&&IsList(name.ToString())){
                    if(candidates.Count>=MaxLists){exceeded=true;return false;}
                    candidates.Add(child);
                }
            }
            return true;
        },IntPtr.Zero);
        guard();
        if(exceeded)throw new InvalidOperationException("NATIVE_LIST_ENUMERATION_BUDGET");
        if(!complete)throw new InvalidOperationException("NATIVE_LIST_ENUMERATION_INCOMPLETE");
        scanned=visited;
        List<(IntPtr hwnd,string className)> accepted=new();
        foreach(var child in candidates){
            guard();
            try{accepted.Add((child,Verified(root,child,pid)));}
            catch(InvalidOperationException){/* Unsupported control yields no capability */ }
        }
        guard();
        return accepted;
    }
    private static int Message(IntPtr hwnd,uint message,int argument=0)
    {
        if(SendMessageTimeout(hwnd,message,new IntPtr(argument),IntPtr.Zero,
            Flags,350,out IntPtr value)==IntPtr.Zero)
            throw new InvalidOperationException("NATIVE_LIST_TIMEOUT_OR_UIPI");
        long result=value.ToInt64();
        if(result<int.MinValue||result>int.MaxValue)
            throw new InvalidOperationException("NATIVE_LIST_RESULT_OUT_OF_RANGE");
        return checked((int)result);
    }
    private static (int count,int top) Read(IntPtr child,Action guard)
    {
        guard();
        int count=Message(child,LbGetCount);
        if(count<1||count>MaxItems)throw new InvalidOperationException("NATIVE_LIST_ITEM_COUNT_OUT_OF_BOUNDS");
        int top=Message(child,LbGetTopIndex);
        if(top<0||top>=count)throw new InvalidOperationException("NATIVE_LIST_TOP_INDEX_UNTRUSTED");
        guard();
        return (count,top);
    }
    public static object Inspect(IntPtr root,int pid,Action guard)
    {
        var list=Children(root,pid,guard,out int visited).Select(pair=>new {
            automationId="native-list:"+pair.hwnd.ToInt64(),controlType="NativeWin32.ListBox",
            className=pair.className,canSetValue=false,canScrollTopBottom=false,
            canSetNativeValue=false,canClickNative=false,canScrollNativeList=true
        }).ToArray();
        guard();
        return new {operation="inspect-native-lists",hwnd=root.ToInt64(),
            processId=pid,scannedNodes=visited,controls=list,
            uiaReadbackConfirmed=false,appEventConfirmed=false};
    }
    public static object Scroll(IntPtr root,int pid,string capability,int target,int expectedPrevious,Action guard)
    {
        if(!capability.StartsWith("native-list:",StringComparison.Ordinal)
            ||!long.TryParse(capability.AsSpan("native-list:".Length),out long id)||id<=0
            ||target<0||target>=MaxItems||expectedPrevious<0||expectedPrevious>=MaxItems)
            throw new InvalidOperationException("NATIVE_LIST_CAPABILITY_OR_EXPECTED_INDEX_INVALID");
        IntPtr child=new(id);
        guard();
        var found=Children(root,pid,guard,out _);
        if(found.Count(x=>x.hwnd==child)!=1)
            throw new InvalidOperationException("NATIVE_LIST_CAPABILITY_STALE");
        Verified(root,child,pid);
        var before=Read(child,guard);
        if(before.top!=expectedPrevious||target>=before.count)
            throw new InvalidOperationException("NATIVE_LIST_EXPECTED_TOP_INDEX_MISMATCH");
        if(target==before.top)throw new InvalidOperationException("NATIVE_LIST_NOOP_DENIED");
        guard();Verified(root,child,pid);
        // LB_SETTOPINDEX directly targets the verified Win32 child HWND.
        // There is no SetFocus, SendInput, global wheel or activation fallback.
        if(Message(child,LbSetTopIndex,target)!=0)
            throw new InvalidOperationException("NATIVE_LIST_SETTOPINDEX_FAILED");
        guard();Verified(root,child,pid);
        var after=Read(child,guard);
        if(after.top!=target||after.count!=before.count)
            throw new InvalidOperationException("NATIVE_LIST_TOP_INDEX_READBACK_MISMATCH");
        Thread.Sleep(80);
        guard();
        if(Read(child,guard).top!=target)
            throw new InvalidOperationException("NATIVE_LIST_EXTRA_SCROLL_AFTER_SETTLE");
        return new {operation="scroll-native-list",topIndexReadbackConfirmed=true,
            appEventConfirmed=false,foregroundSafetyUnproven=true};
    }
}
