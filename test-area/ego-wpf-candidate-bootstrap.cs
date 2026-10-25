// Candidate-only managed bootstrap for offline WPF test-mode entrypoints.
// Never calls the live Control Panel runtime, gateway, tunnel or UI start mode.
// It only permits explicit existing self-test or offscreen preview arguments.
using System;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;

internal static class CandidateWpfTestBootstrap
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length==0 || !(args[0]=="--agent-desktop-binding-self-test" ||
            args[0]=="--agent-safe-isolation-self-test" ||
            args[0]=="--agent-control-lock-self-test" ||
            args[0]=="--runtime-reliability-self-test" ||
            args[0]=="--capture" ||
            args[0]=="--hud-placement-probe" ||
            args[0]=="--coordinator-isolated-probe"))
        {
            Console.Error.WriteLine("CANDIDATE_WPF_TEST_MODE_ONLY");
            return 2;
        }
        var baseDir=AppContext.BaseDirectory;
        AssemblyLoadContext.Default.Resolving+=(context,assemblyName)=>{
            var candidate=Path.Combine(baseDir,assemblyName.Name+".dll");
            if(!File.Exists(candidate))return null;
            return context.LoadFromAssemblyPath(candidate);
        };
        try
        {
            var path=Path.Combine(baseDir,"DeskMCP.ControlPanel.Candidate.dll");
            var assembly=AssemblyLoadContext.Default.LoadFromAssemblyPath(path);
            if (args[0]=="--hud-placement-probe") return CandidateHudPlacementProbe.Run(assembly,args);
            if (args[0]=="--coordinator-isolated-probe") return CandidateCoordinatorProbe.Run(assembly,args);
            var program=assembly.GetType("Program",true)!;
            var method=program.GetMethod("Main",BindingFlags.NonPublic|BindingFlags.Static)
                ?? throw new InvalidOperationException("No WPF candidate entrypoint.");
            var invoked=method.Invoke(null,new object[]{args});
            return invoked is int exit?exit:3;
        }
        catch(TargetInvocationException error)
        {
            Console.Error.WriteLine("WPF_CANDIDATE_SELFTEST_FAILURE: "+error.InnerException?.GetType().Name+": "+error.InnerException?.Message);
            return 5;
        }
        catch(Exception error)
        {
            Console.Error.WriteLine("WPF_CANDIDATE_BOOT_FAILURE: "+error.GetType().Name+": "+error.Message);
            return 6;
        }
    }
}
