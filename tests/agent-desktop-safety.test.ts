import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgentDesktopNativeBridge } from '../src/agent-desktop-native.js';
import { AgentDesktopManager } from '../src/agent-desktop-state.js';

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

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
