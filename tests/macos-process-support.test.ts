import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildDarwinPath,
  buildDesktopCommanderEnvironment,
  DesktopCommanderBridge
} from '../src/desktop-commander-bridge.js';
import { PROJECT_ROOT } from '../src/paths.js';

function countEntry(entries: string[], value: string): number {
  return entries.filter(entry => entry === value).length;
}

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

async function waitUntilProcessGone(pid: number, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isMissingProcess(error)) return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Process ${pid} was still alive after ${timeoutMs}ms`);
}

test('Darwin PATH bootstrap includes Homebrew and common user bins without duplicates', () => {
  const value = buildDarwinPath(
    '/usr/bin:/opt/homebrew/bin:/custom/bin:/usr/bin',
    '/Users/example'
  );
  const entries = value.split(':');

  assert.equal(entries[0], '/opt/homebrew/bin');
  assert.ok(entries.includes('/opt/homebrew/sbin'));
  assert.ok(entries.includes('/usr/local/bin'));
  assert.ok(entries.includes('/Users/example/.local/bin'));
  assert.ok(entries.includes('/Users/example/.cargo/bin'));
  assert.ok(entries.includes('/Users/example/.bun/bin'));
  assert.ok(entries.includes('/custom/bin'));
  assert.equal(countEntry(entries, '/usr/bin'), 1);
  assert.equal(countEntry(entries, '/opt/homebrew/bin'), 1);
});

test('Desktop Commander Darwin environment repairs PATH and supplies a shell default', () => {
  const environment = buildDesktopCommanderEnvironment(
    { PATH: '/usr/bin', HOME: '/Users/example' },
    'darwin'
  );

  const envPath = environment.PATH ?? '';
  assert.ok(envPath.startsWith('/opt/homebrew/bin:'));
  assert.ok(envPath.includes('/Users/example/.local/bin'));
  assert.ok(environment.SHELL);
});

test('non-Darwin Desktop Commander environment is not rewritten', () => {
  const base = { PATH: 'C:\\Windows\\System32', HOME: 'C:\\Users\\Example' };
  assert.deepEqual(buildDesktopCommanderEnvironment(base, 'win32'), base);
});

test('macOS owned process termination kills descendants in the same process group', {
  skip: process.platform !== 'darwin'
}, async () => {
  const fixture = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'macos-process-tree.mjs');
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`;
  const bridge = new DesktopCommanderBridge();
  let rootPid: number | undefined;

  try {
    await bridge.start();
    const started = await bridge.startProcess(command, 1500, 'auto');
    assert.equal(started.isError, false, started.text);

    const rootMatch = started.text.match(/Process started with PID\s+(\d+)/i);
    assert.ok(rootMatch?.[1], `Missing root PID in: ${started.text}`);
    rootPid = Number.parseInt(rootMatch[1], 10);

    let output = started.text;
    if (!/DESCENDANT_PID=\d+/.test(output)) {
      const read = await bridge.readProcessOutput(rootPid, 1500, 0, 200);
      assert.equal(read.isError, false, read.text);
      output += `\n${read.text}`;
    }

    const childMatch = output.match(/DESCENDANT_PID=(\d+)/);
    assert.ok(childMatch?.[1], `Missing descendant PID in: ${output}`);
    const childPid = Number.parseInt(childMatch[1], 10);
    assert.notEqual(childPid, rootPid);

    const terminated = await bridge.forceTerminateProcess(rootPid);
    assert.equal(terminated.isError, false, terminated.text);
    await waitUntilProcessGone(childPid);
  } finally {
    if (rootPid !== undefined) {
      await bridge.forceTerminateProcess(rootPid).catch(() => undefined);
    }
    await bridge.close();
  }
});
