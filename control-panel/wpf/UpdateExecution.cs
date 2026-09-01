using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Controls;

internal sealed class PendingUpdateVerification
{
    public string previousVersion { get; set; }
    public string expectedVersion { get; set; }
    public string expectedProfile { get; set; }
    public string target { get; set; }
    public string installerSha256 { get; set; }
}

internal sealed partial class ControlPanelRuntime
{
    private UpdateCheckInfo lastUpdateCandidate;
    private string verifiedUpdatePath;
    private PendingUpdateVerification pendingUpdateVerification;
    private bool updateSecurityHold;
    private bool updateProfileRecoveryAllowed;
    private string updateSecurityError;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo
    {
        public uint cbStruct;
        [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustData
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        public IntPtr pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileTime
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CryptProviderSigner
    {
        public uint cbStruct;
        public NativeFileTime sftVerifyAsOf;
        public uint csCertChain;
        public IntPtr pasCertChain;
        public uint dwSignerType;
        public IntPtr psSigner;
        public uint dwError;
        public uint csCounterSigners;
        public IntPtr pasCounterSigners;
        public IntPtr pChainContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CryptProviderCert
    {
        public uint cbStruct;
        public IntPtr pCert;
        public int fCommercial;
        public int fTrustedRoot;
        public int fSelfSigned;
        public int fTestCert;
        public uint dwRevokedReason;
        public uint dwConfidence;
        public uint dwError;
        public IntPtr pTrustListContext;
        public int fTrustListSignerCert;
        public IntPtr pCtlContext;
        public uint dwCtlError;
        public int fIsCyclic;
        public IntPtr pChainElement;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CertContext
    {
        public uint dwCertEncodingType;
        public IntPtr pbCertEncoded;
        public uint cbCertEncoded;
        public IntPtr pCertInfo;
        public IntPtr hCertStore;
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid actionId, IntPtr trustData);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperProvDataFromStateData(IntPtr stateData);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr providerData, uint signerIndex, [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterSignerIndex);

    private static readonly Guid WinTrustActionGenericVerifyV2 = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
    private const uint WtdUiNone = 2;
    private const uint WtdRevokeWholeChain = 1;
    private const uint WtdChoiceFile = 1;
    private const uint WtdStateActionVerify = 1;
    private const uint WtdStateActionClose = 2;
    private const uint WtdRevocationCheckChainExcludeRoot = 0x00000080;
    private const int TrustEProviderUnknown = unchecked((int)0x800B0001);
    private const int TrustESubjectFormUnknown = unchecked((int)0x800B0003);
    private const int TrustENoSignature = unchecked((int)0x800B0100);

    private enum AuthenticodeInspection
    {
        Absent,
        Trusted,
        Invalid
    }

    private static bool HasPinnedUpdatePublisher()
    {
        return UpdatePublisherPins.CertificateSha256 != null && UpdatePublisherPins.CertificateSha256.Length > 0;
    }

    private string PendingUpdateStatePath()
    {
        return Path.Combine(dataRoot, "updates", "pending-verification.json");
    }

    private static string NormalizeSha256(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return null;
        string normalized = value.Replace(":", String.Empty).Trim().ToUpperInvariant();
        if (normalized.Length != 64) return null;
        for (int i = 0; i < normalized.Length; i++)
        {
            char c = normalized[i];
            if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F'))) return null;
        }
        return normalized;
    }
    private static bool IsSafeUpdateDownload(UpdateCheckInfo candidate, out string reason)
    {
        reason = null;
        if (candidate == null || candidate.kind != "verified-download-allowed") { reason = "candidate is not download-eligible"; return false; }
        if (candidate.sizeBytes == null || candidate.sizeBytes.Value <= 0) { reason = "invalid expected size"; return false; }
        if (NormalizeSha256(candidate.sha256) == null) { reason = "invalid expected SHA-256"; return false; }
        if (String.IsNullOrWhiteSpace(candidate.artifact) || Path.GetFileName(candidate.artifact) != candidate.artifact) { reason = "invalid artifact name"; return false; }
        Uri uri;
        if (!Uri.TryCreate(candidate.downloadUrl, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps) { reason = "download URL is not HTTPS"; return false; }
        if (!String.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase)) { reason = "download host is not GitHub"; return false; }
        string prefix = "/edmen12/deskmcp/releases/download/";
        if (!uri.AbsolutePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { reason = "download URL is outside the fixed repository"; return false; }
        return true;
    }

    private static bool IsCandidateForInstalledClient(UpdateCheckInfo candidate, string currentVersion, string installedTarget, out string reason)
    {
        if (!IsSafeUpdateDownload(candidate, out reason)) return false;
        if (!String.Equals(candidate.target, installedTarget, StringComparison.Ordinal)) { reason = "candidate target does not match this installation"; return false; }
        Version current;
        Version next;
        if (!Version.TryParse(currentVersion, out current) || !Version.TryParse(candidate.version, out next) || next <= current) { reason = "candidate version is not a newer valid version"; return false; }
        string expectedArtifact = installedTarget == "win-x64"
            ? "DeskMCP-Setup-" + candidate.version + ".exe"
            : "DeskMCP-Setup-" + candidate.version + "-" + installedTarget + ".exe";
        if (!String.Equals(candidate.artifact, expectedArtifact, StringComparison.Ordinal)) { reason = "candidate artifact name does not match the installed target contract"; return false; }
        Uri uri = new Uri(candidate.downloadUrl);
        string expectedPath = "/edmen12/deskmcp/releases/download/v" + candidate.version + "/" + candidate.artifact;
        if (!String.Equals(Uri.UnescapeDataString(uri.AbsolutePath), expectedPath, StringComparison.Ordinal)) { reason = "candidate download path does not match its version and artifact"; return false; }
        return true;
    }

    private static string ComputeSha256(string path)
    {
        using (FileStream stream = File.OpenRead(path))
        {
            byte[] hash = SHA256.HashData(stream);
            return Convert.ToHexString(hash);
        }
    }

    private static void DeleteQuietly(string path)
    {
        try { if (!String.IsNullOrWhiteSpace(path) && File.Exists(path)) File.Delete(path); } catch { }
    }
    private static AuthenticodeInspection InspectAuthenticode(string path, out string signerFingerprint, out string reason)
    {
        signerFingerprint = null;
        reason = null;
        WinTrustFileInfo fileInfo = new WinTrustFileInfo
        {
            cbStruct = (uint)Marshal.SizeOf<WinTrustFileInfo>(),
            pcwszFilePath = path,
            hFile = IntPtr.Zero,
            pgKnownSubject = IntPtr.Zero
        };
        IntPtr fileInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
        IntPtr trustDataPtr = IntPtr.Zero;
        bool stateOpened = false;
        try
        {
            Marshal.StructureToPtr(fileInfo, fileInfoPtr, false);
            WinTrustData data = new WinTrustData
            {
                cbStruct = (uint)Marshal.SizeOf<WinTrustData>(),
                dwUIChoice = WtdUiNone,
                fdwRevocationChecks = WtdRevokeWholeChain,
                dwUnionChoice = WtdChoiceFile,
                pFile = fileInfoPtr,
                dwStateAction = WtdStateActionVerify,
                dwProvFlags = WtdRevocationCheckChainExcludeRoot,
                dwUIContext = 0
            };
            trustDataPtr = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustData>());
            Marshal.StructureToPtr(data, trustDataPtr, false);
            int result = WinVerifyTrust(IntPtr.Zero, WinTrustActionGenericVerifyV2, trustDataPtr);
            int lastError = Marshal.GetLastWin32Error();
            data = Marshal.PtrToStructure<WinTrustData>(trustDataPtr);
            stateOpened = data.hWVTStateData != IntPtr.Zero;
            if (result == TrustENoSignature)
            {
                if (lastError == TrustENoSignature || lastError == TrustESubjectFormUnknown || lastError == TrustEProviderUnknown)
                    return AuthenticodeInspection.Absent;
                reason = "WinVerifyTrust reported no valid signature but Windows returned verification error 0x" + lastError.ToString("X8");
                return AuthenticodeInspection.Invalid;
            }
            if (result != 0)
            {
                reason = "WinVerifyTrust rejected the Authenticode signature (0x" + result.ToString("X8") + ")";
                return AuthenticodeInspection.Invalid;
            }
            IntPtr providerData = WTHelperProvDataFromStateData(data.hWVTStateData);
            IntPtr signerPtr = providerData == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(providerData, 0, false, 0);
            if (signerPtr == IntPtr.Zero) { reason = "WinVerifyTrust did not expose a signer chain"; return AuthenticodeInspection.Invalid; }
            CryptProviderSigner signer = Marshal.PtrToStructure<CryptProviderSigner>(signerPtr);
            if (signer.csCertChain == 0 || signer.pasCertChain == IntPtr.Zero) { reason = "Authenticode signer chain is empty"; return AuthenticodeInspection.Invalid; }
            CryptProviderCert providerCert = Marshal.PtrToStructure<CryptProviderCert>(signer.pasCertChain);
            if (providerCert.pCert == IntPtr.Zero) { reason = "Authenticode signer certificate is missing"; return AuthenticodeInspection.Invalid; }
            CertContext cert = Marshal.PtrToStructure<CertContext>(providerCert.pCert);
            if (cert.pbCertEncoded == IntPtr.Zero || cert.cbCertEncoded == 0) { reason = "Authenticode signer certificate is invalid"; return AuthenticodeInspection.Invalid; }
            byte[] rawCert = new byte[cert.cbCertEncoded];
            Marshal.Copy(cert.pbCertEncoded, rawCert, 0, rawCert.Length);
            signerFingerprint = Convert.ToHexString(SHA256.HashData(rawCert));
            return AuthenticodeInspection.Trusted;
        }
        finally
        {
            if (trustDataPtr != IntPtr.Zero && stateOpened)
            {
                WinTrustData closeData = Marshal.PtrToStructure<WinTrustData>(trustDataPtr);
                closeData.dwStateAction = WtdStateActionClose;
                Marshal.StructureToPtr(closeData, trustDataPtr, false);
                try { WinVerifyTrust(IntPtr.Zero, WinTrustActionGenericVerifyV2, trustDataPtr); } catch { }
            }
            if (trustDataPtr != IntPtr.Zero) Marshal.FreeHGlobal(trustDataPtr);
            Marshal.FreeHGlobal(fileInfoPtr);
        }
    }

    private static bool VerifyPinnedPublisher(string fingerprint, out string reason)
    {
        reason = null;
        if (!HasPinnedUpdatePublisher()) { reason = "no trusted publisher pin is compiled into this build"; return false; }
        string normalizedSigner = NormalizeSha256(fingerprint);
        foreach (string allowed in UpdatePublisherPins.CertificateSha256)
        {
            string normalizedAllowed = NormalizeSha256(allowed);
            if (normalizedAllowed != null && String.Equals(normalizedSigner, normalizedAllowed, StringComparison.Ordinal)) return true;
        }
        reason = "the Authenticode signer is not in the compiled publisher pin set";
        return false;
    }

    private static bool VerifyAuthenticodeExecutionPolicy(
        AuthenticodeInspection signature,
        string signerFingerprint,
        string inspectionReason,
        out string reason)
    {
        if (signature == AuthenticodeInspection.Invalid)
        {
            reason = inspectionReason ?? "Authenticode signature validation failed";
            return false;
        }
        if (signature == AuthenticodeInspection.Trusted && HasPinnedUpdatePublisher())
        {
            return VerifyPinnedPublisher(signerFingerprint, out reason);
        }
        reason = null;
        return true;
    }

    private static bool VerifyDownloadedUpdate(string path, UpdateCheckInfo candidate, out string signerFingerprint, out string reason)
    {
        signerFingerprint = null;
        reason = null;
        FileInfo info = new FileInfo(path);
        if (!info.Exists) { reason = "downloaded file is missing"; return false; }
        if (candidate.sizeBytes == null || info.Length != candidate.sizeBytes.Value) { reason = "downloaded size does not match the manifest"; return false; }
        string expected = NormalizeSha256(candidate.sha256);
        string actual = ComputeSha256(path);
        if (expected == null || !String.Equals(expected, actual, StringComparison.Ordinal)) { reason = "downloaded SHA-256 does not match the manifest"; return false; }

        AuthenticodeInspection signature = InspectAuthenticode(path, out signerFingerprint, out string inspectionReason);
        return VerifyAuthenticodeExecutionPolicy(signature, signerFingerprint, inspectionReason, out reason);
    }
    private async Task<string> DownloadAndVerifyUpdateFileAsync(UpdateCheckInfo candidate)
    {
        string validationReason;
        if (!IsCandidateForInstalledClient(candidate, CurrentProductVersion(), InstalledUpdateTarget(), out validationReason)) throw new InvalidDataException(validationReason);

        string versionPart = String.IsNullOrWhiteSpace(candidate.version) ? "unknown" : "v" + candidate.version;
        string updateDir = Path.Combine(dataRoot, "updates", versionPart, candidate.target ?? InstalledUpdateTarget());
        Directory.CreateDirectory(updateDir);
        string finalPath = Path.Combine(updateDir, candidate.artifact);
        string partialPath = finalPath + ".partial";
        DeleteQuietly(partialPath);
        DeleteQuietly(finalPath);

        Uri uri = new Uri(candidate.downloadUrl);
        using (HttpClient client = new HttpClient())
        {
            client.Timeout = TimeSpan.FromMinutes(3);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("DeskMCP/" + CurrentProductVersion());
            using (HttpResponseMessage response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
            {
                response.EnsureSuccessStatusCode();
                long expectedSize = candidate.sizeBytes.Value;
                if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != expectedSize)
                    throw new InvalidDataException("GitHub Content-Length does not match the release manifest.");
                using (Stream input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using (FileStream output = new FileStream(partialPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 128, true))
                {
                    byte[] buffer = new byte[1024 * 128];
                    long total = 0;
                    while (true)
                    {
                        int read = await input.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                        if (read == 0) break;
                        total += read;
                        if (total > expectedSize) throw new InvalidDataException("Downloaded file exceeded the manifest size.");
                        await output.WriteAsync(buffer, 0, read).ConfigureAwait(false);
                    }
                    await output.FlushAsync().ConfigureAwait(false);
                    if (total != expectedSize) throw new InvalidDataException("Downloaded file size does not match the manifest.");
                }
            }
        }

        string expectedSha = NormalizeSha256(candidate.sha256);
        string actualSha = ComputeSha256(partialPath);
        if (!String.Equals(expectedSha, actualSha, StringComparison.Ordinal))
        {
            DeleteQuietly(partialPath);
            throw new InvalidDataException("Downloaded SHA-256 does not match the manifest.");
        }
        File.Move(partialPath, finalPath, true);
        string signer;
        string trustReason;
        if (!VerifyDownloadedUpdate(finalPath, candidate, out signer, out trustReason))
        {
            DeleteQuietly(finalPath);
            throw new InvalidDataException(trustReason);
        }
        return finalPath;
    }
    private async Task HandleVerifiedUpdateDownloadAsync(Button button, TextBlock status)
    {
        if (lastUpdateCandidate == null) return;
        updateCheckInFlight = true;
        button.IsEnabled = false;
        button.Content = "Updating…";
        status.Text = "Downloading update…";
        verifiedUpdatePath = null;
        try
        {
            string path = await DownloadAndVerifyUpdateFileAsync(lastUpdateCandidate);
            verifiedUpdatePath = path;
            status.Text = "Update verified · starting installer…";
            button.Content = "Starting…";
            InstallVerifiedUpdate();
        }
        catch (Exception ex)
        {
            bool installerReady = !String.IsNullOrWhiteSpace(verifiedUpdatePath) && File.Exists(verifiedUpdatePath);
            status.Text = ex is InvalidDataException
                ? "Update verification failed · " + ex.Message
                : "Could not update · " + ex.Message;
            button.Content = installerReady ? "Install Update" : "Retry Update";
        }
        finally
        {
            updateCheckInFlight = false;
            button.IsEnabled = true;
        }
    }

    private void WritePendingUpdateVerification(UpdateCheckInfo candidate)
    {
        PendingUpdateVerification state = new PendingUpdateVerification
        {
            previousVersion = CurrentProductVersion(),
            expectedVersion = candidate.version,
            expectedProfile = persistentProfile,
            target = InstalledUpdateTarget(),
            installerSha256 = NormalizeSha256(candidate.sha256)
        };
        string path = PendingUpdateStatePath();
        string dir = Path.GetDirectoryName(path);
        Directory.CreateDirectory(dir);
        string temp = path + ".tmp";
        string json = JsonSerializer.Serialize(state);
        File.WriteAllText(temp, json, new UTF8Encoding(false));
        File.Move(temp, path, true);
    }

    private void ClearPendingUpdateVerification()
    {
        DeleteQuietly(PendingUpdateStatePath());
        pendingUpdateVerification = null;
    }

    private void InstallVerifiedUpdate()
    {
        if (lastUpdateCandidate == null || String.IsNullOrWhiteSpace(verifiedUpdatePath)) return;
        string signer;
        string reason;
        if (!IsCandidateForInstalledClient(lastUpdateCandidate, CurrentProductVersion(), InstalledUpdateTarget(), out reason))
        {
            DeleteQuietly(verifiedUpdatePath);
            verifiedUpdatePath = null;
            throw new InvalidDataException("Update candidate changed before installation: " + reason);
        }
        if (!VerifyDownloadedUpdate(verifiedUpdatePath, lastUpdateCandidate, out signer, out reason))
        {
            DeleteQuietly(verifiedUpdatePath);
            verifiedUpdatePath = null;
            throw new InvalidDataException("Update verification failed: " + reason);
        }

        WritePendingUpdateVerification(lastUpdateCandidate);
        try
        {
            quitting = true;
            StopOwnedTunnel();
            StopGateway();
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = verifiedUpdatePath,
                WorkingDirectory = Path.GetDirectoryName(verifiedUpdatePath),
                UseShellExecute = true
            };
            Process launched = Process.Start(psi);
            if (launched == null) throw new InvalidOperationException("Could not launch the verified installer.");
            notify.Visible = false;
            app.Shutdown();
        }
        catch
        {
            quitting = false;
            ClearPendingUpdateVerification();
            throw;
        }
    }
    private static bool EvaluatePendingUpdate(
        PendingUpdateVerification state,
        string currentVersion,
        string currentProfile,
        string currentTarget,
        out bool clearPending,
        out string error)
    {
        clearPending = false;
        error = null;
        if (state == null) { error = "pending update verification state is missing"; return false; }
        if (state.expectedProfile != "read-only" && state.expectedProfile != "workspace-write") { error = "pending update profile is invalid"; return false; }
        if (NormalizeSha256(state.installerSha256) == null) { error = "pending installer SHA-256 is invalid"; return false; }
        if (!String.Equals(state.target, currentTarget, StringComparison.Ordinal)) { error = "installed architecture changed during update"; return false; }
        Version previous;
        Version expected;
        Version current;
        if (!Version.TryParse(state.previousVersion, out previous) || !Version.TryParse(state.expectedVersion, out expected) || !Version.TryParse(currentVersion, out current) || expected <= previous)
        {
            error = "pending update version state is invalid";
            return false;
        }
        if (current == previous)
        {
            if (!String.Equals(state.expectedProfile, currentProfile, StringComparison.Ordinal))
            {
                error = "persisted permission profile changed during update";
                return false;
            }
            clearPending = true;
            return true;
        }
        if (current != expected)
        {
            error = "installed version does not exactly match the verified update";
            return false;
        }
        if (!String.Equals(state.expectedProfile, currentProfile, StringComparison.Ordinal))
        {
            error = "persisted permission profile changed during update";
            return false;
        }
        clearPending = true;
        return true;
    }
    private void InitializePendingUpdateVerification()
    {
        string path = PendingUpdateStatePath();
        if (!File.Exists(path)) return;
        try
        {
            PendingUpdateVerification state = JsonSerializer.Deserialize<PendingUpdateVerification>(File.ReadAllText(path));
            pendingUpdateVerification = state;
            bool clearPending;
            string error;
            if (EvaluatePendingUpdate(state, CurrentProductVersion(), persistentProfile, InstalledUpdateTarget(), out clearPending, out error))
            {
                if (clearPending) ClearPendingUpdateVerification();
                return;
            }
            updateSecurityHold = true;
            updateProfileRecoveryAllowed = String.Equals(error, "persisted permission profile changed during update", StringComparison.Ordinal);
            updateSecurityError = error ?? "post-install update verification failed";
        }
        catch (Exception ex)
        {
            updateSecurityHold = true;
            updateProfileRecoveryAllowed = false;
            updateSecurityError = "pending update verification state is invalid: " + ex.Message;
        }
    }

    private void ApplyUpdateSecurityHoldUi()
    {
        if (!updateSecurityHold) return;
        TextBlock gateway = Find<TextBlock>("GatewayStatus");
        Button power = Find<Button>("PowerButton");
        TextBlock updateStatus = Find<TextBlock>("UpdateStatus");
        Button updateButton = Find<Button>("UpdateButton");
        TextBlock liveText = Find<TextBlock>("LiveText");
        System.Windows.Shapes.Ellipse liveDot = Find<System.Windows.Shapes.Ellipse>("LiveDot");
        Border livePill = Find<Border>("LivePill");
        gateway.Text = "Security hold";
        power.Content = "Update verification required";
        power.IsEnabled = false;
        liveText.Text = "Security hold";
        liveDot.Fill = BrushFrom("#FFFF453A");
        livePill.Background = BrushFrom("#FF3A1F20");
        livePill.BorderBrush = BrushFrom("#FF6A2E31");
        updateStatus.Text = "Security hold · " + updateSecurityError;
        updateButton.Content = updateProfileRecoveryAllowed ? "Restore Safe Profile" : "Manual Recovery";
        updateButton.IsEnabled = updateProfileRecoveryAllowed;
    }
    private void RestorePendingSafeProfile()
    {
        if (!updateSecurityHold || !updateProfileRecoveryAllowed || pendingUpdateVerification == null) return;
        string expected = pendingUpdateVerification.expectedProfile;
        if (expected != "read-only" && expected != "workspace-write")
        {
            ShowToast("Pending update profile is invalid. Use manual recovery.", true);
            return;
        }
        persistentProfile = expected;
        selectedProfile = expected;
        SaveSettings();
        ClearPendingUpdateVerification();
        updateSecurityHold = false;
        updateProfileRecoveryAllowed = false;
        updateSecurityError = null;
        ShowToast("Restored the pre-update safe permission profile.", false);
        UpdateStatus();
    }

    public static int RunUpdateSecuritySelfTest()
    {
        string root = Path.Combine(Path.GetTempPath(), "deskmcp-update-selftest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string file = Path.Combine(root, "unsigned.exe");
        try
        {
            File.WriteAllBytes(file, Encoding.ASCII.GetBytes("DeskMCP update trust self-test"));
            UpdateCheckInfo candidate = new UpdateCheckInfo
            {
                kind = "verified-download-allowed",
                version = "9.9.9",
                target = "win-x64",
                artifact = "DeskMCP-Setup-9.9.9.exe",
                downloadUrl = "https://github.com/edmen12/deskmcp/releases/download/v9.9.9/DeskMCP-Setup-9.9.9.exe",
                sizeBytes = new FileInfo(file).Length,
                sha256 = ComputeSha256(file)
            };
            string reason;
            if (!IsSafeUpdateDownload(candidate, out reason)) throw new InvalidOperationException("valid candidate rejected: " + reason);
            if (!IsCandidateForInstalledClient(candidate, "9.9.8", "win-x64", out reason)) throw new InvalidOperationException("valid installed-client candidate rejected: " + reason);

            UpdateCheckInfo badHost = new UpdateCheckInfo
            {
                kind = candidate.kind, version = candidate.version, target = candidate.target,
                artifact = candidate.artifact, sizeBytes = candidate.sizeBytes, sha256 = candidate.sha256,
                downloadUrl = "https://example.com/DeskMCP-Setup-9.9.9.exe"
            };
            if (IsSafeUpdateDownload(badHost, out reason)) throw new InvalidOperationException("non-GitHub download host was accepted");
            if (IsCandidateForInstalledClient(candidate, "9.9.8", "win-arm64", out reason)) throw new InvalidOperationException("wrong target candidate was accepted");
            UpdateCheckInfo badPath = new UpdateCheckInfo
            {
                kind = candidate.kind, version = candidate.version, target = candidate.target,
                artifact = candidate.artifact, sizeBytes = candidate.sizeBytes, sha256 = candidate.sha256,
                downloadUrl = "https://github.com/edmen12/deskmcp/releases/download/v9.9.8/DeskMCP-Setup-9.9.9.exe"
            };
            if (IsCandidateForInstalledClient(badPath, "9.9.8", "win-x64", out reason)) throw new InvalidOperationException("version-mismatched download path was accepted");

            string selfPath = typeof(ControlPanelRuntime).Assembly.Location;
            string selfSigner;
            string selfInspectionReason;
            AuthenticodeInspection selfInspection = InspectAuthenticode(selfPath, out selfSigner, out selfInspectionReason);
            if (selfInspection == AuthenticodeInspection.Invalid)
                throw new InvalidOperationException("local Authenticode inspection misclassified the build artifact: " + selfInspectionReason);
            UpdateCheckInfo selfCandidate = new UpdateCheckInfo
            {
                sizeBytes = new FileInfo(selfPath).Length,
                sha256 = ComputeSha256(selfPath)
            };
            if (!VerifyDownloadedUpdate(selfPath, selfCandidate, out selfSigner, out reason))
                throw new InvalidOperationException("real unsigned PE did not pass the verified download path: " + reason);
            selfCandidate.sha256 = new string('0', 64);
            if (VerifyDownloadedUpdate(selfPath, selfCandidate, out selfSigner, out reason))
                throw new InvalidOperationException("tampered expected SHA-256 was accepted for the unsigned PE");
            if (!VerifyAuthenticodeExecutionPolicy(AuthenticodeInspection.Absent, null, null, out reason))
                throw new InvalidOperationException("unsigned artifact was rejected after integrity verification: " + reason);
            if (VerifyAuthenticodeExecutionPolicy(AuthenticodeInspection.Invalid, null, "invalid signature", out reason))
                throw new InvalidOperationException("invalid Authenticode was downgraded to unsigned");

            PendingUpdateVerification pending = new PendingUpdateVerification
            {
                previousVersion = "9.9.8",
                expectedVersion = "9.9.9",
                expectedProfile = "read-only",
                target = "win-x64",
                installerSha256 = candidate.sha256
            };
            bool clear;
            string error;
            if (EvaluatePendingUpdate(pending, "9.9.9", "workspace-write", "win-x64", out clear, out error))
                throw new InvalidOperationException("post-install profile mismatch was accepted");
            if (!EvaluatePendingUpdate(pending, "9.9.8", "read-only", "win-x64", out clear, out error) || !clear)
                throw new InvalidOperationException("cancelled/not-applied update did not clear pending state");
            if (EvaluatePendingUpdate(pending, "9.9.7", "read-only", "win-x64", out clear, out error))
                throw new InvalidOperationException("unexpected rollback was accepted");
            if (EvaluatePendingUpdate(pending, "9.9.8.5", "read-only", "win-x64", out clear, out error))
                throw new InvalidOperationException("partial/intermediate update was accepted");
            if (EvaluatePendingUpdate(pending, "9.9.10", "read-only", "win-x64", out clear, out error))
                throw new InvalidOperationException("unexpected newer version was accepted without attestation");
            if (EvaluatePendingUpdate(pending, "9.9.10", "workspace-write", "win-x64", out clear, out error) || error != "installed version does not exactly match the verified update")
                throw new InvalidOperationException("version mismatch was masked by a profile mismatch");
            if (!EvaluatePendingUpdate(pending, "9.9.9", "read-only", "win-x64", out clear, out error) || !clear)
                throw new InvalidOperationException("matching post-install profile did not verify");

            Console.WriteLine("UPDATE_SECURITY_SELF_TEST_OK");
            Console.WriteLine("LOCAL_AUTHENTICODE_INSPECTION=" + selfInspection);
            Console.WriteLine("UNSIGNED_VERIFIED_EXECUTION_ALLOWED=OK");
            Console.WriteLine("INVALID_SIGNATURE_BLOCKED=OK");
            Console.WriteLine("PROFILE_MISMATCH_HOLD=OK");
            return 0;
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }
}
