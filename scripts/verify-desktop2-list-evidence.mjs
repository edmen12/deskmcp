// Read and validate existing owned Desktop2 acceptance traces; never launches a process,
// changes a desktop, or prints HWND/PID/lease tokens or raw observer paths.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { verifyNativeListDesktop2Evidence } from '../dist/src/computer-use-evidence-gate.js';

const [directory, day] = process.argv.slice(2);
const stages = ['list-inspect', 'list-deny-stale', 'list-scroll'];
if (process.argv.length !== 4 || !path.isAbsolute(directory)
  || !/^20\d\d-\d\d-\d\d$/.test(day)) {
  console.error('Usage: node scripts/verify-desktop2-list-evidence.mjs <absolute-runs-directory> <YYYY-MM-DD>');
  process.exit(2);
}
try {
  const entries = await readdir(directory, { withFileTypes: true });
  const summaries = [];
  for (const stage of stages) {
    const matches = entries.filter(entry =>
      entry.isDirectory() && entry.name.startsWith('native-' + stage + '-' + day + 'T')
      && /^native-list-(inspect|deny-stale|scroll)-20\d\d-\d\d-\d\dT[0-9Z-]+$/.test(entry.name)
    );
    if (matches.length !== 1) throw new Error('MISSING_OR_AMBIGUOUS_STAGE');
    const base = path.join(directory, matches[0].name);
    const result = JSON.parse(await readFile(path.join(base, 'result.json'), 'utf8'));
    const timeline = (await readFile(path.join(base, 'steps.jsonl'), 'utf8'))
      .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const applicationLog = await readFile(path.join(base, 'owned-winforms.events.log'), 'utf8');
    const observerPath = result.observerEventPath;
    if (typeof observerPath !== 'string'
      || !/^.+[\\/]DMC[\\/]t[\\/]deskmcp-d2-lease-[^\\/]+[\\/]observer\.events\.jsonl$/i.test(observerPath)) {
      throw new Error('OBSERVER_PATH_INVALID');
    }
    const observer = (await readFile(observerPath, 'utf8'))
      .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    summaries.push(verifyNativeListDesktop2Evidence(stage, result, timeline, observer, applicationLog));
  }
  console.log(JSON.stringify({ status: 'OWNED_DESKTOP2_LIST_TRACES_VERIFIED',
    day, stages: summaries, production_native_action_authorized: false }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'EVIDENCE_READ_FAILED');
  process.exitCode = 1;
}
