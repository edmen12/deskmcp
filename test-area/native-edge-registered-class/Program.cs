using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

// Standalone native Win32 HWND experiment. No DeskMCP lease or control-state writes.
// This process owns the class, HWND, message pump, and cleanup. Never switches
// virtual desktops, activates/focuses a window, or sends input. Window remains
// completely offscreen even when safely bound to real Desktop2.
internal static class Program
{
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    private interface IVirtualDesktopManager {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr hwnd);
        Guid GetWindowDesktopId(IntPtr hwnd);
        void MoveWindowToDesktop(IntPtr hwnd, ref Guid desktopId);
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetCurrentDesktopNumber();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int GetDesktopNumberById(Guid id);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct WndClassEx {
        public uint cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszClassName;
        public IntPtr hIconSm;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Msg {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public Point pt;
        public uint lPrivate;
    }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, EntryPoint="GetModuleHandleW")]
    private static extern IntPtr GetModuleHandle(string? module);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="RegisterClassExW", SetLastError=true)]
    private static extern ushort RegisterClassEx(ref WndClassEx cls);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="UnregisterClassW", SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnregisterClass(string name,IntPtr instance);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="CreateWindowExW", SetLastError=true)]
    private static extern IntPtr CreateWindowEx(uint ex, string cls, string title,
        uint style, int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr inst,IntPtr param);
    [DllImport("user32.dll", EntryPoint="DefWindowProcW")]
    private static extern IntPtr DefWindowProc(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
    [DllImport("user32.dll")]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("user32.dll")]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekMessage(out Msg msg,IntPtr hwnd,uint min,uint max,uint remove);
    [DllImport("user32.dll")]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool TranslateMessage(ref Msg msg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Msg msg);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd,int attr,out int value,int size);

    private const uint WsOverlappedWindow=0x00CF0000u;
    private const uint WsPopup=0x80000000u;
    private const uint WsExNoActivate=0x08000000u;
    private const uint WsExTopmost=0x00000008u;
    private const uint WsExTransparent=0x00000020u;
    private static readonly WndProc Callback=(h,m,w,l)=>DefWindowProc(h,m,w,l);
    private static void Pump()
    {
        while(PeekMessage(out var msg,IntPtr.Zero,0,0,1)) {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }
    private static Guid D2(string path)
    {
        using JsonDocument parsed=JsonDocument.Parse(File.ReadAllText(path));
        var bindings=parsed.RootElement.GetProperty("bindings");
        if(bindings.GetArrayLength()!=1 || bindings[0].GetProperty("desktopNumber").GetInt32()!=2)
            throw new InvalidOperationException("ONE_D2_BINDING_REQUIRED");
        var result=Guid.Parse(bindings[0].GetProperty("desktopId").GetString()!);
        if(result==Guid.Empty) throw new InvalidOperationException("D2_ID_EMPTY");
        return result;
    }
    private static string Affinity(IVirtualDesktopManager vda,IntPtr hwnd,Guid d2)
    {
        try {
            Guid actual=vda.GetWindowDesktopId(hwnd);
            return actual==d2
                ? vda.IsWindowOnCurrentVirtualDesktop(hwnd) ? "on_owner_desktop" : "correct_d2"
                : actual==Guid.Empty ? "guid_empty" : "wrong_desktop";
        } catch(COMException ex) {
            return "com_hresult_0x"+unchecked((uint)ex.ErrorCode).ToString("X8");
        } catch {return "query_failed";}
    }
    [STAThread]
    private static int Main(string[] args)
    {
        if(args.Length!=4 || (args[0]!="overlapped" && args[0]!="popup")
           || !int.TryParse(args[1],out int seconds) || seconds<10 || seconds>90)
            return 9;
        string className="DeskMCPNativeRegisteredEdgeTest";
        IntPtr dll=IntPtr.Zero, window=IntPtr.Zero;
        bool registered=false;
        IntPtr instance=GetModuleHandle(null);
        IVirtualDesktopManager? manager=null;
        try
        {
            Guid target=D2(args[2]);
            dll=NativeLibrary.Load(Path.GetFullPath(args[3]));
            var current=Marshal.GetDelegateForFunctionPointer<GetCurrentDesktopNumber>(
                NativeLibrary.GetExport(dll,"GetCurrentDesktopNumber"));
            var targetIndex=Marshal.GetDelegateForFunctionPointer<GetDesktopNumberById>(
                NativeLibrary.GetExport(dll,"GetDesktopNumberById"));
            if(current()!=0 || targetIndex(target)!=1)
                throw new InvalidOperationException("D1_D2_PRECHECK_FAILED");

            WndClassEx cls=new() {
                cbSize=(uint)Marshal.SizeOf<WndClassEx>(),
                lpfnWndProc=Marshal.GetFunctionPointerForDelegate(Callback),
                hInstance=instance,lpszClassName=className
            };
            if(RegisterClassEx(ref cls)==0)
                throw new InvalidOperationException("REGISTER_CLASS_FAILED_"+Marshal.GetLastWin32Error());
            registered=true;
            uint ex=WsExNoActivate|WsExTopmost|WsExTransparent;
            uint style=args[0]=="overlapped" ? WsOverlappedWindow : WsPopup;
            window=CreateWindowEx(ex,className,"DeskMCP OWNED OFFSCREEN D2 TEST",style,
                -20000,-20000,24,24,IntPtr.Zero,IntPtr.Zero,instance,IntPtr.Zero);
            if(window==IntPtr.Zero)
                throw new InvalidOperationException("CREATE_WINDOW_FAILED_"+Marshal.GetLastWin32Error());
            var originalForeground=GetForegroundWindow();
            ShowWindow(window,4); // SW_SHOWNOACTIVATE, still offscreen.
            manager=(IVirtualDesktopManager)Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"),true)!)!;
            Stopwatch bootstrap=Stopwatch.StartNew();
            while(bootstrap.ElapsedMilliseconds<350) {Pump();Thread.Sleep(20);}
            if(current()!=0 || !IsWindow(window))
                throw new InvalidOperationException("OWNER_OR_OWNED_HWND_MISSING_BEFORE_MOVE");
            string before=Affinity(manager,window,target);
            // Move this process's single, non-layered offscreen HWND only.
            // Any failure = fail closed, never treat as a ready D2 window.
            manager.MoveWindowToDesktop(window,ref target);
            Stopwatch verified=Stopwatch.StartNew();
            int polls=0; int initialCloak=-1; int finalCloak=-1;
            while(verified.ElapsedMilliseconds<seconds*1000L)
            {
                Pump();
                polls++;
                int owner=current();
                string state=Affinity(manager,window,target);
                int cloakHr=DwmGetWindowAttribute(window,14,out int cloak,4);
                finalCloak=cloakHr==0 ? cloak : -1;
                if(polls==1) initialCloak=finalCloak;
                bool stolen=GetForegroundWindow()==window && originalForeground!=window;
                if(owner!=0 || state!="correct_d2" || stolen)
                {
                    Console.WriteLine(JsonSerializer.Serialize(new {
                        status="NATIVE_REGISTERED_AFFINITY_FAILED",mode=args[0],
                        initial_state=before,elapsed_ms=verified.ElapsedMilliseconds,
                        polls,affinity=state,owner_desktop1=owner==0,
                        foreground_stolen=stolen,dwm_cloaked=finalCloak
                    }));
                    return 2;
                }
                Thread.Sleep(50);
            }
            Console.WriteLine(JsonSerializer.Serialize(new {
                status="NATIVE_REGISTERED_AFFINITY_STABLE",mode=args[0],
                initial_state=before,elapsed_ms=verified.ElapsedMilliseconds,polls,
                initial_cloak=initialCloak,last_cloak=finalCloak,
                owner_desktop1=true,window_offscreen=true,window_layered=false,
                no_input_or_activation=true
            }));
            return 0;
        }
        catch(Exception ex)
        {
            Console.Error.WriteLine("NATIVE_REGISTERED_BLOCKED "+ex.GetType().Name+" "+ex.Message);
            return 5;
        }
        finally
        {
            if(window!=IntPtr.Zero) try{DestroyWindow(window);}catch{}
            if(manager!=null && Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
            if(registered)try{UnregisterClass(className,instance);}catch{}
            if(dll!=IntPtr.Zero)NativeLibrary.Free(dll);
            GC.KeepAlive(Callback);
        }
    }
}
