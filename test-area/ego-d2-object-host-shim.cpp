#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <iostream>
#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <cstdint>
#include <cstring>
#include <climits>

static std::string utf8(const std::wstring& s) {
  if(s.empty())return {};
  const int bytes=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.c_str(),(int)s.size(),nullptr,0,nullptr,nullptr);
  if(bytes<=0) return {};
  std::string out((size_t)bytes, '\0');
  if(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.c_str(),(int)s.size(),out.data(),bytes,nullptr,nullptr)!=bytes)return {};
  return out;
}
static std::string quote(const std::string& source){
  std::string result="\"";
  for(unsigned char c:source){
    switch(c){
      case '"':result+="\\\"";break;
      case '\\':result+="\\\\";break;
      case '\n':result+="\\n";break;
      case '\r':result+="\\r";break;
      case '\t':result+="\\t";break;
      default:
        if(c<32){char hex[7];snprintf(hex,sizeof(hex),"\\u%04X",c);result+=hex;}
        else result.push_back((char)c);
    }
  }
  return result+"\"";
}
static bool validName(const std::wstring& name){
  static const std::wstring prefix=L"DeskMCP-Agent-";
  if(name.size()!=prefix.size()+32 || name.substr(0,prefix.size())!=prefix)return false;
  return std::all_of(name.begin()+prefix.size(),name.end(),
    [](wchar_t c){return (c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f')||(c>=L'A'&&c<=L'F');});
}
struct Entry{HWND hwnd;DWORD pid;std::wstring process,title,className;int width,height;};
static BOOL CALLBACK enumerator(HWND hwnd,LPARAM data){
  auto& rows=*reinterpret_cast<std::vector<Entry>*>(data);
  if(!IsWindow(hwnd))return TRUE;
  DWORD pid=0;
  GetWindowThreadProcessId(hwnd,&pid);
  if(pid==0 || pid>INT_MAX)return TRUE;
  HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
  if(!process)return TRUE;
  wchar_t binary[32768]{};
  DWORD size=(DWORD)std::size(binary);
  const bool image=QueryFullProcessImageNameW(process,0,binary,&size)!=0;
  CloseHandle(process);
  if(!image)return TRUE;
  wchar_t title[1024]{},cls[512]{};
  GetWindowTextW(hwnd,title,(int)std::size(title));
  GetClassNameW(hwnd,cls,(int)std::size(cls));
  RECT r{};
  if(!GetWindowRect(hwnd,&r))return TRUE;
  const auto processName=std::filesystem::path(binary).stem().wstring();
  rows.push_back({hwnd,pid,processName,title,cls,
    std::max(0,static_cast<int>(r.right-r.left)),std::max(0,static_cast<int>(r.bottom-r.top))});
  return TRUE;
}
int wmain(int argc,wchar_t** argv){
  if(argc!=4 || std::wstring(argv[1])!=L"object-windows" ||
    std::wstring(argv[2])!=L"--desktop-object" || !validName(argv[3])){
      std::cerr<<"TEST_SHIM_BAD_ARGUMENTS\n";return 2;
  }
  HDESK d=OpenDesktopW(argv[3],0,FALSE,DESKTOP_READOBJECTS|DESKTOP_ENUMERATE);
  if(!d){std::cerr<<"TEST_SHIM_OPEN_DESKTOP_FAILED\n";return 3;}
  std::vector<Entry> rows;
  const BOOL ok=EnumDesktopWindows(d,enumerator,reinterpret_cast<LPARAM>(&rows));
  CloseDesktop(d);
  if(!ok){std::cerr<<"TEST_SHIM_ENUM_FAILED\n";return 4;}
  std::cout<<"[";
  bool first=true;
  for(const auto& e:rows) {
    if(!first)std::cout<<",";
    first=false;
    std::cout<<"{\"hwnd\":"<<(uintptr_t)e.hwnd<<",\"processId\":"<<e.pid
      <<",\"processName\":"<<quote(utf8(e.process))
      <<",\"title\":"<<quote(utf8(e.title))
      <<",\"className\":"<<quote(utf8(e.className))
      <<",\"width\":"<<e.width<<",\"height\":"<<e.height
      <<",\"isForeground\":false}";
  }
  std::cout<<"]";
  return 0;
}
