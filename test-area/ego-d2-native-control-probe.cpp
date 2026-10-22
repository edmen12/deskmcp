#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
#include <algorithm>
#include <cwctype>
#include <cstdint>
struct Child {HWND hwnd;std::wstring cls;std::wstring text;};
static std::wstring getText(HWND h) {
  wchar_t buf[512]{};
  SendMessageTimeoutW(h, WM_GETTEXT, 511, reinterpret_cast<LPARAM>(buf),
     SMTO_ABORTIFHUNG|SMTO_BLOCK, 900, nullptr);
  return buf;
}
static std::wstring getClass(HWND h) {
  wchar_t buf[256]{};
  GetClassNameW(h,buf,256);return buf;
}
static BOOL CALLBACK collectChild(HWND h, LPARAM raw) {
  auto& out=*reinterpret_cast<std::vector<Child>*>(raw);
  out.push_back({h,getClass(h),getText(h)});
  return TRUE;
}
struct Root {HWND hwnd=nullptr;};
static BOOL CALLBACK findRoot(HWND h,LPARAM raw){
  auto& state=*reinterpret_cast<Root*>(raw);
  const auto title=getText(h);
  if(title.find(L"DeskMCP D2 Acceptance Fixture")!=std::wstring::npos){
    state.hwnd=h;return FALSE;
  }
  return TRUE;
}
int wmain(int argc,wchar_t** argv){
  if(argc!=3){std::wcerr<<L"Usage: <object-name> --inspect or --act\n";return 2;}
  const std::wstring object=argv[1],mode=argv[2];
  const std::wstring prefix=L"DeskMCP-Agent-";
  if(object.size()!=prefix.size()+32||object.substr(0,prefix.size())!=prefix||
     !std::all_of(object.begin()+prefix.size(),object.end(),[](wchar_t c){return iswxdigit(c)!=0;})){
    return 3;
  }
  if(mode!=L"--inspect"&&mode!=L"--act")return 4;
  HDESK desk=OpenDesktopW(object.c_str(),0,FALSE,DESKTOP_READOBJECTS|DESKTOP_ENUMERATE);
  if(!desk){std::wcerr<<L"OPEN_FAILED "<<GetLastError();return 5;}
  Root root;
  EnumDesktopWindows(desk,findRoot,reinterpret_cast<LPARAM>(&root));
  CloseDesktop(desk);
  if(!root.hwnd){std::wcerr<<L"FIXTURE_NOT_FOUND";return 6;}
  DWORD rootPid=0;GetWindowThreadProcessId(root.hwnd,&rootPid);
  std::vector<Child> children;
  EnumChildWindows(root.hwnd,collectChild,reinterpret_cast<LPARAM>(&children));
  std::wcout<<L"ROOT="<<(uintptr_t)root.hwnd<<L" PID="<<rootPid<<L" CHILDREN="<<children.size()<<L"\n";
  HWND edit=nullptr,button=nullptr;
  for(const Child& item:children){
    std::wcout<<L"CHILD="<<(uintptr_t)item.hwnd<<L" CLS=["<<item.cls<<L"] TEXT=["<<item.text<<L"]\n";
    DWORD pid=0;GetWindowThreadProcessId(item.hwnd,&pid);
    if(pid!=rootPid)continue;
    if(item.cls.find(L"WindowsForms10.EDIT")!=std::wstring::npos)edit=item.hwnd;
    if(item.cls.find(L"WindowsForms10.BUTTON")!=std::wstring::npos&&item.text==L"Apply Input")button=item.hwnd;
  }
  if(mode==L"--inspect")return 0;
  if(!edit||!button){std::wcerr<<L"EDIT_OR_BUTTON_NOT_FOUND\n";return 7;}
  DWORD_PTR result=0;
  const std::wstring phrase=L"D2_NATIVE_BACKGROUND_PASS";
  if(!SendMessageTimeoutW(edit,WM_SETTEXT,0,reinterpret_cast<LPARAM>(phrase.c_str()),
        SMTO_ABORTIFHUNG|SMTO_BLOCK,1000,&result))return 8;
  if(getText(edit)!=phrase)return 9;
  if(!SendMessageTimeoutW(button,BM_CLICK,0,0,SMTO_ABORTIFHUNG|SMTO_BLOCK,1000,&result))return 10;
  Sleep(250);
  // The expected label is a non-input readback: no global keys/mouse/clipboard.
  for(const Child& item:children){
    const auto t=getText(item.hwnd);
    if(t.find(L"Applied: D2_NATIVE_BACKGROUND_PASS")!=std::wstring::npos){
      std::wcout<<L"RESULT="<<t<<L"\n";
      return 0;
    }
  }
  std::wcerr<<L"APP_CALLBACK_DID_NOT_RUN\n";return 11;
}
