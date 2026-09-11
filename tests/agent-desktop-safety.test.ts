import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgentDesktopNativeBridge } from '../src/agent-desktop-native.js';
import { AgentDesktopManager } from '../src/agent-desktop-state.js';

async function writeJson(pathname: string, value: unknown): Promise<void> {
  const temp = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temp, pathname);
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  return pid;
}

test('Agent Desktop init reclaims a dead-owner control lock instead of remaining permanently busy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-agent-desktop-stale-lock-'));
  try {
    const lockDir = path.join(root, 'control.lock');
    await mkdir(lockDir);
    await writeJson(path.join(lockDir, 'owner.json'), {
      schema_version: 1,
      pid: await deadPid(),
      token: randomUUID(),
      created_at: new Date(Date.now() - 60_000).toISOString()
    });

    const manager = new AgentDesktopManager(root, {} as AgentDesktopNativeBridge);
    await manager.init();
    await assert.rejects(stat(lockDir), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Desktop lease stays valid while native guard is armed but HUD is hidden on Desktop 1', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-agent-desktop-'));
  try {
    const manager = new AgentDesktopManager(root, {} as AgentDesktopNativeBridge);
    await manager.init();
    const leaseId = randomUUID();
    const now = new Date().toISOString();

    await writeJson(path.join(root, 'config.json'), {
      schemaVersion: 1,
      desktopId: randomUUID(),
      desktopNumber: 1,
      boundAtUtc: now
    });
    await writeJson(path.join(root, 'control.json'), {
      schemaVersion: 1,
      generation: 3,
      active: true,
      leaseId,
      startedAtUtc: now
    });
    await writeJson(path.join(root, 'hud-state.json'), {
      schemaVersion: 1,
      generation: 3,
      leaseId,
      armed: true,
      visible: false,
      processId: 1234,
      heartbeatAtUtc: new Date().toISOString()
    });

    await assert.doesNotReject(manager.assertLease(leaseId));
    const hidden = await manager.status();
    assert.equal(hidden.hud_ready, true);
    assert.equal(hidden.hud_visible, false);

    await writeJson(path.join(root, 'hud-state.json'), {
      schemaVersion: 1,
      generation: 3,
      leaseId,
      armed: true,
      visible: true,
      processId: 1234,
      heartbeatAtUtc: new Date().toISOString()
    });
    const visible = await manager.status();
    assert.equal(visible.hud_ready, true);
    assert.equal(visible.hud_visible, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Desktop rejects a heartbeat that is visible but not armed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-agent-desktop-'));
  try {
    const manager = new AgentDesktopManager(root, {} as AgentDesktopNativeBridge);
    await manager.init();
    const leaseId = randomUUID();
    const now = new Date().toISOString();
    await writeJson(path.join(root, 'config.json'), {
      schemaVersion: 1,
      desktopId: randomUUID(),
      desktopNumber: 1,
      boundAtUtc: now
    });
    await writeJson(path.join(root, 'control.json'), {
      schemaVersion: 1,
      generation: 5,
      active: true,
      leaseId,
      startedAtUtc: now
    });
    await writeJson(path.join(root, 'hud-state.json'), {
      schemaVersion: 1,
      generation: 5,
      leaseId,
      visible: true,
      processId: 1234,
      heartbeatAtUtc: new Date().toISOString()
    });

    await assert.rejects(manager.assertLease(leaseId), /heartbeat is missing or stale/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('Task-linked Agent Desktop control only auto-stops for the matching task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-agent-desktop-'));
  try {
    const manager = new AgentDesktopManager(root, {} as AgentDesktopNativeBridge);
    await manager.init();
    const leaseId = randomUUID();
    const now = new Date().toISOString();
    const taskId = 'tsk_0123456789abcdef';

    await writeJson(path.join(root, 'config.json'), {
      schemaVersion: 1,
      desktopId: randomUUID(),
      desktopNumber: 1,
      boundAtUtc: now
    });
    await writeJson(path.join(root, 'control.json'), {
      schemaVersion: 1,
      generation: 7,
      active: true,
      leaseId,
      taskId,
      taskLabel: 'Bound task',
      startedAtUtc: now
    });
    await writeJson(path.join(root, 'hud-state.json'), {
      schemaVersion: 1,
      generation: 7,
      leaseId,
      armed: true,
      visible: true,
      processId: 1234,
      heartbeatAtUtc: new Date().toISOString()
    });

    const wrong = await manager.stopControlForTask('tsk_fedcba9876543210');
    assert.equal(wrong.stopped, false);
    assert.equal(wrong.status.control.active, true);
    assert.equal(wrong.status.control.leaseId, leaseId);

    const matched = await manager.stopControlForTask(taskId);
    assert.equal(matched.stopped, true);
    assert.equal(matched.leaseId, leaseId);
    assert.equal(matched.status.control.active, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('Agent Desktop pool allocates distinct bound desktops before reporting busy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-agent-desktop-pool-'));
  try {
    const native = {
      async info() { return { officialApi: true, virtualDesktopAccessor: true }; }
    } as unknown as AgentDesktopNativeBridge;
    const manager = new AgentDesktopManager(root, native);
    await manager.init();
    const now = new Date().toISOString();
    const desktopA = randomUUID();
    const desktopB = randomUUID();
    await writeJson(path.join(root, 'config.json'), {
      schemaVersion: 2,
      bindings: [
        { schemaVersion: 1, desktopId: desktopA, desktopNumber: 1, boundAtUtc: now },
        { schemaVersion: 1, desktopId: desktopB, desktopNumber: 2, boundAtUtc: now }
      ]
    });

    const armUntil = async (count: number): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const raw = JSON.parse(await readFile(path.join(root, 'control.json'), 'utf8')) as {
          schemaVersion?: number;
          controls?: Array<{ generation: number; leaseId: string }>;
        };
        const controls = raw.schemaVersion === 2 && Array.isArray(raw.controls) ? raw.controls : [];
        if (controls.length >= count) {
          await writeJson(path.join(root, 'hud-state.json'), {
            schemaVersion: 2,
            entries: controls.map(control => ({
              schemaVersion: 1,
              generation: control.generation,
              leaseId: control.leaseId,
              armed: true,
              visible: false,
              processId: 1234,
              heartbeatAtUtc: new Date().toISOString()
            }))
          });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Timed out waiting for Agent Desktop pool control state.');
    };

    const firstPromise = manager.startControl('Agent A');
    await armUntil(1);
    const first = await firstPromise;
    assert.equal(first.control.desktopId, desktopA);
    assert.equal(first.control.desktopNumber, 1);

    const secondPromise = manager.startControl('Agent B');
    await armUntil(2);
    const second = await secondPromise;
    assert.equal(second.control.desktopId, desktopB);
    assert.equal(second.control.desktopNumber, 2);
    assert.notEqual(second.control.leaseId, first.control.leaseId);

    const status = await manager.status();
    assert.equal(status.bindings.length, 2);
    assert.equal(status.controls.length, 2);
    assert.equal(status.available_desktops, 0);
    await assert.rejects(manager.startControl('Agent C'), /all bound agent desktops are busy/i);

    await manager.stopControl(first.control.leaseId!);
    const afterStop = await manager.status();
    assert.equal(afterStop.controls.length, 1);
    assert.equal(afterStop.available_desktops, 1);
    assert.equal(afterStop.controls[0]?.leaseId, second.control.leaseId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('Agent Desktop process-tree placement keeps owned descendant GUI windows on the lease desktop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-agent-process-tree-'));
  try {
    const leaseId = randomUUID();
    const desktopId = randomUUID();
    const now = new Date().toISOString();
    let observed: { processId: number; desktopId: string; timeoutMs: number | undefined } | undefined;
    const native = {
      async moveProcessTreeWindows(processId: number, targetDesktopId: string, options: { timeoutMs?: number }) {
        observed = { processId, desktopId: targetDesktopId, timeoutMs: options.timeoutMs };
        return {
          processId,
          moved: 2,
          windows: [
            { hwnd: '0x101', desktopId: targetDesktopId, desktopNumber: 2 },
            { hwnd: '0x102', desktopId: targetDesktopId, desktopNumber: 2 }
          ]
        };
      }
    } as unknown as AgentDesktopNativeBridge;
    const manager = new AgentDesktopManager(root, native);
    await manager.init();
    await writeJson(path.join(root, 'config.json'), {
      schemaVersion: 2,
      bindings: [{ schemaVersion: 1, desktopId, desktopNumber: 2, boundAtUtc: now }]
    });
    await writeJson(path.join(root, 'control.json'), {
      schemaVersion: 2,
      generation: 9,
      controls: [{
        schemaVersion: 1,
        generation: 9,
        active: true,
        leaseId,
        desktopId,
        desktopNumber: 2,
        taskLabel: 'GUI placement',
        startedAtUtc: now
      }]
    });
    await writeJson(path.join(root, 'hud-state.json'), {
      schemaVersion: 2,
      entries: [{
        schemaVersion: 1,
        generation: 9,
        leaseId,
        armed: true,
        visible: false,
        processId: 1234,
        heartbeatAtUtc: new Date().toISOString()
      }]
    });

    await manager.placeProcessTreeWindows(4321, leaseId);
    assert.deepEqual(observed, { processId: 4321, desktopId, timeoutMs: 15000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
