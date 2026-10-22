#pragma once
// Candidate UI-controlled Windows Hello reviewer, NOT yet wired to WPF.
// The CLI accepts no automatic --sign request; a reviewed on-screen dialog
// must be approved before requesting the OS-brokered Windows Hello signature.
#include <windows.h>
#include <shobjidl.h>
#include <cstdint>
#include <regex>
#include <chrono>
#include <filesystem>
#include <limits>
#include <vector>
#include <string>
#include <iostream>
#include <stdexcept>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.h>
#include <winrt/Windows.Security.Cryptography.h>

namespace review {
namespace credentials=winrt::Windows::Security::Credentials;
namespace crypto=winrt::Windows::Security::Cryptography;
struct Challenge {
    std::string raw, session, lease, desktop, action, epoch, nonce, expires;
};
static constexpr unsigned long long kMaxSafeEpoch=9007199254740991ULL;
inline std::string readBoundedChallenge() {
    std::string input;
    input.reserve(256);
    char ch{};
    while (std::cin.get(ch)) {
        if (input.size()>=4096) throw std::runtime_error("Overlong browser authorization challenge");
        input.push_back(ch);
    }
    return input;
}
inline bool number(const std::string& s,unsigned long long& n) {
    if(s.empty() || s.size()>16 || (s.size()>1 && s[0]=='0'))return false;
    n=0;
    for(unsigned char c:s){
        if(c<'0'||c>'9')return false;
        const auto digit=c-'0';
        if(n>((std::numeric_limits<unsigned long long>::max)()-digit)/10)return false;
        n=n*10+digit;
    }
    return true;
}
inline Challenge parseChallenge(const std::string& raw) {
    if(raw.empty() || raw.size()>4096 || raw.find('\r')!=std::string::npos ||
       raw.find('\0')!=std::string::npos) throw std::runtime_error("Invalid challenge bytes");
    std::vector<std::string> fields;
    std::size_t start=0;
    while(true){
        const auto end=raw.find('\n',start);
        if(end==std::string::npos){fields.push_back(raw.substr(start));break;}
        fields.push_back(raw.substr(start,end-start));
        start=end+1;
    }
    if(fields.size()!=8 || fields[0]!="deskmcp-browser-human-v2")
        throw std::runtime_error("Unsupported authorization challenge version");
    const std::regex uuid(R"(^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$)",
       std::regex_constants::icase);
    const std::regex nonce(R"(^[0-9a-f]{32}$)",std::regex_constants::icase);
    if(!std::regex_match(fields[1],uuid)||!std::regex_match(fields[2],uuid)||
       !std::regex_match(fields[3],uuid)||!std::regex_match(fields[6],nonce)||
       (fields[4]!="accept" && fields[4]!="resume"))
        throw std::runtime_error("Invalid session, lease, desktop, action or nonce");
    unsigned long long epoch=0,expiry=0;
    if(!number(fields[5],epoch)||epoch>kMaxSafeEpoch||!number(fields[7],expiry))
        throw std::runtime_error("Invalid epoch or expiration");
    const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    if(now<0 || expiry<=static_cast<unsigned long long>(now) ||
       expiry>static_cast<unsigned long long>(now)+60000ULL)
        throw std::runtime_error("Expired or future-dated challenge");
    return {raw,fields[1],fields[2],fields[3],fields[4],fields[5],fields[6],fields[7]};
}
// This candidate relies on DeskMCP's preinstalled native virtual desktop
// resolver next to the native broker. Never load a caller-provided library.
inline bool userIsOnSignedDesktop(const Challenge& challenge){
    wchar_t exe[32768]{};
    if(!GetModuleFileNameW(nullptr,exe,32768))return false;
    const auto base=std::filesystem::path(exe).parent_path();
    const auto dll=base/L"virtual-desktop-accessor"/L"VirtualDesktopAccessor.dll";
    if(!std::filesystem::exists(dll))return false;
    HMODULE module=LoadLibraryExW(dll.c_str(),nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if(!module)return false;
    using Current=int(__cdecl*)();
    using ById=int(__cdecl*)(GUID);
    const auto current=reinterpret_cast<Current>(GetProcAddress(module,"GetCurrentDesktopNumber"));
    const auto byId=reinterpret_cast<ById>(GetProcAddress(module,"GetDesktopNumberById"));
    GUID expected{};
    const std::wstring id(winrt::to_hstring(challenge.desktop).c_str());
    const bool parsed=SUCCEEDED(CLSIDFromString(id.c_str(),&expected));
    const bool valid=parsed && current && byId && current()>=1 && byId(expected)==current();
    FreeLibrary(module);
    return valid;
}
inline bool verifiedOwnerOnDesktop(HWND owner, const Challenge& challenge) {
    if (!owner || !IsWindow(owner) || !IsWindowVisible(owner)) return false;
    IVirtualDesktopManager* manager=nullptr;
    if (FAILED(CoCreateInstance(CLSID_VirtualDesktopManager,nullptr,CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&manager))) || !manager) return false;
    GUID actual{}, expected{};
    const std::wstring claimed(winrt::to_hstring(challenge.desktop).c_str());
    const bool ok=SUCCEEDED(CLSIDFromString(claimed.c_str(),&expected)) &&
        SUCCEEDED(manager->GetWindowDesktopId(owner,&actual)) &&
        InlineIsEqualGUID(actual,expected);
    manager->Release();
    return ok;
}
inline int reviewAndSign(const Challenge& challenge, HWND owner) {
    if (!verifiedOwnerOnDesktop(owner,challenge)) {
        std::cerr<<"No trusted visible owner window on the signed desktop\n";
        return 7;
    }
    if(!verifiedOwnerOnDesktop(owner,challenge) || !userIsOnSignedDesktop(challenge)){
        std::cerr<<"Matching visible Agent Desktop 2+ not verified; refusing user prompt\n";
        return 7;
    }
    const std::wstring action=challenge.action=="accept"
       ?L"Let me control this browser":L"Return browser control to Agent";
    const std::wstring session(winrt::to_hstring(challenge.session).c_str());
    const std::wstring lease(winrt::to_hstring(challenge.lease).c_str());
    const std::wstring desktop(winrt::to_hstring(challenge.desktop).c_str());
    std::wstring body=L"DeskMCP Browser Human Takeover\n\nAction: "+action+
       L"\nSession: "+session+L"\nLease: "+lease+L"\nDesktop: "+desktop+
       L"\n\nWhile you are in control, Agent cannot inspect the browser."
       L"\nHandback will close every earlier tab before Agent resumes."
       L"\n\nProceed to a Windows Hello verification?";
    // Cancel is the default. No auto-click, auto-focus, or virtual desktop switch.
    const int approval=MessageBoxW(owner,body.c_str(),L"DeskMCP — Verify local browser authorization",
       MB_OKCANCEL|MB_ICONWARNING|MB_DEFBUTTON2);
    if(approval!=IDOK)return 8;
    if(!verifiedOwnerOnDesktop(owner,challenge) || !userIsOnSignedDesktop(challenge)){
        std::cerr<<"Desktop changed while reviewing request\n";
        return 7;
    }
    const auto opened=credentials::KeyCredentialManager::OpenAsync(L"DeskMCP.BrowserHuman.v1").get();
    if(opened.Status()!=credentials::KeyCredentialStatus::Success)
        throw std::runtime_error("Dedicated Windows Hello credential has not been enrolled");
    const auto binary=crypto::CryptographicBuffer::ConvertStringToBinary(
       winrt::to_hstring(challenge.raw),crypto::BinaryStringEncoding::Utf8);
    const auto signature=opened.Credential().RequestSignAsync(binary).get();
    if(signature.Status()!=credentials::KeyCredentialStatus::Success){
        std::cerr<<"Windows Hello signature was not approved\n";
        return 5;
    }
    if(!verifiedOwnerOnDesktop(owner,challenge) || !userIsOnSignedDesktop(challenge)){
        std::cerr<<"Desktop changed during Windows Hello; signature discarded\n";
        return 7;
    }
    std::cout<<winrt::to_string(crypto::CryptographicBuffer::EncodeToBase64String(signature.Result()))<<"\n";
    return 0;
}
}
