// Test-only Windows Hello broker adapter. No key enrollment, no UI takeover.
// NEVER launch --sign via remote MCP or an unattended process.
// Build with MSVC + Windows 10 SDK C++/WinRT.
#include <iostream>
#include <iterator>
#include <string>
#include <stdexcept>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Security.Cryptography.Core.h>
#include <winrt/Windows.Storage.Streams.h>

namespace credentials = winrt::Windows::Security::Credentials;
namespace crypto = winrt::Windows::Security::Cryptography;

static constexpr wchar_t kCredentialName[] = L"DeskMCP.BrowserHuman.v1";

static credentials::KeyCredential openExistingCredential() {
    auto opened = credentials::KeyCredentialManager::OpenAsync(kCredentialName).get();
    if (opened.Status() != credentials::KeyCredentialStatus::Success) {
        throw std::runtime_error("Windows Hello credential is not provisioned by the trusted local UI");
    }
    return opened.Credential();
}

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) {
            std::cerr << "Usage: --check | --public | --sign\n";
            return 2;
        }
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        std::wstring mode(argv[1]);
        if (mode == L"--check") {
            // Read-only capability check. Does NOT create a key or prompt for PIN.
            const bool supported = credentials::KeyCredentialManager::IsSupportedAsync().get();
            std::cout << (supported ? "HELLO_SUPPORTED" : "HELLO_UNAVAILABLE") << "\n";
            return supported ? 0 : 4;
        }
        if (mode != L"--public" && mode != L"--sign") {
            std::cerr << "Unsupported mode\n";
            return 2;
        }
        auto key = openExistingCredential();
        if (mode == L"--public") {
            // Public key output is informational. Never auto-enroll this from IPC.
            auto publicKey = key.RetrievePublicKey(
                winrt::Windows::Security::Cryptography::Core::CryptographicPublicKeyBlobType::X509SubjectPublicKeyInfo);
            std::cout << winrt::to_string(crypto::CryptographicBuffer::EncodeToBase64String(publicKey)) << "\n";
            return 0;
        }
        std::string message((std::istreambuf_iterator<char>(std::cin)),std::istreambuf_iterator<char>());
        if (message.empty() || message.size() > 4096 || message.rfind("deskmcp-browser-human-v1",0) != 0) {
            std::cerr << "Invalid bounded DeskMCP browser challenge\n";
            return 2;
        }
        // The Windows Hello broker MUST request user verification to sign.
        // Do not run automatically and do not create a key here.
        const auto data = crypto::CryptographicBuffer::ConvertStringToBinary(
            winrt::to_hstring(message), crypto::BinaryStringEncoding::Utf8);
        const auto signedData = key.RequestSignAsync(data).get();
        if (signedData.Status() != credentials::KeyCredentialStatus::Success) {
            std::cerr << "Windows Hello signature request was not approved\n";
            return 5;
        }
        std::cout << winrt::to_string(crypto::CryptographicBuffer::EncodeToBase64String(signedData.Result())) << "\n";
        return 0;
    } catch (winrt::hresult_error const& error) {
        std::cerr << "Windows Hello broker failure: 0x" << std::hex
                  << static_cast<unsigned>(error.code()) << "\n";
        return 6;
    } catch (std::exception const& error) {
        std::cerr << error.what() << "\n";
        return 6;
    }
}
