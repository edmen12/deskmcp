using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

// Candidate-only bounded HWND button transport. No UIAutomation provider,
// no SendInput, no foreground activation, no clipboard, no retry.
internal static class NativeButton
{
    private const uint BmClick=0x00F5;
    private const uint SmtoAbortIfHung=0x0002, SmtoBlock=0x0001;
    private const int GwlStyle=-16, MaxChildren=128, MaxButtons=32;
    private const uint TimeoutMs=350;
    private delegate bool ChildProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr hwnd,ChildProc callback,IntPtr data);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd,uint type);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="GetClassNameW")]
    private static extern int GetClassName(IntPtr hwnd,StringBuilder builder,int count);
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",SetLastError=true)]
    private static extern IntPtr SendMessageTimeout(
      IntPtr hwnd,uint message,IntPtr wParam,IntPtr lParam,uint flags,uint timeout,out IntPtr result);

    private static string Class(IntPtr hwnd) {
        StringBuilder text=new(256);
        if(GetClassName(hwnd,text,text.Capacity)<=0)
            throw new InvalidOperationException("NATIVE_BUTTON_CLASS_MISSING");
        return text.ToString();
    }
    private static bool IsButtonClass(string className)=>
        className.Equals("Button",StringComparison.OrdinalIgnoreCase)
        || className.StartsWith("WindowsForms10.Button.",StringComparison.OrdinalIgnoreCase);

    private static string VerifiedChild(IntPtr root,IntPtr child,int pid) {
        if(child==IntPtr.Zero || child==root || !IsWindow(root) || !IsWindow(child)
            || GetAncestor(child,2)!=root || !IsWindowVisible(child) || !IsWindowEnabled(child))
            throw new InvalidOperationException("NATIVE_BUTTON_ROOT_OR_VISIBLE_ENABLED_INVALID");
        GetWindowThreadProcessId(root,out uint parentPid);
        GetWindowThreadProcessId(child,out uint childPid);
        if(parentPid!=(uint)pid || childPid!=parentPid)
            throw new InvalidOperationException("NATIVE_BUTTON_CHILD_PROCESS_MISMATCH");
        string className=Class(child);
        if(!IsButtonClass(className))
            throw new InvalidOperationException("NATIVE_BUTTON_CLASS_NOT_ALLOWLISTED");
        // Only momentary PUSHBUTTON=0/DEFPUSHBUTTON=1, never checkbox,
        // radio, owner-drawn or group box, which have different semantics.
        long type=GetWindowLongPtr(child,GwlStyle).ToInt64()&0xF;
        if(type!=0 && type!=1)
            throw new InvalidOperationException("NATIVE_BUTTON_STYLE_NOT_PUSHBUTTON");
        return className;
    }
    private static List<(IntPtr hwnd,string name)> Children(IntPtr root,int pid,Action guard,out int scanned) {
        List<IntPtr> candidates=new();
        int examined=0;bool overflow=false;
        guard();
        if(!EnumChildWindows(root,(child,_)=>{
            if(++examined>MaxChildren){overflow=true;return false;}
            if(IsWindow(child)) {
                StringBuilder name=new(256);
                if(GetClassName(child,name,name.Capacity)>0 && IsButtonClass(name.ToString())){
                    if(candidates.Count>=MaxButtons){overflow=true;return false;}
                    candidates.Add(child);
                }
            }
            return true;
        },IntPtr.Zero) && !overflow)
            throw new InvalidOperationException("NATIVE_BUTTON_ENUMERATE_FAILED");
        guard();
        if(overflow)
            throw new InvalidOperationException("NATIVE_BUTTON_ENUMERATION_BUDGET_EXCEEDED");
        scanned=examined;
        List<(IntPtr hwnd,string name)> accepted=new();
        foreach(IntPtr child in candidates){
            guard();
            try{accepted.Add((child,VerifiedChild(root,child,pid)));}
            catch(InvalidOperationException){/* unsupported button not granted a capability */}
        }
        guard();
        return accepted;
    }
    public static object Inspect(IntPtr root,int pid,Action guard) {
        var items=Children(root,pid,guard,out int scanned).Select(row=>new{
            automationId="native-button:"+row.hwnd.ToInt64(),
            controlType="NativeWin32.Button",
            className=row.name,
            canSetValue=false,canScrollTopBottom=false,canSetNativeValue=false,
            canClickNative=true
        }).ToArray();
        guard();
        return new{
            operation="inspect-native-buttons",hwnd=root.ToInt64(),processId=pid,
            scannedNodes=scanned,controls=items,
            uiaReadbackConfirmed=false,appEventConfirmed=false
        };
    }
    public static object Click(IntPtr root,int pid,string capability,Action guard) {
        if(!capability.StartsWith("native-button:",StringComparison.Ordinal)
           || !long.TryParse(capability.AsSpan("native-button:".Length),out long value)
           || value<=0)
            throw new InvalidOperationException("NATIVE_BUTTON_CHILD_CAPABILITY_INVALID");
        IntPtr button=new(value);
        guard();
        var children=Children(root,pid,guard,out _);
        if(children.Count(row=>row.hwnd==button)!=1)
            throw new InvalidOperationException("NATIVE_BUTTON_CAPABILITY_STALE_OR_UNKNOWN");
        VerifiedChild(root,button,pid);
        guard();
        // BM_CLICK can itself fail on an inactive dialog. DO NOT call
        // SetActiveWindow / SetForegroundWindow as Microsoft's workaround.
        // No way to infer Click callback from BM_CLICK return value.
        if(SendMessageTimeout(button,BmClick,IntPtr.Zero,IntPtr.Zero,
              SmtoAbortIfHung|SmtoBlock,TimeoutMs,out _)==IntPtr.Zero)
            throw new InvalidOperationException("NATIVE_BUTTON_BM_CLICK_TIMEOUT_OR_UIPI");
        guard();
        VerifiedChild(root,button,pid);
        guard();
        return new {operation="click-native-button",messageDispatched=true,
            appEventConfirmed=false,foregroundSafetyUnproven=true};
    }
}
