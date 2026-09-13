using System;
using System.IO;
using System.Text;
using System.Threading;

internal static class RuntimeReliability
{
    private static readonly int[] RetryDelaysSeconds = new int[] { 2, 5, 10, 30 };
    private static readonly object LogWriteSync = new object();
    private const int DefaultLogMaxBytes = 1024 * 1024;

    public static int RetryDelaySeconds(int retryIndex)
    {
        if (retryIndex < 0) retryIndex = 0;
        return RetryDelaysSeconds[Math.Min(retryIndex, RetryDelaysSeconds.Length - 1)];
    }

    public static bool DeadlineExceeded(DateTime unhealthySinceUtc, DateTime nowUtc, TimeSpan timeout)
    {
        return unhealthySinceUtc != DateTime.MinValue &&
            nowUtc >= unhealthySinceUtc &&
            nowUtc - unhealthySinceUtc >= timeout;
    }

    public static string BackupPath(string path)
    {
        return path + ".bak";
    }

    public static bool IsKnownProfile(string profile)
    {
        return profile == "read-only" || profile == "workspace-write" ||
            profile == "full-control" || profile == "fully-unlocked";
    }

    public static string ResolveGatewayRecoveryProfile(bool profileChangeInFlight, string requestedProfile, string selectedProfile)
    {
        if (profileChangeInFlight && IsKnownProfile(requestedProfile)) return requestedProfile;
        if (IsKnownProfile(selectedProfile)) return selectedProfile;
        return "read-only";
    }

    private static bool IsTransientFileTransitionError(Exception error)
    {
        if (error is UnauthorizedAccessException) return true;
        IOException io = error as IOException;
        if (io == null) return false;
        int nativeCode = io.HResult & 0xFFFF;
        return nativeCode == 5 || nativeCode == 32 || nativeCode == 33;
    }

