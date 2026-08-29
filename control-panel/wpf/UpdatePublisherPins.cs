using System;

internal static class UpdatePublisherPins
{
    // Certificate SHA-256 fingerprints accepted for automatic update execution.
    // This list is compiled into the installed client. Never load it from remote
    // metadata, environment variables, or mutable local configuration.
    //
    // Keep empty until the production Authenticode identity is available.
    internal static readonly string[] CertificateSha256 = Array.Empty<string>();
}
