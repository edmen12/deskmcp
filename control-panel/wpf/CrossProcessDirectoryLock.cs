using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;

internal sealed class CrossProcessDirectoryLockOwnerDocument
{
    [JsonPropertyName("schema_version")]
    public int SchemaVersion { get; set; }
    [JsonPropertyName("pid")]
    public int Pid { get; set; }
    [JsonPropertyName("token")]
    public string Token { get; set; }
    [JsonPropertyName("created_at")]
    public string CreatedAt { get; set; }
}

internal sealed class CrossProcessDirectoryLockTransitionDocument
{
    [JsonPropertyName("schema_version")]
    public int SchemaVersion { get; set; }
    [JsonPropertyName("kind")]
    public string Kind { get; set; }
    [JsonPropertyName("pid")]
    public int Pid { get; set; }
    [JsonPropertyName("token")]
    public string Token { get; set; }
    [JsonPropertyName("expected_owner_pid")]
    public int ExpectedOwnerPid { get; set; }
    [JsonPropertyName("expected_owner_token")]
    public string ExpectedOwnerToken { get; set; }
    [JsonPropertyName("created_at")]
    public string CreatedAt { get; set; }
}

internal enum CrossProcessDirectoryLockState
{
    Missing,
    Initializing,
    Active,
    Stale,
    Invalid
}

internal sealed class CrossProcessDirectoryLockObservedOwner
{
    public CrossProcessDirectoryLockState State { get; set; }
    public CrossProcessDirectoryLockOwnerDocument Owner { get; set; }
}

internal sealed class CrossProcessDirectoryLockObservedTransition
{
    public CrossProcessDirectoryLockState State { get; set; }
    public CrossProcessDirectoryLockTransitionDocument Owner { get; set; }
}

internal sealed class CrossProcessDirectoryLock : IDisposable
{
    private readonly string lockDirectory;
    private readonly string label;
    private readonly int timeoutMs;
    private readonly int initializationGraceMs;
    private readonly int pollMs;
    private readonly CrossProcessDirectoryLockOwnerDocument owner;
    private CrossProcessDirectoryLockTransitionDocument pendingReleaseTransition;
    private bool canonicalRetired;
    private bool released;

    private CrossProcessDirectoryLock(
        string lockDirectory,
        string label,
        int timeoutMs,
        int initializationGraceMs,
        int pollMs,
        CrossProcessDirectoryLockOwnerDocument owner)
    {
        this.lockDirectory = lockDirectory;
        this.label = label;
        this.timeoutMs = timeoutMs;
        this.initializationGraceMs = initializationGraceMs;
        this.pollMs = pollMs;
        this.owner = owner;
    }

    private static string TransitionPath(string lockDirectory)
    {
        return lockDirectory + ".transition";
    }

    private static bool IsUuid(string value)
    {
        Guid parsed;
        return !String.IsNullOrWhiteSpace(value) && Guid.TryParseExact(value, "D", out parsed);
    }

    private static bool IsIsoTimestamp(string value)
    {
        DateTimeOffset parsed;
        return !String.IsNullOrWhiteSpace(value) && DateTimeOffset.TryParse(value, out parsed);
    }

    private static bool OwnerValid(CrossProcessDirectoryLockOwnerDocument owner)
    {
        return owner != null
            && owner.SchemaVersion == 1
            && owner.Pid > 0
            && IsUuid(owner.Token)
            && IsIsoTimestamp(owner.CreatedAt);
    }

    private static bool TransitionValid(CrossProcessDirectoryLockTransitionDocument owner)
    {
        return owner != null
            && owner.SchemaVersion == 1
            && (owner.Kind == "release" || owner.Kind == "reclaim")
            && owner.Pid > 0
            && IsUuid(owner.Token)
            && owner.ExpectedOwnerPid > 0
            && IsUuid(owner.ExpectedOwnerToken)
            && IsIsoTimestamp(owner.CreatedAt);
    }

