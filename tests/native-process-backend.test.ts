import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { NativeWindowsProcessBackend } from '../src/native-process-backend.js';
import { PROJECT_ROOT, TEST_AREA } from '../src/paths.js';

const processHost = path.join(
  PROJECT_ROOT,
  'runtime',
  'process-host',
  process.arch === 'arm64' ? 'win-arm64' : 'win-x64',
  'DeskMCP.ProcessHost.exe'
);

function pidFrom(text: string): number {
  const match = text.match(/Process started with PID\s+(\d+)/i);
  assert.ok(match, 'native process start result did not expose its internal PID');
  const pid = Number.parseInt(match[1] ?? '0', 10);
  assert.ok(pid > 0);
  return pid;
}

test('native Windows process backend retains completed output for later reads', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only native process backend');
    return;
  }

  const backend = new NativeWindowsProcessBackend(processHost);
  const tempRoot = path.join(TEST_AREA, 'native-process-backend-complete-temp');
  await rm(tempRoot, { recursive: true, force: true });

  try {
    const started = await backend.start(
      'node -e "console.log(\'NATIVE_COMPLETE_OK\')"',
      5000,
      'cmd.exe',
      'hidden',
      'standard',
      'root',
      TEST_AREA,
      tempRoot
    );
    assert.equal(started.isError, false);
    assert.match(started.text, /NATIVE_COMPLETE_OK/);
    assert.match(started.text, /Process completed with exit code 0/);
    const pid = pidFrom(started.text);

    const listed = backend.list();
    assert.equal(listed.isError, false);
    assert.doesNotMatch(listed.text, new RegExp(`PID: ${pid}\\b`));

    const read = await backend.read(pid, 100, 0, 100);
    assert.equal(read.isError, false);
    assert.match(read.text, /NATIVE_COMPLETE_OK/);
    assert.match(read.text, /Process completed with exit code 0/);
  } finally {
    await backend.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('native Windows process backend supports interactive stdin and explicit termination', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only native process backend');
    return;
  }

  const backend = new NativeWindowsProcessBackend(processHost);
  try {
    const started = await backend.start(
      'node -i',
      500,
      'cmd.exe',
      'hidden',
      'standard',
      'root',
      TEST_AREA
    );
    assert.equal(started.isError, false);
    const pid = pidFrom(started.text);
    assert.match(backend.list().text, new RegExp(`PID: ${pid}\\b`));

    const interacted = await backend.interact(
      pid,
      'console.log("NATIVE_INTERACT_OK")',
      5000,
      true
    );
    assert.equal(interacted.isError, false);
    assert.match(interacted.text, /NATIVE_INTERACT_OK/);

    const read = await backend.read(pid, 1000, -100, 100);
    assert.equal(read.isError, false);
    assert.match(read.text, /NATIVE_INTERACT_OK/);

    const terminated = await backend.terminate(pid);
    assert.equal(terminated.isError, false);
    assert.doesNotMatch(backend.list().text, new RegExp(`PID: ${pid}\\b`));

    const after = await backend.read(pid, 0, 0, 10);
    assert.equal(after.isError, true);
    assert.match(after.text, /No session found/);
  } finally {
    await backend.close();
  }
});

test('native Windows process backend terminates a long-running ProcessHost-owned tree', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only native process backend');
    return;
  }

  const backend = new NativeWindowsProcessBackend(processHost);
  try {
    const started = await backend.start(
      'node -e "setInterval(()=>{},1000)"',
      250,
      'cmd.exe',
      'hidden',
      'standard',
      'root',
      TEST_AREA
    );
    assert.equal(started.isError, false);
    const pid = pidFrom(started.text);
    assert.match(backend.list().text, new RegExp(`PID: ${pid}\\b`));

    const terminated = await backend.terminate(pid);
    assert.equal(terminated.isError, false);
    assert.doesNotMatch(backend.list().text, new RegExp(`PID: ${pid}\\b`));
  } finally {
    await backend.close();
  }
});
