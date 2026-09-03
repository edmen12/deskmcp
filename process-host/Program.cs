using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace DeskMCP.ProcessHost;

internal static class Program
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NEW_CONSOLE = 0x00000010;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint INFINITE = 0xFFFFFFFF;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    public static int Main(string[] args)
    {
        IntPtr parentHandle = IntPtr.Zero;
        IntPtr jobHandle = IntPtr.Zero;
        IntPtr childProcessHandle = IntPtr.Zero;
        IntPtr childThreadHandle = IntPtr.Zero;
        IntPtr jobInfoBuffer = IntPtr.Zero;

        try
        {
            ParseArguments(args, out string shell, out string command, out string windowMode);
            int parentPid = GetParentProcessId(Environment.ProcessId);
            if (parentPid <= 0)
                throw new InvalidOperationException("Could not resolve the owning terminal process.");

            parentHandle = OpenProcess(SYNCHRONIZE, false, parentPid);
            if (parentHandle == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open the owning terminal process.");

            jobHandle = CreateJobObjectW(IntPtr.Zero, null);
            if (jobHandle == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the DeskMCP process job.");

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int jobInfoSize = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            jobInfoBuffer = Marshal.AllocHGlobal(jobInfoSize);
            Marshal.StructureToPtr(limits, jobInfoBuffer, false);
            if (!SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation, jobInfoBuffer, (uint)jobInfoSize))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not configure the DeskMCP process job.");

            string applicationPath = ResolveShellPath(shell);
            string commandLine = BuildShellCommandLine(applicationPath, shell, command);
            STARTUPINFO startup = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>() };
            uint creationFlags = CREATE_SUSPENDED;
            if (windowMode == "visible")
            {
                creationFlags |= CREATE_NEW_CONSOLE;
            }
            else
            {
                creationFlags |= CREATE_NO_WINDOW;
                startup.dwFlags = STARTF_USESTDHANDLES;
                startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
                startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
                startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            }

            if (!CreateProcessW(
                applicationPath,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                creationFlags,
                IntPtr.Zero,
                null,
                ref startup,
                out PROCESS_INFORMATION processInfo))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start the owned DeskMCP process.");
            }

            childProcessHandle = processInfo.hProcess;
            childThreadHandle = processInfo.hThread;

            if (!AssignProcessToJobObject(jobHandle, childProcessHandle))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(childProcessHandle, 1);
                throw new Win32Exception(error, "Could not attach the owned process to the DeskMCP job.");
            }

            if (ResumeThread(childThreadHandle) == 0xFFFFFFFF)
            {
                int error = Marshal.GetLastWin32Error();
                TerminateJobObject(jobHandle, 1);
                throw new Win32Exception(error, "Could not resume the owned DeskMCP process.");
            }

            CloseHandle(childThreadHandle);
            childThreadHandle = IntPtr.Zero;

            IntPtr[] waitHandles = { childProcessHandle, parentHandle };
            uint waitResult = WaitForMultipleObjects((uint)waitHandles.Length, waitHandles, false, INFINITE);
            if (waitResult == WAIT_FAILED)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Waiting for the owned process failed.");

            if (waitResult == WAIT_OBJECT_0)
            {
                if (!GetExitCodeProcess(childProcessHandle, out uint exitCode))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read the owned process exit code.");

                // Closing a KILL_ON_JOB_CLOSE job also removes any descendants that
                // outlived the root command. Owned DeskMCP sessions cannot daemonize.
                CloseHandle(jobHandle);
                jobHandle = IntPtr.Zero;
                return unchecked((int)exitCode);
            }

            if (waitResult == WAIT_OBJECT_0 + 1)
            {
                // Desktop Commander lost or terminated the outer terminal session.
                // Kill the kernel-owned job immediately so descendants cannot orphan.
                TerminateJobObject(jobHandle, 1);
                return 1;
            }

            throw new InvalidOperationException("Unexpected process wait result: " + waitResult);
        }
        catch (Exception error)
        {
            try { Console.Error.WriteLine("DeskMCP process host failed: " + error.Message); } catch { }
            return 1;
        }
        finally
        {
            if (jobInfoBuffer != IntPtr.Zero) Marshal.FreeHGlobal(jobInfoBuffer);
            if (childThreadHandle != IntPtr.Zero) CloseHandle(childThreadHandle);
            if (childProcessHandle != IntPtr.Zero) CloseHandle(childProcessHandle);
            if (parentHandle != IntPtr.Zero) CloseHandle(parentHandle);
            if (jobHandle != IntPtr.Zero) CloseHandle(jobHandle);
        }
    }

    private static void ParseArguments(string[] args, out string shell, out string command, out string windowMode)
    {
        string? shellValue = null;
        string? command64 = null;
        string? windowModeValue = null;
        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] == "--shell" && index + 1 < args.Length) shellValue = args[++index];
            else if (args[index] == "--command64" && index + 1 < args.Length) command64 = args[++index];
            else if (args[index] == "--window-mode" && index + 1 < args.Length) windowModeValue = args[++index];
            else throw new ArgumentException("Unknown or incomplete process-host argument.");
        }

        shell = (shellValue ?? "cmd.exe").ToLowerInvariant();
        if (shell != "cmd.exe" && shell != "powershell.exe")
            throw new ArgumentException("Unsupported process shell.");
        if (String.IsNullOrWhiteSpace(command64))
            throw new ArgumentException("Missing encoded process command.");
        windowMode = (windowModeValue ?? "hidden").ToLowerInvariant();
        if (windowMode != "hidden" && windowMode != "visible")
            throw new ArgumentException("Unsupported process window mode.");

        try { command = Encoding.UTF8.GetString(Convert.FromBase64String(command64)); }
        catch (FormatException) { throw new ArgumentException("Invalid encoded process command."); }
        if (String.IsNullOrWhiteSpace(command)) throw new ArgumentException("Process command is empty.");
    }

    private static string ResolveShellPath(string shell)
    {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if (shell == "powershell.exe")
            return System.IO.Path.Combine(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        string? comspec = Environment.GetEnvironmentVariable("COMSPEC");
        return String.IsNullOrWhiteSpace(comspec)
            ? System.IO.Path.Combine(windows, "System32", "cmd.exe")
            : comspec;
    }

    private static string BuildShellCommandLine(string applicationPath, string shell, string command)
    {
        string quotedApplication = QuoteWindowsArgument(applicationPath);
        if (shell == "powershell.exe")
        {
            string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(command));
            return quotedApplication + " -EncodedCommand " + encoded;
        }
        return quotedApplication + " /d /c " + command;
    }

    private static string QuoteWindowsArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static int GetParentProcessId(int processId)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not inspect the process tree.");
        try
        {
            PROCESSENTRY32 entry = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
            if (!Process32FirstW(snapshot, ref entry))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not enumerate the process tree.");
            do
            {
                if (entry.th32ProcessID == (uint)processId) return unchecked((int)entry.th32ParentProcessID);
                entry.dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>();
            } while (Process32NextW(snapshot, ref entry));
        }
        finally { CloseHandle(snapshot); }
        return -1;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string? lpName);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForMultipleObjects(uint nCount, IntPtr[] lpHandles, bool bWaitAll, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessW(string? lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string? lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
}