    private static bool ProcessAlive(int pid)
    {
        try
        {
            using (Process process = Process.GetProcessById(pid))
                return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        catch
        {
            // Access-denied and other inspection failures are treated as alive for safety.
            return true;
        }
    }

    private static FileAttributes? AttributesOrNull(string path)
    {
        try { return File.GetAttributes(path); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    private static bool IsTrustedDirectory(FileAttributes attributes)
    {
        return (attributes & FileAttributes.Directory) != 0
            && (attributes & FileAttributes.ReparsePoint) == 0;
    }

    private static CrossProcessDirectoryLockObservedOwner ObserveOwner(string lockDirectory, int initializationGraceMs)
    {
        FileAttributes? attributes = AttributesOrNull(lockDirectory);
        if (!attributes.HasValue)
            return new CrossProcessDirectoryLockObservedOwner { State = CrossProcessDirectoryLockState.Missing };
        if (!IsTrustedDirectory(attributes.Value))
            return new CrossProcessDirectoryLockObservedOwner { State = CrossProcessDirectoryLockState.Invalid };

        string ownerPath = Path.Combine(lockDirectory, "owner.json");
        CrossProcessDirectoryLockOwnerDocument owner;
        try
        {
            owner = JsonSerializer.Deserialize<CrossProcessDirectoryLockOwnerDocument>(File.ReadAllText(ownerPath));
        }
        catch (FileNotFoundException)
        {
            TimeSpan age = DateTime.UtcNow - Directory.GetLastWriteTimeUtc(lockDirectory);
            return new CrossProcessDirectoryLockObservedOwner
            {
                State = age.TotalMilliseconds < initializationGraceMs
                    ? CrossProcessDirectoryLockState.Initializing
                    : CrossProcessDirectoryLockState.Invalid
            };
        }
        catch (DirectoryNotFoundException)
        {
            return new CrossProcessDirectoryLockObservedOwner { State = CrossProcessDirectoryLockState.Missing };
        }
        catch (JsonException)
        {
            return new CrossProcessDirectoryLockObservedOwner { State = CrossProcessDirectoryLockState.Invalid };
        }
        if (!OwnerValid(owner))
            return new CrossProcessDirectoryLockObservedOwner { State = CrossProcessDirectoryLockState.Invalid };
        return new CrossProcessDirectoryLockObservedOwner
        {
            State = ProcessAlive(owner.Pid) ? CrossProcessDirectoryLockState.Active : CrossProcessDirectoryLockState.Stale,
            Owner = owner
        };
    }

    private static CrossProcessDirectoryLockObservedTransition ObserveTransition(string lockDirectory, int initializationGraceMs)
    {
        string marker = TransitionPath(lockDirectory);
        FileAttributes? attributes = AttributesOrNull(marker);
        if (!attributes.HasValue)
            return new CrossProcessDirectoryLockObservedTransition { State = CrossProcessDirectoryLockState.Missing };
        if (!IsTrustedDirectory(attributes.Value))
            return new CrossProcessDirectoryLockObservedTransition { State = CrossProcessDirectoryLockState.Invalid };

        string ownerPath = Path.Combine(marker, "owner.json");
        CrossProcessDirectoryLockTransitionDocument owner;
        try
        {
            owner = JsonSerializer.Deserialize<CrossProcessDirectoryLockTransitionDocument>(File.ReadAllText(ownerPath));
        }
        catch (FileNotFoundException)
        {
            TimeSpan age = DateTime.UtcNow - Directory.GetLastWriteTimeUtc(marker);
            return new CrossProcessDirectoryLockObservedTransition
            {
                State = age.TotalMilliseconds < initializationGraceMs
                    ? CrossProcessDirectoryLockState.Initializing
                    : CrossProcessDirectoryLockState.Invalid
            };
        }
        catch (DirectoryNotFoundException)
        {
            return new CrossProcessDirectoryLockObservedTransition { State = CrossProcessDirectoryLockState.Missing };
        }
        catch (JsonException)
        {
            return new CrossProcessDirectoryLockObservedTransition { State = CrossProcessDirectoryLockState.Invalid };
        }
        if (!TransitionValid(owner) || !ProcessAlive(owner.Pid))
            return new CrossProcessDirectoryLockObservedTransition { State = CrossProcessDirectoryLockState.Invalid };
        return new CrossProcessDirectoryLockObservedTransition
        {
            State = CrossProcessDirectoryLockState.Active,
            Owner = owner
        };
    }

    private static bool DirectoryPublished(string target)
    {
        return AttributesOrNull(target).HasValue;
    }

    private static void WriteJson(string directory, object value)
    {
        Directory.CreateDirectory(directory);
        string file = Path.Combine(directory, "owner.json");
        using (FileStream stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        using (StreamWriter writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false)))
        {
            writer.Write(JsonSerializer.Serialize(value));
            writer.Write(Environment.NewLine);
            writer.Flush();
            stream.Flush(true);
        }
    }

    private static bool TryPublishDirectory(string target, object owner, string purposeToken)
    {
        string candidate = target + ".init-" + Environment.ProcessId + "-" + purposeToken;
        try
        {
            Directory.CreateDirectory(candidate);
            WriteJson(candidate, owner);
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    Directory.Move(candidate, target);
                    return true;
                }
                catch (IOException)
                {
                    if (DirectoryPublished(target)) return false;
                    if (attempt >= 3) throw;
                }
                catch (UnauthorizedAccessException)
                {
                    if (DirectoryPublished(target)) return false;
                    if (attempt >= 3) throw;
                }
                Thread.Sleep(Math.Min(2 * (1 << attempt), 20));
            }
        }
        finally
        {
            try { if (Directory.Exists(candidate)) Directory.Delete(candidate, true); } catch { }
        }
    }

