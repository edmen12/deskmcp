import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquirePidDirectoryLock } from '../dist/src/cross-process-lock.js';

if (process.platform !== 'win32') {
  console.log('AGENT_CONTROL_LOCK_INTEROP=SKIP non-Windows');
  process.exit(0);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredExe = process.env.DESKMCP_CONTROL_PANEL_EXE?.trim();
const candidates = [
  configuredExe,
  path.join(projectRoot, 'control-panel', 'wpf', 'bin', 'Release', 'net10.0-windows', 'win-x64', 'DeskMCP.exe'),
  path.join(projectRoot, 'control-panel', 'wpf', 'bin', 'Release', 'net10.0-windows', 'DeskMCP.exe')
].filter(Boolean);
const controlPanelExe = candidates.find(candidate => existsSync(candidate));
if (!controlPanelExe) throw new Error('DeskMCP Control Panel executable is missing. Build the WPF project first.');

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await stat(file).then(info => info.isFile(), () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for interop marker: ${file}`);
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Interop child process timed out.'));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-agent-lock-interop-'));
const lockDir = path.join(root, 'control.lock');
try {
  const ready = path.join(root, 'csharp.ready');
  const release = path.join(root, 'csharp.release');
  const holder = spawn(controlPanelExe, ['--agent-control-lock-hold', lockDir, ready, release], {
    windowsHide: true,
    stdio: 'ignore'
  });
  const holderExit = waitForExit(holder, 20000);
  await waitForFile(ready);
  await assert.rejects(
    acquirePidDirectoryLock(lockDir, { label: 'Node interop probe', timeoutMs: 150, pollMs: 5 }),
    /busy in another DeskMCP process/i
  );
  await writeFile(release, 'release\n', 'utf8');
  assert.deepEqual(await holderExit, { code: 0, signal: null });

  const nodeLease = await acquirePidDirectoryLock(lockDir, { label: 'Node interop owner', timeoutMs: 1000, pollMs: 5 });
  try {
    const blockedProbe = spawn(controlPanelExe, ['--agent-control-lock-try', lockDir], {
      windowsHide: true,
      stdio: 'ignore'
    });
    assert.deepEqual(await waitForExit(blockedProbe), { code: 42, signal: null });
  } finally {
    await nodeLease.release();
  }

  const succeedingProbe = spawn(controlPanelExe, ['--agent-control-lock-try', lockDir], {
    windowsHide: true,
    stdio: 'ignore'
  });
  assert.deepEqual(await waitForExit(succeedingProbe), { code: 0, signal: null });

  const lockModuleUrl = new URL('../dist/src/cross-process-lock.js', import.meta.url).href;
  const nodeCrashWorker = path.join(root, 'node-crash-owner.mjs');
  const nodeCrashReady = path.join(root, 'node-crash.ready');
  await writeFile(nodeCrashWorker, [
    "import { writeFile } from 'node:fs/promises';",
    `import { acquirePidDirectoryLock } from ${JSON.stringify(lockModuleUrl)};`,
    "const [lockDir, ready] = process.argv.slice(2);",
    "await acquirePidDirectoryLock(lockDir, { label: 'Node crash owner', timeoutMs: 1000, pollMs: 5 });",
    "await writeFile(ready, 'ready\\n', 'utf8');",
    'process.exit(0);',
    ''
  ].join('\n'), 'utf8');
  const nodeCrashOwner = spawn(process.execPath, [nodeCrashWorker, lockDir, nodeCrashReady], {
    windowsHide: true,
    stdio: 'ignore'
  });
  const nodeCrashExit = waitForExit(nodeCrashOwner);
  await waitForFile(nodeCrashReady);
  assert.deepEqual(await nodeCrashExit, { code: 0, signal: null });
  const csharpReclaimer = spawn(controlPanelExe, ['--agent-control-lock-try', lockDir], {
    windowsHide: true,
    stdio: 'ignore'
  });
  assert.deepEqual(await waitForExit(csharpReclaimer), { code: 0, signal: null });

  const csharpCrashReady = path.join(root, 'csharp-crash.ready');
  const csharpCrashRelease = path.join(root, 'csharp-crash.release');
  const csharpCrashOwner = spawn(controlPanelExe, ['--agent-control-lock-hold', lockDir, csharpCrashReady, csharpCrashRelease], {
    windowsHide: true,
    stdio: 'ignore'
  });
  const csharpCrashExit = waitForExit(csharpCrashOwner);
  await waitForFile(csharpCrashReady);
  assert.equal(csharpCrashOwner.kill(), true);
  const crashed = await csharpCrashExit;
  assert.notEqual(crashed.signal === null && crashed.code === 0, true);
  const nodeReclaimer = await acquirePidDirectoryLock(lockDir, { label: 'Node stale C# reclaimer', timeoutMs: 2000, pollMs: 5 });
  await nodeReclaimer.release();

  console.log('AGENT_CONTROL_LOCK_INTEROP=PASS');
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
}
