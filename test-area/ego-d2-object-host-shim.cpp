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
#include <map>
#include <stdexcept>
#include <wincrypt.h>

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

struct Control { HWND hwnd; DWORD pid; std::wstring cls, title, role; };
static BOOL CALLBACK enumeratorChild(HWND hwnd, LPARAM raw) {
  auto& controls=*reinterpret_cast<std::vector<Control>*>(raw);
  if(!IsWindow(hwnd) || !IsWindowEnabled(hwnd))return TRUE;
  DWORD pid=0;GetWindowThreadProcessId(hwnd,&pid);
  wchar_t cls[512]{},name[512]{};
  GetClassNameW(hwnd,cls,512);
  const std::wstring c=cls;
  std::wstring role;
  if(c.rfind(L"WindowsForms10.EDIT.",0)==0) role=L"edit";
  if(c.rfind(L"WindowsForms10.BUTTON.",0)==0) role=L"button";
  if(role.empty())return TRUE;
  if(role==L"button")GetWindowTextW(hwnd,name,512);
  controls.push_back({hwnd,pid,c,role==L"button"?std::wstring(name):L"WinForms edit",role});
  return TRUE;
}
static std::wstring getTextNative(HWND hwnd,size_t chars) {
  if(chars>65537)return {};
  std::vector<wchar_t> value(chars+1,L'\0');
  DWORD_PTR out=0;
  if(!SendMessageTimeoutW(hwnd,WM_GETTEXT,chars,
       reinterpret_cast<LPARAM>(value.data()),
       SMTO_ABORTIFHUNG|SMTO_BLOCK,2500,&out))return {};
  return value.data();
}
static std::wstring utf16FromUtf8(const std::string& value){
  if(value.empty())return {};
  int chars=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,
      value.c_str(),(int)value.size(),nullptr,0);
  if(chars<=0)throw std::runtime_error("BAD_UTF8");
  std::wstring out(chars,L'\0');
  if(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,value.c_str(),
      (int)value.size(),out.data(),chars)!=chars)throw std::runtime_error("BAD_UTF8");
  return out;
}
static std::string decode64(const std::wstring& input){
  if(!std::all_of(input.begin(),input.end(),[](wchar_t c){return c>=0 && c<=127;}))
    throw std::runtime_error("NONASCII_BASE64");
  const std::string encoded=utf8(input);
  if(encoded.size()>90000)throw std::runtime_error("VALUE_TOO_LARGE");
  DWORD length=0;
  if(!CryptStringToBinaryA(encoded.c_str(),(DWORD)encoded.size(),
      CRYPT_STRING_BASE64,nullptr,&length,nullptr,nullptr)||length>65536)
      throw std::runtime_error("BASE64_FAILED");
  std::string result(length,'\0');
  if(length && !CryptStringToBinaryA(encoded.c_str(),(DWORD)encoded.size(),
      CRYPT_STRING_BASE64,(BYTE*)result.data(),&length,nullptr,nullptr))
      throw std::runtime_error("BASE64_FAILED");
  result.resize(length);
  return result;
}
static int execute(int argc,wchar_t** argv){
  if(argc<4 || (argc-2)%2!=0)return 2;
  const std::wstring command=argv[1];
  if(command!=L"object-windows" && command!=L"object-controls" && command!=L"object-act")return 2;
  std::map<std::wstring,std::wstring> options;
  for(int i=2;i<argc;i+=2){
    std::wstring key=argv[i];
    if(key.rfind(L"--",0)!=0||options.count(key))return 2;
    options[key]=argv[i+1];
  }
  if(!options.count(L"--desktop-object")||!validName(options[L"--desktop-object"]))return 2;
  HDESK d=OpenDesktopW(options[L"--desktop-object"].c_str(),0,FALSE,DESKTOP_READOBJECTS|DESKTOP_ENUMERATE);
  if(!d)return 3;
  std::vector<Entry> rows;
  BOOL ok=EnumDesktopWindows(d,enumerator,reinterpret_cast<LPARAM>(&rows));
  CloseDesktop(d);
  if(!ok)return 4;
  if(command==L"object-windows"){
    if(options.size()!=1)return 2;
    std::cout<<"[";
    bool first=true;
    for(const auto& e:rows){
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
  if(!options.count(L"--hwnd"))return 2;
  uintptr_t raw=0;
  try {
    std::wstring value=options[L"--hwnd"];
    size_t parsed=0;
    raw=(uintptr_t)std::stoull(value,&parsed,10);
    if(parsed!=value.size())return 2;
  }catch(...){return 2;}
  const auto found=std::find_if(rows.begin(),rows.end(),[&](const Entry& e){return (uintptr_t)e.hwnd==raw;});
  if(found==rows.end())return 5;
  std::vector<Control> all,children;
  if(!EnumChildWindows(found->hwnd,enumeratorChild,reinterpret_cast<LPARAM>(&all)))return 6;
  for(const Control& c:all)if(c.pid==found->pid)children.push_back(c);
  if(command==L"object-controls"){
    if(options.size()!=2)return 2;
    std::cout<<"{\"hwnd\":"<<raw<<",\"elements\":[";
    bool first=true;
    for(const auto& c:children){
      if(!first)std::cout<<",";
      first=false;
      std::cout<<"{\"type\":\""<<(c.role==L"edit"?"Edit":"Button")<<"\",\"name\":"
        <<quote(utf8(c.title))<<",\"selector\":"
        <<quote("native:"+utf8(c.role)+":"+std::to_string((uintptr_t)c.hwnd))
        <<",\"className\":"<<quote(utf8(c.cls))<<",\"isEnabled\":true"
        <<",\"isInvokable\":"<<(c.role==L"button"?"true":"false")<<"}";
    }
    std::cout<<"]}";
    return 0;
  }
  if(command==L"object-act" && (options.size()==4||options.size()==5)&&
      options.count(L"--action")&&options.count(L"--selector")){
    std::wstring selector=options[L"--selector"];
    if(selector.rfind(L"native:",0)!=0)return 2;
    size_t split=selector.find(L':',7);
    if(split==std::wstring::npos)return 2;
    const std::wstring role=selector.substr(7,split-7);
    uintptr_t childHwnd=0;
    try{
      std::wstring handle=selector.substr(split+1);
      size_t parsed=0;childHwnd=(uintptr_t)std::stoull(handle,&parsed,10);
      if(parsed!=handle.size())return 2;
    }catch(...){return 2;}
    auto c=std::find_if(children.begin(),children.end(),
      [&](const Control& value){return (uintptr_t)value.hwnd==childHwnd && value.role==role;});
    if(c==children.end())return 7;
    DWORD_PTR result=0;
    if(options[L"--action"]==L"set_value" && role==L"edit" && options.count(L"--value64")){
      if((GetWindowLongW(c->hwnd,GWL_STYLE)&ES_PASSWORD)!=0)return 8;
      std::wstring value=utf16FromUtf8(decode64(options[L"--value64"]));
      if(!SendMessageTimeoutW(c->hwnd,WM_SETTEXT,0,reinterpret_cast<LPARAM>(value.c_str()),
          SMTO_ABORTIFHUNG|SMTO_BLOCK,2500,&result))return 9;
      if(getTextNative(c->hwnd,value.size()+1)!=value)return 10;
      std::cout<<"{\"action\":\"set_value\",\"acknowledged\":true,\"readback_verified\":true}";
      return 0;
    }
    if(options[L"--action"]==L"invoke" && role==L"button" && !options.count(L"--value64")){
      if(!SendMessageTimeoutW(c->hwnd,BM_CLICK,0,0,
          SMTO_ABORTIFHUNG|SMTO_BLOCK,2500,&result))return 11;
      std::cout<<"{\"action\":\"invoke\",\"acknowledged\":true,\"effect_requires_reobservation\":true}";
      return 0;
    }
  }
  return 12;
}
int wmain(int argc,wchar_t** argv){
  try{return execute(argc,argv);}
  catch(const std::exception& error){std::cerr<<"NATIVE_TEST_SHIM: "<<error.what();return 13;}
}
