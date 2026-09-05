import { spawnSync } from 'node:child_process';

if (process.platform === 'darwin') {
  const result = spawnSync(
    '/bin/bash',
    ['scripts/build-macos-process-host.sh'],
    { stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log('PROCESS_HOST_PRETEST=OK platform=darwin');
  process.exit(0);
}

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
console.log('PROCESS_HOST_PRETEST=OK platform=win32');
