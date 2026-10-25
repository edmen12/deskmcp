// Read only exact archived 2026-10-10 Chrome E2E results, never launch browser.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {assessChromeD2Result} from '../dist/src/computer-use-thirdparty-evidence.js';

const directory=process.argv[2];
if(process.argv.length!==3||!path.isAbsolute(directory)) {
  console.error('Usage: node scripts/verify-thirdparty-chrome-evidence.mjs <absolute-runs-directory>');
  process.exit(2);
}
const archived=[
  'real-thirdparty-chrome-2026-10-10T11-59-12-414Z',
  'real-thirdparty-chrome-2026-10-10T12-02-40-851Z',
  'real-thirdparty-chrome-2026-10-10T12-08-10-109Z'
];
try {
 const checks=[];
 for(const name of archived) {
  const json=JSON.parse(await readFile(path.join(directory,name,'result.json'),'utf8'));
  checks.push(assessChromeD2Result(json));
 }
 console.log(JSON.stringify({
   status:'ARCHIVED_CHROME_REAL_DESKTOP2_EVIDENCE_REVIEWED',
   chrome_specific_cases:checks.length,
   owned_browser_foreground_zero:checks.every(x=>x.owned_browser_foreground_events===0),
   entire_foreground_quiet_cases:checks.filter(x=>x.all_session_foreground_quiet).length,
   unrelated_foreground_events:checks.reduce((n,x)=>n+x.unrelated_foreground_events,0),
   generalized_native_computer_use_approved:false,
   production_release_approved:false
 }));
}catch(e){console.error(e instanceof Error?e.message:'ARCHIVE_READ_FAILED');process.exitCode=1;}