    private static void RunFileTransitionWithRetry(Action operation)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                operation();
                return;
            }
            catch (Exception ex) when (IsTransientFileTransitionError(ex) && attempt < 7)
            {
                Thread.Sleep(Math.Min(10 * (1 << attempt), 200));
            }
        }
    }

    public static void MoveFileWithRetry(string source, string destination, bool overwrite)
    {
        RunFileTransitionWithRetry(() => File.Move(source, destination, overwrite));
    }

    private static void ReplaceFileWithRetry(string source, string destination, string backup)
    {
        RunFileTransitionWithRetry(() => File.Replace(source, destination, backup, true));
    }

    public static void DeleteFileWithRetry(string path)
    {
        RunFileTransitionWithRetry(() => File.Delete(path));
    }

    public static void WriteAllTextAtomic(string path, string content, bool backupExisting)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(content ?? String.Empty);
        try { WriteAllBytesAtomic(path, bytes, backupExisting); }
        finally { Array.Clear(bytes, 0, bytes.Length); }
    }

    public static void WriteAllBytesAtomic(string path, byte[] content, bool backupExisting)
    {
        string directory = Path.GetDirectoryName(path);
        if (String.IsNullOrWhiteSpace(directory))
            throw new InvalidOperationException("Atomic state path must have a parent directory.");
        Directory.CreateDirectory(directory);
        string temp = Path.Combine(directory, "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (FileStream stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(content, 0, content.Length);
                stream.Flush(true);
            }
            if (File.Exists(path))
            {
                if (backupExisting)
                {
                    string backup = BackupPath(path);
                    if (File.Exists(backup)) DeleteFileWithRetry(backup);
                    ReplaceFileWithRetry(temp, path, backup);
                }
                else
                    MoveFileWithRetry(temp, path, true);
            }
            else
            {
                MoveFileWithRetry(temp, path, false);
            }
        }
        finally
        {
            try { if (File.Exists(temp)) File.Delete(temp); } catch { }
        }
    }

    public static void AppendAllTextBounded(string path, string content, int maxBytes = DefaultLogMaxBytes)
    {
        if (maxBytes < 64) throw new ArgumentOutOfRangeException(nameof(maxBytes));
        string directory = Path.GetDirectoryName(path);
        if (String.IsNullOrWhiteSpace(directory))
            throw new InvalidOperationException("Bounded log path must have a parent directory.");
        Directory.CreateDirectory(directory);
        string value = content ?? String.Empty;
        int maxChars = Math.Max(1, maxBytes / 4);
        if (value.Length > maxChars) value = value.Substring(value.Length - maxChars);
        byte[] bytes = new UTF8Encoding(false).GetBytes(value);
        try
        {
            lock (LogWriteSync)
            {
                string rotated = path + ".1";
                long existingBytes = File.Exists(path) ? new FileInfo(path).Length : 0;
                if (existingBytes + bytes.Length > maxBytes)
                {
                    if (File.Exists(rotated)) DeleteFileWithRetry(rotated);
                    if (File.Exists(path)) MoveFileWithRetry(path, rotated, false);
                }
                using (FileStream stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(false);
                }
            }
        }
        finally { Array.Clear(bytes, 0, bytes.Length); }
    }

    public static int RunSelfTest()
    {
        string root = Path.Combine(Path.GetTempPath(), "deskmcp-runtime-reliability-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            if (RetryDelaySeconds(0) != 2 || RetryDelaySeconds(1) != 5 ||
                RetryDelaySeconds(2) != 10 || RetryDelaySeconds(99) != 30)
                throw new InvalidOperationException("retry backoff contract failed");

            DateTime now = DateTime.UtcNow;
            if (DeadlineExceeded(DateTime.MinValue, now, TimeSpan.FromSeconds(45)))
                throw new InvalidOperationException("empty deadline was treated as expired");
            if (!DeadlineExceeded(now.AddSeconds(-46), now, TimeSpan.FromSeconds(45)))
                throw new InvalidOperationException("runtime watchdog deadline did not expire");

            if (ResolveGatewayRecoveryProfile(true, "fully-unlocked", "read-only") != "fully-unlocked")
                throw new InvalidOperationException("profile switch recovery did not preserve the requested elevated profile");
            if (ResolveGatewayRecoveryProfile(true, "workspace-write", "read-only") != "workspace-write")
                throw new InvalidOperationException("profile switch recovery did not preserve the requested persistent profile");
            if (ResolveGatewayRecoveryProfile(false, null, "workspace-write") != "workspace-write")
                throw new InvalidOperationException("normal gateway recovery ignored the selected profile");
            if (ResolveGatewayRecoveryProfile(false, null, "invalid") != "read-only")
                throw new InvalidOperationException("invalid recovery profile did not fail closed to read-only");

            int transientAttempts = 0;
            RunFileTransitionWithRetry(() =>
            {
                transientAttempts++;
                if (transientAttempts < 3)
                    throw new IOException("simulated sharing violation", unchecked((int)0x80070020));
            });
            if (transientAttempts != 3)
                throw new InvalidOperationException("transient file transition retry contract failed");

            int permanentAttempts = 0;
            bool permanentRejected = false;
            try
            {
                RunFileTransitionWithRetry(() =>
                {
                    permanentAttempts++;
                    throw new IOException("simulated file-not-found", unchecked((int)0x80070002));
                });
            }
            catch (IOException) { permanentRejected = true; }
            if (!permanentRejected || permanentAttempts != 1)
                throw new InvalidOperationException("non-transient file transition was retried unexpectedly");

            string state = Path.Combine(root, "settings.json");
            WriteAllTextAtomic(state, "{\"value\":1}", true);
            WriteAllTextAtomic(state, "{\"value\":2}", true);
            if (File.ReadAllText(state) != "{\"value\":2}" ||
                File.ReadAllText(BackupPath(state)) != "{\"value\":1}")
                throw new InvalidOperationException("atomic state backup contract failed");

            string boundedLog = Path.Combine(root, "bounded.log");
            for (int i = 0; i < 5; i++)
                AppendAllTextBounded(boundedLog, new string((char)('A' + i), 80) + Environment.NewLine, 128);
            AppendAllTextBounded(boundedLog, new string('Z', 1000), 128);
            string rotatedLog = boundedLog + ".1";
            if (!File.Exists(rotatedLog) || new FileInfo(rotatedLog).Length > 128 || new FileInfo(boundedLog).Length > 128)
                throw new InvalidOperationException("bounded log rotation contract failed");
            if (!File.ReadAllText(boundedLog).Contains("ZZZZ"))
                throw new InvalidOperationException("bounded log did not preserve the newest entry tail");

            Console.WriteLine("RUNTIME_RELIABILITY_SELF_TEST_OK");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }
}
