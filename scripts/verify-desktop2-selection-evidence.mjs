// Offline, sanitized ListBox event comparison; does not start Desktop2 or send input.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { verifySelectionEvidence } from '../dist/src/computer-use-selection-evidence-gate.js';
const [root,day] = process.argv.slice(2);
const stages = ['list-select-probe','list-managed-event-control','list-select-stale'];
if (process.argv.length !== 4 || !path.isAbsolute(root)
  || !/^20\d\d-\d\d-\d\d$/.test(day)) {
  console.error('Usage: node scripts/verify-desktop2-selection-evidence.mjs <absolute-runs-directory> <YYYY-MM-DD>');
  process.exit(2);
}
try {
  const names = await readdir(root);
  const evidence=[];
  for (const stage of stages) {
    const candidates=names.filter(name =>
      name.startsWith('native-'+stage+'-'+day+'T')
      && /^native-list-(select-probe|managed-event-control|select-stale)-20\d\d-\d\d-\d\dT[0-9Z-]+$/.test(name));
    if (candidates.length !== 1) throw Error('AMBIGUOUS_OR_MISSING_STAGE');
    const dir=path.join(root,candidates[0]);
    const result=JSON.parse(await readFile(path.join(dir,'result.json'),'utf8'));
    const timeline=(await readFile(path.join(dir,'steps.jsonl'),'utf8'))
      .split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
    const log=await readFile(path.join(dir,'owned-winforms.events.log'),'utf8');
    const observerPath=result.observerEventPath;
    if(typeof observerPath!=='string'
      || !/[\\/]DMC[\\/]t[\\/]deskmcp-d2-lease-[^\\/]+[\\/]observer\.events\.jsonl$/i.test(observerPath))
      throw Error('OBSERVER_PATH_INVALID');
    const observer=(await readFile(observerPath,'utf8'))
      .split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
    evidence.push(verifySelectionEvidence(stage,result,timeline,observer,log));
  }
  console.log(JSON.stringify({
    status:'OWNED_DESKTOP2_SELECTION_EVENT_COMPARISON_VERIFIED',
    day,stages:evidence,production_action_authorized:false
  }));
}catch(e){console.error(e instanceof Error?e.message:'EVIDENCE_READ_FAILED');process.exitCode=1;}
