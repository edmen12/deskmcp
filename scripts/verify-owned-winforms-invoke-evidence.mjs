// Offline read-only consistency check, uses only ignored local self-owned fixture logs.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {checkOwnedWinFormsInvokeEvidence} from '../dist/src/computer-use-owned-invoke-evidence.js';
const stamp=process.argv[2];
if(process.argv.length!==3 || !/^[a-z0-9]{6,16}$/u.test(stamp??'')) {
  console.error('Usage: node scripts/verify-owned-winforms-invoke-evidence.mjs <owned-run-stamp>');
  process.exit(2);
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runs=path.join(root,'test-area','isolated-thirdparty-prelaunch','runs');
try {
  const result=JSON.parse(await readFile(path.join(runs,'owned-winforms-ui-invoke-result.json'),'utf8'));
  const app=await readFile(path.join(runs,'owned-winforms-'+stamp+'.events.log'),'utf8');
  console.log(JSON.stringify(checkOwnedWinFormsInvokeEvidence(result,app,stamp)));
}catch(e) {
  console.error(e instanceof Error && /^OWNED_INVOKE_/.test(e.message)?e.message:'OWNED_INVOKE_EVIDENCE_UNAVAILABLE');
  process.exitCode=1;
}
