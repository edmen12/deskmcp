using System.Collections;
using System.IO;
using System.Reflection;
using System.Text.Json;

if (args.Length < 2 || (args[0] != "emit" && args[0] != "roundtrip"))
    throw new InvalidOperationException("Expected emit|roundtrip and exact candidate Control Panel assembly.");
var panelAssembly = Assembly.LoadFrom(Path.GetFullPath(args[1]));
Type Resolve(string name) => panelAssembly.GetTypes().Single(type => type.Name == name);
void Set(object target, string prop, object? value) =>
    target.GetType().GetProperty(prop)!.SetValue(target, value);
object? Get(object target, string prop) =>
    target.GetType().GetProperty(prop)!.GetValue(target);
var poolType = Resolve("AgentDesktopControlPoolDocument");
var mutationType = Resolve("AgentDesktopControlMutationDocument");
var controlType = Resolve("AgentDesktopControlDocument");
object pool;
if (args[0] == "emit")
{
    pool = Activator.CreateInstance(poolType, nonPublic:true)!;
    Set(pool, "SchemaVersion", 2);
    Set(pool, "Generation", 21);
    Set(pool, "Controls", Activator.CreateInstance(typeof(List<>).MakeGenericType(controlType)));
    var mutation = Activator.CreateInstance(mutationType, nonPublic:true)!;
    Set(mutation, "Reason", "control_panel_safety_revocation");
    Set(mutation, "Generation", 21);
    Set(mutation, "AtUtc", DateTime.UtcNow.ToString("O"));
    Set(mutation, "BeforeCount", 1);
    Set(mutation, "AfterCount", 0);
    Set(mutation, "WriterPid", Environment.ProcessId);
    Set(pool, "LastMutation", mutation);
    var history = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(mutationType))!;
    history.Add(mutation);
    Set(pool, "RecentMutations", history);
}
else
{
    if (args.Length != 3) throw new InvalidOperationException("roundtrip requires the input JSON path.");
    pool = JsonSerializer.Deserialize(File.ReadAllText(args[2]), poolType)
        ?? throw new InvalidOperationException("Could not deserialize the candidate Gateway document.");
    var mutation = Get(pool, "LastMutation");
    if (mutation is null || Get(mutation, "Reason") as string != "control_panel_shutdown")
        throw new InvalidOperationException("Control Panel did not preserve candidate Gateway mutation.");
    var history = Get(pool, "RecentMutations") as IList;
    if (history is null || history.Count != 1)
        throw new InvalidOperationException("Control Panel discarded candidate Gateway bounded history.");
}
Console.WriteLine(JsonSerializer.Serialize(pool, poolType));
