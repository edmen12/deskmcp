using System;
using System.Collections.Generic;
using System.Windows.Automation;

// Candidate only. No UIA provider is queried unless the caller has already
// passed Guard() with HWND/PID, Desktop2 GUID, WS_EX_NOACTIVATE and an armed
// live switch/foreground observer. Metadata only: NEVER read ValuePattern.Value.
internal static partial class DirectUia
{
    private const int MaxVisitedControls = 128;
    private const int MaxReturnedControls = 32;
    private const int MaxDepth = 12;

    private sealed record SemanticRow(
        string automationId, string controlType, string className,
        bool canSetValue, bool canScrollTopBottom);

    private static object InspectTree(IntPtr hwnd, int ownerPid, Action guard)
    {
        guard();
        AutomationElement root = AutomationElement.FromHandle(hwnd)
            ?? throw new InvalidOperationException("UIA_TREE_ROOT_UNAVAILABLE");
        if (root.Current.ProcessId != ownerPid)
            throw new InvalidOperationException("UIA_TREE_ROOT_PROCESS_MISMATCH");
        TreeWalker walker = TreeWalker.ControlViewWalker;
        Queue<(AutomationElement element, int depth)> queue = new();
        queue.Enqueue((root, 0));
        List<SemanticRow> results = new();
        HashSet<string> seen = new(StringComparer.Ordinal);
        int visited = 0;
        while (queue.Count > 0)
        {
            if (++visited > MaxVisitedControls)
                throw new InvalidOperationException("UIA_SNAPSHOT_NODE_BUDGET_EXCEEDED");
            guard();
            (AutomationElement element, int depth) = queue.Dequeue();
            AutomationElement.AutomationElementInformation info = element.Current;
            if (info.ProcessId != ownerPid)
                throw new InvalidOperationException("UIA_SNAPSHOT_FOREIGN_PROCESS_ELEMENT");
            if (depth > 0 && info.IsEnabled && !info.IsOffscreen)
            {
                string id = info.AutomationId;
                if (!String.IsNullOrWhiteSpace(id) && id.Length <= 128
                    && !id.Contains('\0'))
                {
                    // UIA ValuePattern.SetValue stole Desktop1 foreground on real
                    // Desktop2, even with WS_EX_NOACTIVATE. Never advertise an
                    // actionable UIA edit capability or probe ValuePattern here.
                    // Native Win32 Edit lives in a separate guarded HWND transport.
                    const bool canSet = false;
                    // Even read-only ScrollPattern discovery can invoke
                    // an untrusted provider. Keep metadata-only rows; do
                    // not suggest an actionable UIA scroll capability.
                    const bool canScroll = false;
                    // A duplicate AutomationId may target the wrong
                    // control; fail the entire snapshot, never guess.
                    if (!seen.Add(id))
                        throw new InvalidOperationException("UIA_SNAPSHOT_DUPLICATE_AUTOMATION_ID");
                    if (results.Count >= MaxReturnedControls)
                        throw new InvalidOperationException("UIA_SNAPSHOT_CONTROL_BUDGET_EXCEEDED");
                    results.Add(new SemanticRow(
                        id, info.ControlType.ProgrammaticName, info.ClassName,
                        canSet, canScroll));
                }
            }
            // Stop at the first untraversable depth; do not imply unique
            // AutomationId if descendants remain unexamined.
            AutomationElement? child = walker.GetFirstChild(element);
            if (child != null && depth >= MaxDepth)
                throw new InvalidOperationException("UIA_SNAPSHOT_DEPTH_BUDGET_EXCEEDED");
            while (child != null)
            {
                if (queue.Count + visited >= MaxVisitedControls)
                    throw new InvalidOperationException("UIA_SNAPSHOT_NODE_BUDGET_EXCEEDED");
                queue.Enqueue((child, depth + 1));
                guard();
                child = walker.GetNextSibling(child);
            }
        }
        guard();
        return new {
            operation = "inspect-tree",
            hwnd = hwnd.ToInt64(),
            processId = ownerPid,
            controls = results,
            scannedNodes = visited,
            uiaReadbackConfirmed = false,
            appEventConfirmed = false
        };
    }
}
