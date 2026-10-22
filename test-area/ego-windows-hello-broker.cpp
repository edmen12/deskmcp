#define NOMINMAX
// Test-only Windows Hello broker adapter. No key enrollment, no UI takeover.
// --review-sign requires a local consent dialog; never invoke via MCP.
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
#include "ego-windows-hello-review.h"

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
        if (argc != 2 && argc != 3) {
            std::cerr << "Usage: --check | --identity-status | --public | --validate | --review-sign <trusted-hwnd>\n";
            return 2;
        }
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        std::wstring mode(argv[1]);
        if (mode == L"--identity-status") {
            // Read-only report: unpinned development builds cannot sign.
            const bool configured=review::trustedPublisherConfigured();
            std::cout<<(configured ? "TRUSTED_PUBLISHER_CONFIGURED" : "TRUSTED_PUBLISHER_UNCONFIGURED")<<"\n";
            return configured ? 0 : 9;
        }
        if (mode == L"--check") {
            // Read-only capability check. Does NOT create a key or prompt for PIN.
            const bool supported = credentials::KeyCredentialManager::IsSupportedAsync().get();
            std::cout << (supported ? "HELLO_SUPPORTED" : "HELLO_UNAVAILABLE") << "\n";
            return supported ? 0 : 4;
        }
        if ((mode != L"--public" && mode != L"--validate" && mode != L"--review-sign") ||
            (mode == L"--review-sign" && argc != 3) ||
            (mode != L"--review-sign" && argc != 2)) {
            std::cerr << "Unsupported mode\n";
            return 2;
        }
        if (mode != L"--public") {
            const auto challenge = review::parseChallenge(review::readBoundedChallenge());
            if (mode == L"--validate") {
                std::cout << "VALID_DESKTOP_BOUND_CHALLENGE\n";
                return 0;
            }
            std::wstring rawOwner(argv[2]);
            std::size_t position=0;
            unsigned long long windowHandle=0;
            try { windowHandle=std::stoull(rawOwner,&position,0); }
            catch (...) { throw std::runtime_error("Invalid native owner HWND"); }
            if (position!=rawOwner.size() || windowHandle==0 ||
                windowHandle>static_cast<unsigned long long>(UINTPTR_MAX))
                throw std::runtime_error("Invalid native owner HWND");
            return review::reviewAndSign(challenge,
                reinterpret_cast<HWND>(static_cast<UINT_PTR>(windowHandle)));
        }
        auto key = openExistingCredential();
        if (mode == L"--public") {
            // Public key output is informational. Never auto-enroll this from IPC.
            auto publicKey = key.RetrievePublicKey(
                winrt::Windows::Security::Cryptography::Core::CryptographicPublicKeyBlobType::X509SubjectPublicKeyInfo);
            std::cout << winrt::to_string(crypto::CryptographicBuffer::EncodeToBase64String(publicKey)) << "\n";
            return 0;
        }

    } catch (winrt::hresult_error const& error) {
        std::cerr << "Windows Hello broker failure: 0x" << std::hex
                  << static_cast<unsigned>(error.code()) << "\n";
        return 6;
    } catch (std::exception const& error) {
        std::cerr << error.what() << "\n";
        return 6;
    }
}
