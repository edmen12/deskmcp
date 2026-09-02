import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log(`PROCESS_HOST_PRETEST=SKIP platform=${process.platform}`);
  process.exit(0);
}

const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-process-host.ps1'],
  { stdio: 'inherit', windowsHide: true }
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('PROCESS_HOST_PRETEST=OK');
