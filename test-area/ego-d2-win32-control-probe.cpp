#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
#include <cwctype>
#include <cstdint>

static constexpr wchar_t kFixture[] = L"DeskMCP D2 Acceptance Fixture 20261022";
struct Context {
  HWND root=nullptr;
  HWND edit=nullptr;
  HWND button=nullptr;
  HWND label=nullptr;
  unsigned edits=0;
  unsigned buttons=0;
  unsigned children=0;
};
static BOOL CALLBACK rootWindow(HWND hwnd, LPARAM param) {
  auto& data=*reinterpret_cast<Context*>(param);
  wchar_t name[256]{};
  GetWindowTextW(hwnd,name,256);
  if(std::wstring(name)==kFixture){
    wchar_t cls[256]{};
    GetClassNameW(hwnd,cls,256);
    if(std::wstring(cls).find(L"WindowsForms10.Window.")==0)data.root=hwnd;
  }
  return TRUE;
}
static BOOL CALLBACK childWindow(HWND hwnd, LPARAM param) {
  auto& data=*reinterpret_cast<Context*>(param);
  data.children++;
  wchar_t cls[256]{}, name[256]{};
  GetClassNameW(hwnd,cls,256);
  GetWindowTextW(hwnd,name,256);
  std::wcout<<L"CHILD HWND="<<(uintptr_t)hwnd<<L" CLASS=["<<cls<<L"] TEXT=["<<name
    <<L"] VIS="<<IsWindowVisible(hwnd)<<L"\n";
  const std::wstring type(cls),title(name);
  if(type.find(L"WindowsForms10.EDIT.")==0){
    data.edits++;data.edit=hwnd;
  }
  if(title==L"Apply Input" && type.find(L"WindowsForms10.BUTTON.")==0){
    data.buttons++;data.button=hwnd;
  }
  if(title==L"Awaiting Agent input" && type.find(L"WindowsForms10.STATIC.")==0){
    data.label=hwnd;
  }
  return TRUE;
}
static bool validate(const std::wstring& name){
  if(name.size()!=46 || name.rfind(L"DeskMCP-Agent-",0)!=0)return false;
  for(size_t i=14;i<name.size();i++)if(!std::iswxdigit(name[i]))return false;
  return true;
}
int wmain(int argc,wchar_t** argv){
  if(argc!=3 || !validate(argv[2]))return 2;
  const std::wstring action=argv[1];
  if(action!=L"--list" && action!=L"--exercise")return 2;
  HDESK desktop=OpenDesktopW(argv[2],0,FALSE,DESKTOP_ENUMERATE|DESKTOP_READOBJECTS);
  if(!desktop){std::wcerr<<L"OPEN_FAILED="<<GetLastError()<<L"\n";return 3;}
  Context ctx{};
  BOOL enumerated=EnumDesktopWindows(desktop,rootWindow,reinterpret_cast<LPARAM>(&ctx));
  if(!enumerated || !ctx.root){CloseDesktop(desktop);std::wcerr<<L"ISOLATED_FIXTURE_NOT_FOUND\n";return 4;}
  EnumChildWindows(ctx.root,childWindow,reinterpret_cast<LPARAM>(&ctx));
  CloseDesktop(desktop);
  std::wcout<<L"CHILDREN="<<ctx.children<<L" EDITS="<<ctx.edits<<L" BUTTONS="<<ctx.buttons<<"\n";
  if(action==L"--list")return 0;
  if(ctx.edits!=1 || ctx.buttons!=1 || !ctx.edit || !ctx.button)return 5;
  DWORD_PTR result=0;
  const wchar_t* value=L"D2_AGENT_LIVE_PASS";
  LRESULT set=SendMessageTimeoutW(ctx.edit,WM_SETTEXT,0,reinterpret_cast<LPARAM>(value),
    SMTO_ABORTIFHUNG|SMTO_BLOCK,2500,&result);
  if(!set){std::wcerr<<L"WM_SETTEXT_FAILED="<<GetLastError()<<L"\n";return 6;}
  SendMessageTimeoutW(ctx.button,BM_CLICK,0,0,
    SMTO_ABORTIFHUNG|SMTO_BLOCK,2500,&result);
  Sleep(250);
  wchar_t label[256]{};
  if(ctx.label)GetWindowTextW(ctx.label,label,256);
  std::wcout<<L"AFTER_LABEL=["<<label<<L"]\n";
  if(std::wstring(label)==L"Applied: D2_AGENT_LIVE_PASS"){
    std::cout<<"D2_NATIVE_BACKGROUND_INPUT_INVOKE_PASS\n";
    return 0;
  }
  return 7;
}
