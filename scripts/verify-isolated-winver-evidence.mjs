// Evidence verifier reads only locally recorded sanitized fixture outcome.
// No GUI launch, VDA access, lease creation, browser, window enumeration or input.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assessIsolatedWinverReadEvidence} from '../dist/src/computer-use-win32-object-evidence.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.length!==2)throw Error('NO_PARAMETERS_ACCEPTED');
try{
  const file=path.join(root,'test-area','isolated-thirdparty-prelaunch',
    'runs','winver-isolated-object-result.json');
  const raw=JSON.parse(await readFile(file,'utf8'));
  console.log(JSON.stringify(assessIsolatedWinverReadEvidence(raw)));
}catch{
  console.error('ISOLATED_WIN32_UIA_EVIDENCE_NOT_ACCEPTED');
  process.exitCode=1;
}
