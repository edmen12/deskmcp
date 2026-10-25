#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
#include <cwctype>
#include <filesystem>
#include <cstdint>
#include <algorithm>

struct EnumContext { bool jsonMode; unsigned count=0; bool first=true; };
std::string utf8(const std::wstring& s){
  if(s.empty())return {};
  int needed=WideCharToMultiByte(CP_UTF8,0,s.c_str(),int(s.size()),nullptr,0,nullptr,nullptr);
  if(needed<=0)return {};
  std::string out(needed,'\0');
  WideCharToMultiByte(CP_UTF8,0,s.c_str(),int(s.size()),out.data(),needed,nullptr,nullptr);
  return out;
}
std::string escape(const std::wstring& s){
  std::string b=utf8(s), out;
  for(unsigned char c:b){
    switch(c){
      case '"':out+="\\\"";break;
      case '\\':out+="\\\\";break;
      case '\n':out+="\\n";break;
      case '\r':out+="\\r";break;
      case '\t':out+="\\t";break;
      default: if(c<0x20){out+='?';}else{out+=char(c);}
    }
  }
  return out;
}
static BOOL CALLBACK describe(HWND hwnd,LPARAM raw){
  auto& ctx=*reinterpret_cast<EnumContext*>(raw);
  ctx.count++;
  DWORD pid=0; DWORD tid=GetWindowThreadProcessId(hwnd,&pid);
  wchar_t title[512]={},cls[256]={};
  GetWindowTextW(hwnd,title,512);
  GetClassNameW(hwnd,cls,256);
  RECT r{}; BOOL rect=GetWindowRect(hwnd,&r);
  const BOOL isWindow=IsWindow(hwnd),visible=IsWindowVisible(hwnd);
  if(!ctx.jsonMode){
    std::wcout<<L"HWND="<<(uintptr_t)hwnd<<L" PID="<<pid<<L" TID="<<tid
      <<L" ISWINDOW="<<isWindow<<L" VISIBLE="<<visible
      <<L" RECT_OK="<<rect<<L" TITLE=["<<title<<L"] CLASS=["<<cls<<L"]\n";
    return TRUE;
  }
  if(!isWindow||!rect||!pid||pid>INT32_MAX)return TRUE;
  HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
  wchar_t executable[MAX_PATH]={};DWORD length=MAX_PATH;
  BOOL hasName=process&&QueryFullProcessImageNameW(process,0,executable,&length);
  if(process)CloseHandle(process);
  if(!hasName)return TRUE;
  std::wstring processName=std::filesystem::path(executable).stem().wstring();
  if(processName.empty())return TRUE;
  if(!ctx.first)std::cout<<',';
  ctx.first=false;
  const int width=(std::max)(0L,r.right-r.left);
  const int height=(std::max)(0L,r.bottom-r.top);
  std::cout<<"{\"hwnd\":"<<(uintptr_t)hwnd
    <<",\"processId\":"<<pid
    <<",\"processName\":\""<<escape(processName)<<"\""
    <<",\"title\":\""<<escape(title)<<"\""
    <<",\"className\":\""<<escape(cls)<<"\""
    <<",\"width\":"<<width<<",\"height\":"<<height
    <<",\"isForeground\":false}";
  return TRUE;
}
int wmain(int argc,wchar_t** argv){
  bool jsonMode=argc==4&&std::wstring(argv[1])==L"object-windows"&&std::wstring(argv[2])==L"--desktop-object";
  if(!jsonMode && argc!=2)return 2;
  const std::wstring name=jsonMode?argv[3]:argv[1];
  if(name.size()!=46||name.rfind(L"DeskMCP-Agent-",0)!=0)return 2;
  for(size_t i=14;i<name.size();i++)if(!std::iswxdigit(name[i]))return 2;
  HDESK desktop=OpenDesktopW(name.c_str(),0,FALSE,DESKTOP_READOBJECTS|DESKTOP_ENUMERATE);
  if(!desktop){std::wcerr<<L"OPEN_FAILED="<<GetLastError()<<L"\n";return 3;}
  EnumContext ctx{jsonMode};
  if(jsonMode)std::cout<<'[';
  BOOL ok=EnumDesktopWindows(desktop,describe,reinterpret_cast<LPARAM>(&ctx));
  DWORD lastError=GetLastError();
  CloseDesktop(desktop);
  if(jsonMode)std::cout<<']';
  else std::wcout<<L"ENUM_OK="<<ok<<L" ENUM_LAST_ERROR="<<lastError<<L" CALLBACK_WINDOWS="<<ctx.count<<L"\n";
  return ok?0:4;
}
