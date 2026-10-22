// Candidate-only READ-ONLY Windows desktop switch poller. Never sends input,
// activates windows, creates desktop leases, or calls GoToDesktopNumber.
// A sampling monitor cannot exclude transitions shorter than its sample interval.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <cwchar>

using Clock=std::chrono::steady_clock;
static int durationMs(const wchar_t* raw){
  wchar_t* end=nullptr;
  const long n=wcstol(raw,&end,10);
  return end && *end==L'\0' && n>=300 && n<=60000 ? (int)n : 0;
}
int wmain(int argc,wchar_t** argv){
  if(argc!=5 || std::wstring(argv[1])!=L"--monitor"){
    std::cerr<<"usage --monitor <absolute-trusted-vda-dll> <max-ms> <stop-file>\n";
    return 2;
  }
  const std::filesystem::path dll=argv[2];
  const int maxMs=durationMs(argv[3]);
  const std::filesystem::path stop=argv[4];
  if(!dll.is_absolute() || !stop.is_absolute() || maxMs==0 ||
    dll.filename()!=L"VirtualDesktopAccessor.dll" ||
    !std::filesystem::exists(dll))return 2;
  HMODULE lib=LoadLibraryExW(dll.c_str(),nullptr,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if(!lib){std::cerr<<"MONITOR_DLL_LOAD_FAILED\n";return 3;}
  using CurrentDesktop=int (__cdecl*)();
  auto current=reinterpret_cast<CurrentDesktop>(
    GetProcAddress(lib,"GetCurrentDesktopNumber"));
  if(!current){FreeLibrary(lib);return 3;}
  int first=current();
  int previous=first;
  int transitions=0, wrong=0, invalid=0, total=1;
  long long maxGap=0;
  const auto started=Clock::now();
  auto last=started;
  while(std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-started).count()<maxMs){
    Sleep(10);
    const auto now=Clock::now();
    const auto gap=std::chrono::duration_cast<std::chrono::milliseconds>(now-last).count();
    if(gap>maxGap)maxGap=gap;
    last=now;
    int value=current();
    ++total;
    if(value<0 || value>16)++invalid;
    // VirtualDesktopAccessor uses zero-based values: Desktop 1 is 0.
    if(value!=0)++wrong;
    if(value!=previous){++transitions;previous=value;}
    if(std::filesystem::exists(stop))break;
  }
  const auto elapsed=std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-started).count();
  const bool pass=first==0 && previous==0 && transitions==0 && wrong==0 &&
    invalid==0 && total>20 && maxGap<=100;
  std::cout<<"D2_DESKTOP_SWITCH_MONITOR first="<<first
    <<" last="<<previous<<" samples="<<total<<" transitions="<<transitions
    <<" samples_not_desktop1="<<wrong<<" invalid="<<invalid
    <<" max_sample_gap_ms="<<maxGap<<" elapsed_ms="<<elapsed
    <<" result="<<(pass?"PASS":"FAIL")<<"\n";
  FreeLibrary(lib);
  return pass ? 0 : 8;
}