    private static bool SameOwner(CrossProcessDirectoryLockOwnerDocument left, CrossProcessDirectoryLockOwnerDocument right)
    {
        return left != null && right != null
            && left.Pid == right.Pid
            && String.Equals(left.Token, right.Token, StringComparison.OrdinalIgnoreCase);
    }

    private static void Sleep(int pollMs)
    {
        Thread.Sleep(pollMs);
    }

    private static void WaitForTransitionOrThrow(
        string lockDirectory,
        string label,
        int initializationGraceMs,
        DateTime deadline,
        int pollMs)
    {
        if (DateTime.UtcNow >= deadline)
        {
            CrossProcessDirectoryLockObservedTransition observed = ObserveTransition(lockDirectory, initializationGraceMs);
            if (observed.State == CrossProcessDirectoryLockState.Invalid)
                throw new IOException(label + " lock transition metadata is invalid or abandoned; refusing unsafe automatic takeover.");
            throw new IOException(label + " is busy in another DeskMCP process.");
        }
        Sleep(pollMs);
    }

    private static CrossProcessDirectoryLockTransitionDocument TryCreateTransition(
        string lockDirectory,
        string kind,
        CrossProcessDirectoryLockOwnerDocument expectedOwner)
    {
        string token = Guid.NewGuid().ToString("D");
        CrossProcessDirectoryLockTransitionDocument transition = new CrossProcessDirectoryLockTransitionDocument
        {
            SchemaVersion = 1,
            Kind = kind,
            Pid = Environment.ProcessId,
            Token = token,
            ExpectedOwnerPid = expectedOwner.Pid,
            ExpectedOwnerToken = expectedOwner.Token,
            CreatedAt = DateTimeOffset.UtcNow.ToString("O")
        };
        return TryPublishDirectory(TransitionPath(lockDirectory), transition, token) ? transition : null;
    }

    private static bool TransitionStillOwned(
        string lockDirectory,
        CrossProcessDirectoryLockTransitionDocument transition,
        CrossProcessDirectoryLockOwnerDocument expectedOwner,
        string kind,
        int initializationGraceMs)
    {
        CrossProcessDirectoryLockObservedTransition observed = ObserveTransition(lockDirectory, initializationGraceMs);
        return observed.State == CrossProcessDirectoryLockState.Active
            && observed.Owner != null
            && observed.Owner.Pid == Environment.ProcessId
            && String.Equals(observed.Owner.Token, transition.Token, StringComparison.OrdinalIgnoreCase)
            && observed.Owner.Kind == kind
            && observed.Owner.ExpectedOwnerPid == expectedOwner.Pid
            && String.Equals(observed.Owner.ExpectedOwnerToken, expectedOwner.Token, StringComparison.OrdinalIgnoreCase);
    }

