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

const target = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
const disclosure = spawnSync(
  `runtime\\process-host\\${target}\\DeskMCP.ProcessHost.exe`,
  ['--elevation-disclosure-self-test'],
  { stdio: 'inherit', windowsHide: true }
);
if (disclosure.error) throw disclosure.error;
if (disclosure.status !== 0) process.exit(disclosure.status ?? 1);

const smoke = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/test-process-host-hidden-admin.ps1',
    '-Target', target
  ],
  { stdio: 'inherit', windowsHide: true }
);
if (smoke.error) throw smoke.error;
if (smoke.status !== 0) process.exit(smoke.status ?? 1);
console.log(`PROCESS_HOST_PRETEST=OK target=${target}`);
