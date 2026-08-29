using System;
using System.IO;
using System.Text;

internal static class RuntimeReliability
{
    private static readonly int[] RetryDelaysSeconds = new int[] { 2, 5, 10, 30 };

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
                    if (File.Exists(backup)) File.Delete(backup);
                    File.Replace(temp, path, backup, true);
                }
                else
                    File.Move(temp, path, true);
            }
            else
            {
                File.Move(temp, path, false);
            }
        }
        finally
        {
            try { if (File.Exists(temp)) File.Delete(temp); } catch { }
        }
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

            string state = Path.Combine(root, "settings.json");
            WriteAllTextAtomic(state, "{\"value\":1}", true);
            WriteAllTextAtomic(state, "{\"value\":2}", true);
            if (File.ReadAllText(state) != "{\"value\":2}" ||
                File.ReadAllText(BackupPath(state)) != "{\"value\":1}")
                throw new InvalidOperationException("atomic state backup contract failed");

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