    private static void ReleaseTransition(string lockDirectory, CrossProcessDirectoryLockTransitionDocument transition)
    {
        CrossProcessDirectoryLockObservedTransition observed = ObserveTransition(lockDirectory, 1);
        if (observed.State == CrossProcessDirectoryLockState.Missing)
            throw new IOException("Cross-process lock transition marker disappeared before release.");
        if (observed.Owner == null
            || observed.Owner.Pid != Environment.ProcessId
            || !String.Equals(observed.Owner.Token, transition.Token, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Cross-process lock transition ownership changed before release.");
        DeleteDirectoryWithRetries(TransitionPath(lockDirectory));
    }

    private static void DeleteDirectoryWithRetries(string directory)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                if (Directory.Exists(directory)) Directory.Delete(directory, true);
                return;
            }
            catch (IOException)
            {
                if (attempt >= 7) throw;
            }
            catch (UnauthorizedAccessException)
            {
                if (attempt >= 7) throw;
            }
            Thread.Sleep(Math.Min(10 * (1 << attempt), 200));
        }
    }

    private static void RetireOwnedDirectory(string source, string destination, Func<bool> verifyOwnership, string label)
    {
        for (int attempt = 0; ; attempt++)
        {
            if (!verifyOwnership()) throw new IOException(label + " lock ownership changed before retirement.");
            try
            {
                Directory.Move(source, destination);
                return;
            }
            catch (IOException)
            {
                if (attempt >= 7) throw;
            }
            catch (UnauthorizedAccessException)
            {
                if (attempt >= 7) throw;
            }
            Thread.Sleep(Math.Min(10 * (1 << attempt), 200));
        }
    }

    private static bool ReclaimObservedStaleLock(
        string lockDirectory,
        CrossProcessDirectoryLockOwnerDocument staleOwner,
        int initializationGraceMs,
        string label)
    {
        CrossProcessDirectoryLockTransitionDocument transition = TryCreateTransition(lockDirectory, "reclaim", staleOwner);
        if (transition == null) return false;

        CrossProcessDirectoryLockObservedOwner rechecked = ObserveOwner(lockDirectory, initializationGraceMs);
        bool sameStaleOwner = rechecked.State == CrossProcessDirectoryLockState.Stale && SameOwner(rechecked.Owner, staleOwner);
        if (!sameStaleOwner)
        {
            ReleaseTransition(lockDirectory, transition);
            return rechecked.State == CrossProcessDirectoryLockState.Missing;
        }

        string retired = lockDirectory + ".reclaim-" + Environment.ProcessId + "-" + transition.Token;
        try
        {
            RetireOwnedDirectory(
                lockDirectory,
                retired,
                delegate
                {
                    CrossProcessDirectoryLockObservedOwner current = ObserveOwner(lockDirectory, initializationGraceMs);
                    return current.State == CrossProcessDirectoryLockState.Stale
                        && SameOwner(current.Owner, staleOwner)
                        && TransitionStillOwned(lockDirectory, transition, staleOwner, "reclaim", initializationGraceMs);
                },
                label + " stale recovery");
            DeleteDirectoryWithRetries(retired);
        }
        catch (Exception error)
        {
            try { ReleaseTransition(lockDirectory, transition); }
            catch (Exception releaseError) { throw new AggregateException(label + " stale recovery failed and transition release also failed.", error, releaseError); }
            throw;
        }
        ReleaseTransition(lockDirectory, transition);
        return true;
    }

    public static CrossProcessDirectoryLock Acquire(
        string lockDirectory,
        string label,
        int timeoutMs = 5000,
        int initializationGraceMs = 5000,
        int pollMs = 30)
    {
        if (String.IsNullOrWhiteSpace(lockDirectory)) throw new ArgumentException("Lock directory is required.", nameof(lockDirectory));
        if (String.IsNullOrWhiteSpace(label)) throw new ArgumentException("Lock label is required.", nameof(label));
        if (timeoutMs < 1 || timeoutMs > 60000) throw new ArgumentOutOfRangeException(nameof(timeoutMs));
        if (initializationGraceMs < 1 || initializationGraceMs > 60000) throw new ArgumentOutOfRangeException(nameof(initializationGraceMs));
        if (pollMs < 1 || pollMs > 1000) throw new ArgumentOutOfRangeException(nameof(pollMs));

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(lockDirectory)));
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (true)
        {
            FileAttributes? legacy = AttributesOrNull(lockDirectory);
            if (legacy.HasValue && (legacy.Value & FileAttributes.ReparsePoint) != 0)
                throw new IOException(label + " lock path is a reparse point; refusing unsafe takeover.");
            if (legacy.HasValue && (legacy.Value & FileAttributes.Directory) == 0)
            {
                if (DateTime.UtcNow >= deadline)
                    throw new IOException(label + " legacy lock file is still present; refusing unsafe automatic deletion during a mixed-version upgrade.");
                Sleep(pollMs);
                continue;
            }

            CrossProcessDirectoryLockObservedTransition gate = ObserveTransition(lockDirectory, initializationGraceMs);
            if (gate.State == CrossProcessDirectoryLockState.Invalid)
                throw new IOException(label + " lock transition marker is invalid; refusing unsafe automatic recovery.");
            if (gate.State == CrossProcessDirectoryLockState.Active || gate.State == CrossProcessDirectoryLockState.Initializing)
            {
                WaitForTransitionOrThrow(lockDirectory, label, initializationGraceMs, deadline, pollMs);
                continue;
            }

            string token = Guid.NewGuid().ToString("D");
            CrossProcessDirectoryLockOwnerDocument owner = new CrossProcessDirectoryLockOwnerDocument
            {
                SchemaVersion = 1,
                Pid = Environment.ProcessId,
                Token = token,
                CreatedAt = DateTimeOffset.UtcNow.ToString("O")
            };
            if (TryPublishDirectory(lockDirectory, owner, token))
            {
                CrossProcessDirectoryLockObservedTransition gateAfterPublish = ObserveTransition(lockDirectory, initializationGraceMs);
                if (gateAfterPublish.State == CrossProcessDirectoryLockState.Invalid)
                {
                    RetirePublishedOwnerWithoutTransition(lockDirectory, owner, initializationGraceMs, label);
                    throw new IOException(label + " lock transition marker is invalid; refusing unsafe automatic recovery.");
                }
                while (gateAfterPublish.State == CrossProcessDirectoryLockState.Active || gateAfterPublish.State == CrossProcessDirectoryLockState.Initializing)
                {
                    if (DateTime.UtcNow >= deadline)
                    {
                        RetirePublishedOwnerWithoutTransition(lockDirectory, owner, initializationGraceMs, label);
                        throw new IOException(label + " is busy in another DeskMCP process.");
                    }
                    Sleep(pollMs);
                    gateAfterPublish = ObserveTransition(lockDirectory, initializationGraceMs);
                    if (gateAfterPublish.State == CrossProcessDirectoryLockState.Invalid)
                    {
                        RetirePublishedOwnerWithoutTransition(lockDirectory, owner, initializationGraceMs, label);
                        throw new IOException(label + " lock transition marker is invalid; refusing unsafe automatic recovery.");
                    }
                }
                return new CrossProcessDirectoryLock(lockDirectory, label, timeoutMs, initializationGraceMs, pollMs, owner);
            }

            CrossProcessDirectoryLockObservedOwner observed = ObserveOwner(lockDirectory, initializationGraceMs);
            if (observed.State == CrossProcessDirectoryLockState.Stale && observed.Owner != null)
            {
                if (ReclaimObservedStaleLock(lockDirectory, observed.Owner, initializationGraceMs, label)) continue;
            }
            else if (observed.State == CrossProcessDirectoryLockState.Invalid)
            {
                throw new IOException(label + " lock metadata is invalid; refusing unsafe automatic recovery.");
            }
            else if (observed.State == CrossProcessDirectoryLockState.Missing)
            {
                continue;
            }

            if (DateTime.UtcNow >= deadline) throw new IOException(label + " is busy in another DeskMCP process.");
            Sleep(pollMs);
        }
    }

    private static void RetirePublishedOwnerWithoutTransition(
        string lockDirectory,
        CrossProcessDirectoryLockOwnerDocument expectedOwner,
        int initializationGraceMs,
        string label)
    {
        string retired = lockDirectory + ".abandon-" + Environment.ProcessId + "-" + expectedOwner.Token;
        RetireOwnedDirectory(
            lockDirectory,
            retired,
            delegate
            {
                CrossProcessDirectoryLockObservedOwner current = ObserveOwner(lockDirectory, initializationGraceMs);
                return current.State == CrossProcessDirectoryLockState.Active && SameOwner(current.Owner, expectedOwner);
            },
            label);
        DeleteDirectoryWithRetries(retired);
    }

    public void Release()
    {
        if (released) return;
        string retired = lockDirectory + ".release-" + Environment.ProcessId + "-" + owner.Token;

        if (canonicalRetired)
        {
            DeleteDirectoryWithRetries(retired);
            if (pendingReleaseTransition != null)
            {
                CrossProcessDirectoryLockObservedTransition pending = ObserveTransition(lockDirectory, initializationGraceMs);
                if (pending.State != CrossProcessDirectoryLockState.Missing)
                {
                    if (pending.State != CrossProcessDirectoryLockState.Active
                        || pending.Owner == null
                        || pending.Owner.Pid != Environment.ProcessId
                        || pending.Owner.Kind != "release"
                        || pending.Owner.ExpectedOwnerPid != owner.Pid
                        || !String.Equals(pending.Owner.Token, pendingReleaseTransition.Token, StringComparison.OrdinalIgnoreCase)
                        || !String.Equals(pending.Owner.ExpectedOwnerToken, owner.Token, StringComparison.OrdinalIgnoreCase))
                        throw new IOException(label + " pending release transition ownership changed before retry.");
                    ReleaseTransition(lockDirectory, pendingReleaseTransition);
                }
                pendingReleaseTransition = null;
            }
            released = true;
            return;
        }

        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        CrossProcessDirectoryLockTransitionDocument transition = pendingReleaseTransition;
        while (transition == null)
        {
            CrossProcessDirectoryLockObservedTransition presence = ObserveTransition(lockDirectory, initializationGraceMs);
            if (presence.State == CrossProcessDirectoryLockState.Invalid)
                throw new IOException(label + " lock transition marker is invalid; refusing unsafe release.");
            if (presence.State == CrossProcessDirectoryLockState.Active
                && presence.Owner != null
                && presence.Owner.Pid == Environment.ProcessId
                && presence.Owner.Kind == "release"
                && presence.Owner.ExpectedOwnerPid == owner.Pid
                && String.Equals(presence.Owner.ExpectedOwnerToken, owner.Token, StringComparison.OrdinalIgnoreCase))
            {
                transition = presence.Owner;
            }
            else if (presence.State == CrossProcessDirectoryLockState.Missing)
            {
                transition = TryCreateTransition(lockDirectory, "release", owner);
            }
            if (transition == null)
                WaitForTransitionOrThrow(lockDirectory, label, initializationGraceMs, deadline, pollMs);
        }
        pendingReleaseTransition = transition;

        try
        {
            RetireOwnedDirectory(
                lockDirectory,
                retired,
                delegate
                {
                    CrossProcessDirectoryLockObservedOwner current = ObserveOwner(lockDirectory, initializationGraceMs);
                    return current.State == CrossProcessDirectoryLockState.Active
                        && SameOwner(current.Owner, owner)
                        && TransitionStillOwned(lockDirectory, transition, owner, "release", initializationGraceMs);
                },
                label);
            canonicalRetired = true;
            DeleteDirectoryWithRetries(retired);
        }
        catch (Exception error)
        {
            try
            {
                ReleaseTransition(lockDirectory, transition);
                pendingReleaseTransition = null;
            }
            catch (Exception releaseError)
            {
                throw new AggregateException(label + " release failed and transition release also failed.", error, releaseError);
            }
            throw;
        }
        ReleaseTransition(lockDirectory, transition);
        pendingReleaseTransition = null;
        released = true;
    }

    public void Dispose()
    {
        Release();
    }

    public static int RunSelfTest()
    {
        string root = Path.Combine(Path.GetTempPath(), "deskmcp-cross-process-lock-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string lockDirectory = Path.Combine(root, "control.lock");
        try
        {
            using (CrossProcessDirectoryLock first = Acquire(lockDirectory, "self-test", 1000, 100, 5))
            {
                bool rejected = false;
                try
                {
                    using (CrossProcessDirectoryLock ignored = Acquire(lockDirectory, "self-test", 80, 100, 5)) { }
                }
                catch (IOException) { rejected = true; }
                if (!rejected) return 31;
            }

            CrossProcessDirectoryLock idempotent = Acquire(lockDirectory, "self-test", 1000, 100, 5);
            idempotent.Release();
            idempotent.Release();
            idempotent.Dispose();

            Directory.CreateDirectory(lockDirectory);
            WriteJson(lockDirectory, new CrossProcessDirectoryLockOwnerDocument
            {
                SchemaVersion = 1,
                Pid = Int32.MaxValue,
                Token = Guid.NewGuid().ToString("D"),
                CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-1).ToString("O")
            });
            using (CrossProcessDirectoryLock recovered = Acquire(lockDirectory, "self-test", 1000, 100, 5)) { }

            CrossProcessDirectoryLock guarded = Acquire(lockDirectory, "self-test", 1000, 100, 5);
            File.WriteAllText(Path.Combine(lockDirectory, "owner.json"), JsonSerializer.Serialize(new CrossProcessDirectoryLockOwnerDocument
            {
                SchemaVersion = 1,
                Pid = Environment.ProcessId,
                Token = Guid.NewGuid().ToString("D"),
                CreatedAt = DateTimeOffset.UtcNow.ToString("O")
            }) + Environment.NewLine);
            bool ownershipRejected = false;
            try { guarded.Release(); }
            catch (IOException error) { ownershipRejected = error.Message.IndexOf("ownership changed", StringComparison.OrdinalIgnoreCase) >= 0; }
            if (!ownershipRejected) return 32;
            if (!Directory.Exists(lockDirectory)) return 33;
            Directory.Delete(lockDirectory, true);

            Directory.CreateDirectory(lockDirectory);
            WriteJson(lockDirectory, new CrossProcessDirectoryLockOwnerDocument
            {
                SchemaVersion = 1,
                Pid = 0,
                Token = Guid.NewGuid().ToString("D"),
                CreatedAt = DateTimeOffset.UtcNow.ToString("O")
            });
            bool invalidOwnerRejected = false;
            try { using (CrossProcessDirectoryLock ignored = Acquire(lockDirectory, "self-test", 80, 100, 5)) { } }
            catch (IOException error) { invalidOwnerRejected = error.Message.IndexOf("metadata is invalid", StringComparison.OrdinalIgnoreCase) >= 0; }
            if (!invalidOwnerRejected) return 34;
            Directory.Delete(lockDirectory, true);

            string staleToken = Guid.NewGuid().ToString("D");
            Directory.CreateDirectory(lockDirectory);
            WriteJson(lockDirectory, new CrossProcessDirectoryLockOwnerDocument
            {
                SchemaVersion = 1,
                Pid = Int32.MaxValue,
                Token = staleToken,
                CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-1).ToString("O")
            });
            string transitionDirectory = TransitionPath(lockDirectory);
            Directory.CreateDirectory(transitionDirectory);
            WriteJson(transitionDirectory, new CrossProcessDirectoryLockTransitionDocument
            {
                SchemaVersion = 1,
                Kind = "reclaim",
                Pid = Int32.MaxValue,
                Token = Guid.NewGuid().ToString("D"),
                ExpectedOwnerPid = Int32.MaxValue,
                ExpectedOwnerToken = staleToken,
                CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-1).ToString("O")
            });
            bool abandonedTransitionRejected = false;
            try { using (CrossProcessDirectoryLock ignored = Acquire(lockDirectory, "self-test", 80, 100, 5)) { } }
            catch (IOException error) { abandonedTransitionRejected = error.Message.IndexOf("transition", StringComparison.OrdinalIgnoreCase) >= 0; }
            if (!abandonedTransitionRejected) return 35;
            Directory.Delete(transitionDirectory, true);
            Directory.Delete(lockDirectory, true);

            File.WriteAllText(lockDirectory, "legacy\n");
            bool legacyRejected = false;
            try
            {
                using (CrossProcessDirectoryLock ignored = Acquire(lockDirectory, "self-test", 80, 100, 5)) { }
            }
            catch (IOException error)
            {
                legacyRejected = error.Message.IndexOf("legacy lock file", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            if (!legacyRejected) return 36;
            return 0;
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    public static int HoldForInterop(string lockDirectory, string readyFile, string releaseFile)
    {
        using (CrossProcessDirectoryLock lease = Acquire(lockDirectory, "Agent Desktop interop", 5000, 5000, 10))
        {
            File.WriteAllText(readyFile, "ready\n");
            DateTime deadline = DateTime.UtcNow.AddSeconds(15);
            while (!File.Exists(releaseFile))
            {
                if (DateTime.UtcNow >= deadline) return 41;
                Thread.Sleep(10);
            }
        }
        return 0;
    }

    public static int TryForInterop(string lockDirectory)
    {
        try
        {
            using (CrossProcessDirectoryLock lease = Acquire(lockDirectory, "Agent Desktop interop", 150, 5000, 5)) { }
            return 0;
        }
        catch (IOException)
        {
            return 42;
        }
    }
}
