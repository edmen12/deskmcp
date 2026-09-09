import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
