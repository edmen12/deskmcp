using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

// Recovery storage uses a non-exportable Windows CNG key with a per-user ACL.
// Legacy DPAPI blobs remain readable by their original format and are never
// reinterpreted as recovery ciphertext when their decryption fails.
internal static class TunnelKeyProtection
{
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("DMCPCNG1");
    private const int NonceLength = 12;
    private const int TagLength = 16;
    private const int MaxSecretLength = 16384;

    private static string UserSid => WindowsIdentity.GetCurrent().User.Value;
    private static string KeyName => "DeskMCP.TunnelRecovery.v1." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(UserSid)));

    public static bool IsRecoveryBlob(byte[] blob)
    {
        return blob != null && blob.Length >= Magic.Length &&
            blob.AsSpan(0, Magic.Length).SequenceEqual(Magic);
    }

    public static byte[] Protect(byte[] plain, byte[] entropy)
    {
        try { return ProtectedData.Protect(plain, entropy, DataProtectionScope.CurrentUser); }
        catch (CryptographicException ex) when (IsUserProtectionUnavailable(ex))
        {
            using (CngKey key = OpenKey(KeyName, true))
                return ProtectRecovery(plain, entropy, key);
        }
    }

    public static byte[] Unprotect(byte[] blob, byte[] entropy)
    {
        if (!IsRecoveryBlob(blob))
            return ProtectedData.Unprotect(blob, entropy, DataProtectionScope.CurrentUser);
        using (CngKey key = OpenKey(KeyName, false))
            return UnprotectRecovery(blob, entropy, key);
    }

    private static bool IsUserProtectionUnavailable(CryptographicException error)
    {
        return error.HResult == unchecked((int)0x80070005) ||
            error.HResult == unchecked((int)0x8009000B) ||
            error.HResult == unchecked((int)0x80090016);
    }

    private static CngKey OpenKey(string name, bool create)
    {
        CngKey key;
        if (CngKey.Exists(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.MachineKey))
            key = CngKey.Open(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.MachineKey);
        else
        {
            if (!create) throw new CryptographicException("The protected Tunnel recovery key is missing.");
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
                if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                    throw new InvalidOperationException("Windows user encryption is unavailable. Run DeskMCP as administrator once to initialize its protected recovery key, then save the Runtime API Key again.");
            CngKeyCreationParameters options = new CngKeyCreationParameters
            {
                Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider,
                KeyCreationOptions = CngKeyCreationOptions.MachineKey,
                KeyUsage = CngKeyUsages.Decryption,
                ExportPolicy = CngExportPolicies.None
            };
            options.Parameters.Add(new CngProperty("Length", BitConverter.GetBytes(2048), CngPropertyOptions.None));
            key = CngKey.Create(CngAlgorithm.Rsa, name, options);
            try
            {
                FileSecurity acl = new FileSecurity();
                acl.SetAccessRuleProtection(true, false);
                foreach (string sid in new string[] { UserSid, "S-1-5-18", "S-1-5-32-544" })
                    acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, AccessControlType.Allow));
                new FileInfo(KeyFile(key)).SetAccessControl(acl);
            }
            catch { key.Delete(); key.Dispose(); throw; }
        }
        try { ValidateKey(key); return key; }
        catch { key.Dispose(); throw; }
    }

    private static string KeyFile(CngKey key)
    {
        if (String.IsNullOrWhiteSpace(key.UniqueName) || Path.GetFileName(key.UniqueName) != key.UniqueName)
            throw new CryptographicException("Invalid Windows recovery key identity.");
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Microsoft", "Crypto", "Keys", key.UniqueName);
    }

    private static void ValidateKey(CngKey key)
    {
        if (!key.IsMachineKey || !key.Algorithm.Equals(CngAlgorithm.Rsa) || key.ExportPolicy != CngExportPolicies.None)
            throw new CryptographicException("Tunnel recovery key protection is invalid.");
        FileSecurity acl = new FileInfo(KeyFile(key)).GetAccessControl();
        if (!acl.AreAccessRulesProtected)
            throw new CryptographicException("Tunnel recovery key permissions must not inherit access.");
        bool userAllowed = false;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            string sid = rule.IdentityReference.Value;
            if (rule.AccessControlType != AccessControlType.Allow ||
                (sid != UserSid && sid != "S-1-5-18" && sid != "S-1-5-32-544"))
                throw new CryptographicException("Tunnel recovery key permissions are not restricted to this Windows user.");
            if (sid == UserSid && (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl)
                userAllowed = true;
        }
        if (!userAllowed) throw new CryptographicException("Tunnel recovery key does not authorize this Windows user.");
    }

    private static byte[] AssociatedData(byte[] entropy)
    {
        byte[] sid = Encoding.UTF8.GetBytes(UserSid);
        byte[] data = new byte[Magic.Length + sid.Length + (entropy?.Length ?? 0)];
        Magic.CopyTo(data, 0);
        sid.CopyTo(data, Magic.Length);
        if (entropy != null) entropy.CopyTo(data, Magic.Length + sid.Length);
        return data;
    }

    private static byte[] ProtectRecovery(byte[] plain, byte[] entropy, CngKey key)
    {
        if (plain == null || plain.Length == 0 || plain.Length > MaxSecretLength)
            throw new CryptographicException("Tunnel Runtime Key size is invalid.");
        byte[] aesKey = RandomNumberGenerator.GetBytes(32);
        byte[] wrappedKey = null;
        byte[] cipher = new byte[plain.Length];
        byte[] tag = new byte[TagLength];
        byte[] nonce = RandomNumberGenerator.GetBytes(NonceLength);
        try
        {
            using (RSACng rsa = new RSACng(key)) wrappedKey = rsa.Encrypt(aesKey, RSAEncryptionPadding.OaepSHA256);
            using (AesGcm aes = new AesGcm(aesKey, TagLength)) aes.Encrypt(nonce, plain, cipher, tag, AssociatedData(entropy));
            using (MemoryStream stream = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                writer.Write(Magic); writer.Write(wrappedKey.Length); writer.Write(nonce);
                writer.Write(tag); writer.Write(wrappedKey); writer.Write(cipher);
                return stream.ToArray();
            }
        }
        finally { CryptographicOperations.ZeroMemory(aesKey); }
    }

    private static byte[] UnprotectRecovery(byte[] blob, byte[] entropy, CngKey key)
    {
        const int prefix = 8 + 4 + NonceLength + TagLength;
        if (blob.Length < prefix + 256 + 1 || blob.Length > prefix + 512 + MaxSecretLength)
            throw new CryptographicException("Protected Tunnel Runtime Key is truncated or invalid.");
        int wrappedLength = BitConverter.ToInt32(blob, 8);
        if (wrappedLength != 256 || blob.Length <= prefix + wrappedLength)
            throw new CryptographicException("Protected Tunnel Runtime Key envelope is invalid.");
        byte[] aesKey = null;
        byte[] plain = new byte[blob.Length - prefix - wrappedLength];
        try
        {
            using (RSACng rsa = new RSACng(key))
                aesKey = rsa.Decrypt(blob.AsSpan(prefix, wrappedLength).ToArray(), RSAEncryptionPadding.OaepSHA256);
            using (AesGcm aes = new AesGcm(aesKey, TagLength))
                aes.Decrypt(blob.AsSpan(12, NonceLength), blob.AsSpan(prefix + wrappedLength), blob.AsSpan(24, TagLength), plain, AssociatedData(entropy));
            return plain;
        }
        catch { CryptographicOperations.ZeroMemory(plain); throw; }
        finally { if (aesKey != null) CryptographicOperations.ZeroMemory(aesKey); }
    }

    public static int InitializeRecoveryKey()
    {
        using (CngKey key = OpenKey(KeyName, true)) { }
        Console.WriteLine("TUNNEL_RECOVERY_KEY_INITIALIZED");
        return 0;
    }

    public static int RunRecoveryReadbackSelfTest()
    {
        byte[] plain = Encoding.UTF8.GetBytes("Non-secret same-user recovery test");
        byte[] decoded = null;
        try
        {
            using (CngKey key = OpenKey(KeyName, false))
            {
                byte[] entropy = Encoding.UTF8.GetBytes("TunnelKeyProtection:self-test");
                byte[] blob = ProtectRecovery(plain, entropy, key);
                decoded = UnprotectRecovery(blob, entropy, key);
                if (!CryptographicOperations.FixedTimeEquals(plain, decoded)) throw new Exception("Recovery readback failed.");
            }
            Console.WriteLine("TUNNEL_RECOVERY_READBACK_SELF_TEST_OK");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine("TUNNEL_RECOVERY_READBACK_SELF_TEST_FAILED=" + ex.Message); return 1; }
        finally { CryptographicOperations.ZeroMemory(plain); if (decoded != null) CryptographicOperations.ZeroMemory(decoded); }
    }

    public static int RunSelfTest()
    {
        string name = "DeskMCP.TunnelRecovery.Test." + Guid.NewGuid().ToString("N");
        CngKey key = null;
        byte[] plain = Encoding.UTF8.GetBytes("Non-secret Tunnel key protection test");
        byte[] entropy = Encoding.UTF8.GetBytes("TunnelKeyProtection:self-test");
        try
        {
            key = OpenKey(name, true);
            byte[] blob = ProtectRecovery(plain, entropy, key);
            byte[] decoded = UnprotectRecovery(blob, entropy, key);
            if (!CryptographicOperations.FixedTimeEquals(plain, decoded)) throw new Exception("Recovery roundtrip failed.");
            CryptographicOperations.ZeroMemory(decoded);
            using (CngKey reopened = OpenKey(name, false))
            {
                decoded = UnprotectRecovery(blob, entropy, reopened);
                if (!CryptographicOperations.FixedTimeEquals(plain, decoded)) throw new Exception("Persisted recovery roundtrip failed.");
                CryptographicOperations.ZeroMemory(decoded);
            }
            try { UnprotectRecovery(blob, Encoding.UTF8.GetBytes("wrong purpose"), key); throw new Exception("Wrong entropy was accepted."); }
            catch (CryptographicException) { }
            string testFile = Path.Combine(Path.GetTempPath(), "deskmcp-tunnel-protection-" + Guid.NewGuid().ToString("N"));
            try
            {
                RuntimeReliability.WriteAllBytesAtomic(testFile, blob, false);
                File.SetAttributes(testFile, FileAttributes.Hidden);
                RuntimeReliability.WriteAllBytesAtomic(testFile, blob, false);
                decoded = UnprotectRecovery(File.ReadAllBytes(testFile), entropy, key);
                if (!CryptographicOperations.FixedTimeEquals(plain, decoded)) throw new Exception("Atomic protected-file update failed.");
                CryptographicOperations.ZeroMemory(decoded);
            }
            finally { if (File.Exists(testFile)) File.Delete(testFile); }
            blob[blob.Length - 1] ^= 1;
            try { UnprotectRecovery(blob, entropy, key); throw new Exception("Tampered ciphertext was accepted."); }
            catch (CryptographicException) { }
            bool exportRejected = false;
            try { key.Export(CngKeyBlobFormat.Pkcs8PrivateBlob); }
            catch (CryptographicException) { exportRejected = true; }
            if (!exportRejected) throw new Exception("Private key export was allowed.");
            Console.WriteLine("TUNNEL_KEY_PROTECTION_SELF_TEST_OK");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine("TUNNEL_KEY_PROTECTION_SELF_TEST_FAILED=" + ex.Message); return 1; }
        finally { CryptographicOperations.ZeroMemory(plain); if (key != null) { key.Delete(); key.Dispose(); } }
    }
}
