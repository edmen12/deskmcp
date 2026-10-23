using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

// Isolated native HWND feasibility test ONLY. Never mutates installed control
// state, changes desktop, foregrounds anything or sends input.
// Owns four offscreen, non-layered static windows; positions them on D2 only
// after Windows reports their exact D2 assignment.
internal static class Program
{
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    private interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr hwnd);
        Guid GetWindowDesktopId(IntPtr hwnd);
        void MoveWindowToDesktop(IntPtr hwnd, ref Guid desktopId);
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetCurrentDesktopNumber();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetDesktopNumberById(Guid id);

    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="CreateWindowExW",
        SetLastError=true)]
    private static extern IntPtr CreateWindowEx(uint exStyle, string cls, string title,
        uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu,
        IntPtr instance, IntPtr param);
    [DllImport("user32.dll",SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter,
        int x,int y,int width,int height,uint flags);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekMessage(out Msg message, IntPtr hwnd,
        uint min,uint max,uint remove);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TranslateMessage(ref Msg message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Msg message);
    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }

    private const uint WsPopup=0x80000000u;
    private const uint SsGrayRect=0x00000005u;
    private const uint WsExNoActivate=0x08000000u;
    private const uint WsExTopmost=0x00000008u;
    private const uint WsExTransparent=0x00000020u;
    private const uint SwpNoActivate=0x0010u;
    private const uint SwpShowWindow=0x0040u;

    private static Guid BoundD2(string file)
    {
        using JsonDocument document=JsonDocument.Parse(File.ReadAllText(file));
        var bindings=document.RootElement.GetProperty("bindings");
        if(bindings.GetArrayLength()!=1 || bindings[0].GetProperty("desktopNumber").GetInt32()!=2)
            throw new InvalidOperationException("REQUIRES_ONE_EXACT_D2_BINDING");
        Guid id=Guid.Parse(bindings[0].GetProperty("desktopId").GetString()!);
        if(id==Guid.Empty) throw new InvalidOperationException("INVALID_D2_ID");
        return id;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if(args.Length!=4 || args[3]!="NATIVE_EDGE_FIXTURE_READ_ONLY" ||
           !int.TryParse(args[2],out int seconds) || seconds<10 || seconds>75)
            return 9;
        var windows=new List<IntPtr>();
        IntPtr dll=IntPtr.Zero;
        IVirtualDesktopManager? desktop=null;
        try
        {
            Guid target=BoundD2(args[0]);
            dll=NativeLibrary.Load(Path.GetFullPath(args[1]));
            var current=Marshal.GetDelegateForFunctionPointer<GetCurrentDesktopNumber>(
                NativeLibrary.GetExport(dll,"GetCurrentDesktopNumber"));
            var index=Marshal.GetDelegateForFunctionPointer<GetDesktopNumberById>(
                NativeLibrary.GetExport(dll,"GetDesktopNumberById"));
            if(current()!=0 || index(target)!=1) throw new InvalidOperationException("D1_D2_IDENTITY_PRECHECK_FAILED");
            desktop=(IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(
                new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"),true)!)!;
            for(int i=0;i<4;i++)
            {
                var hwnd=CreateWindowEx(WsExNoActivate|WsExTopmost|WsExTransparent,
                    "STATIC","DeskMCP SELF-OWNED NATIVE EDGE TEST", WsPopup|SsGrayRect,
                    -20000,-20000,10,10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
                if(hwnd==IntPtr.Zero) throw new InvalidOperationException("NATIVE_HWND_CREATION_FAILED");
                windows.Add(hwnd);
                ShowWindow(hwnd,4); // SW_SHOWNOACTIVATE, offscreen
            }
            Thread.Sleep(175);
            if(current()!=0) throw new InvalidOperationException("OWNER_DESKTOP_CHANGED_PREMOVE");
            foreach(IntPtr hwnd in windows)
            {
                desktop.MoveWindowToDesktop(hwnd,ref target);
                if(desktop.GetWindowDesktopId(hwnd)!=target || desktop.IsWindowOnCurrentVirtualDesktop(hwnd))
                    throw new InvalidOperationException("OFFSCREEN_NATIVE_WINDOW_VDA_MOVE_FAILED");
            }
            int left=GetSystemMetrics(76),top=GetSystemMetrics(77);
            int width=GetSystemMetrics(78),height=GetSystemMetrics(79);
            if(width<100 || height<100) throw new InvalidOperationException("INVALID_SCREEN_GEOMETRY");
            int t=7;
            var bounds=new (int x,int y,int w,int h)[] {
                (left,top,width,t),(left,top+height-t,width,t),
                (left,top,t,height),(left+width-t,top,t,height)
            };
            for(int i=0;i<4;i++)
            {
                var b=bounds[i];
                if(!SetWindowPos(windows[i],new IntPtr(-1),b.x,b.y,b.w,b.h,SwpNoActivate|SwpShowWindow))
                    throw new InvalidOperationException("WINDOW_POSITION_FAILED");
            }
            var timer=Stopwatch.StartNew();
            int polls=0,observedIssues=0;
            while(timer.Elapsed.TotalSeconds < seconds)
            {
                if(current()!=0) throw new InvalidOperationException("OWNER_DESKTOP_CHANGED_ABORT");
                while(PeekMessage(out var message,IntPtr.Zero,0,0,1))
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
                polls++;
                int[] bad=new int[4];
                for(int i=0;i<4;i++)
                {
                    try
                    {
                        var actual=desktop.GetWindowDesktopId(windows[i]);
                        bad[i]=actual==target && !desktop.IsWindowOnCurrentVirtualDesktop(windows[i])?0:
                            actual==Guid.Empty?2:1;
                    }
                    catch(COMException){bad[i]=3;}
                }
                if(bad.Any(n=>n!=0))
                {
                    observedIssues++;
                    Console.WriteLine(JsonSerializer.Serialize(new{
                        result="NATIVE_EDGE_AFFINITY_FAILED",elapsed_ms=timer.ElapsedMilliseconds,
                        polls,bad,owner_desktop1=true
                    }));
                    return 2;
                }
                Thread.Sleep(90);
            }
            Console.WriteLine(JsonSerializer.Serialize(new{
                result="NATIVE_EDGE_AFFINITY_STABLE",elapsed_ms=timer.ElapsedMilliseconds,
                polls,owner_desktop1=true,layered=false,
                no_focus_or_input=true
            }));
            return 0;
        }
        catch(Exception error)
        {
            Console.Error.WriteLine("NATIVE_EDGE_FIXTURE_FAILED "+error.GetType().Name+" "+error.Message);
            return 5;
        }
        finally
        {
            // Always destroy exactly this process's HWNDs, never enumerate/end other programs.
            foreach(IntPtr hwnd in windows) try { DestroyWindow(hwnd); } catch {}
            if(desktop!=null && Marshal.IsComObject(desktop)) Marshal.FinalReleaseComObject(desktop);
            if(dll!=IntPtr.Zero) NativeLibrary.Free(dll);
        }
    }
}
