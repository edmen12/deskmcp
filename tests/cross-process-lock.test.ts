import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquirePidDirectoryLock, inspectPidDirectoryLock } from '../src/cross-process-lock.js';

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

async function writeStaleOwner(lockDir: string, pid: number, token = randomUUID()): Promise<string> {
  await mkdir(lockDir, { recursive: false });
  await writeFile(path.join(lockDir, 'owner.json'), `${JSON.stringify({
    schema_version: 1,
    pid,
    token,
    created_at: new Date(Date.now() - 60_000).toISOString()
  })}\n`, 'utf8');
  return token;
}

async function withFixture(run: (root: string, lockDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-lock-'));
  const lockDir = path.join(root, 'resource.lock');
  try { await run(root, lockDir); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }); }
}

test('active owner excludes a second contender', async () => {
  await withFixture(async (_root, lockDir) => {
    const first = await acquirePidDirectoryLock(lockDir, { label: 'test', timeoutMs: 500, pollMs: 10 });
    await assert.rejects(
      acquirePidDirectoryLock(lockDir, { label: 'test', timeoutMs: 80, pollMs: 10 }),
      /busy in another DeskMCP process/i
    );
    assert.equal(await inspectPidDirectoryLock(lockDir), 'active');
    await first.release();
    assert.equal(await inspectPidDirectoryLock(lockDir), 'missing');
  });
});

test('dead owner is reclaimed safely', async () => {
  await withFixture(async (_root, lockDir) => {
    await writeStaleOwner(lockDir, await deadPid());
    assert.equal(await inspectPidDirectoryLock(lockDir), 'stale');
    const lease = await acquirePidDirectoryLock(lockDir, { label: 'test', timeoutMs: 1000, pollMs: 5 });
    assert.equal(await inspectPidDirectoryLock(lockDir), 'active');
    await lease.release();
  });
});

test('post-reclaim failure releases the transition after canonical retirement', async () => {
  await withFixture(async (_root, lockDir) => {
    await writeStaleOwner(lockDir, await deadPid());
    let injected = false;
    await assert.rejects(
      acquirePidDirectoryLock(lockDir, {
        label: 'post-reclaim failure',
        timeoutMs: 1000,
        pollMs: 5,
        testHooks: {
          afterRecoveryDirectoryRetired: () => {
            if (injected) return;
            injected = true;
            throw new Error('INJECTED_POST_RECLAIM_FAILURE');
          }
        }
      }),
      /INJECTED_POST_RECLAIM_FAILURE/
    );
    assert.equal(await inspectPidDirectoryLock(lockDir), 'missing');
    const next = await acquirePidDirectoryLock(lockDir, { label: 'next owner', timeoutMs: 1000, pollMs: 5 });
    await next.release();
  });
});

test('post-release failure does not strand the transition after canonical retirement', async () => {
  await withFixture(async (_root, lockDir) => {
    let injected = false;
    const lease = await acquirePidDirectoryLock(lockDir, {
      label: 'post-release failure',
      timeoutMs: 1000,
      pollMs: 5,
      testHooks: {
        afterReleaseDirectoryRetired: () => {
          if (injected) return;
          injected = true;
          throw new Error('INJECTED_POST_RELEASE_FAILURE');
        }
      }
    });
    await assert.rejects(lease.release(), /INJECTED_POST_RELEASE_FAILURE/);
    assert.equal(await inspectPidDirectoryLock(lockDir), 'missing');
    await assert.doesNotReject(lease.release());
    await assert.doesNotReject(lease.release());
    const next = await acquirePidDirectoryLock(lockDir, { label: 'next owner', timeoutMs: 1000, pollMs: 5 });
    await next.release();
  });
});

test('concurrent release calls serialize and remain idempotent', async () => {
  await withFixture(async (_root, lockDir) => {
    let enteredResolve!: () => void;
    let continueResolve!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const continueRelease = new Promise<void>(resolve => { continueResolve = resolve; });
    let held = false;
    const lease = await acquirePidDirectoryLock(lockDir, {
      label: 'concurrent release',
      timeoutMs: 1000,
      pollMs: 5,
      testHooks: {
        afterReleaseDirectoryRetired: async () => {
          if (held) return;
          held = true;
          enteredResolve();
          await continueRelease;
        }
      }
    });

    const first = lease.release();
    await entered;
    const second = lease.release();
    await new Promise(resolve => setTimeout(resolve, 10));
    continueResolve();
    await Promise.all([first, second]);
    await assert.doesNotReject(lease.release());
    assert.equal(await inspectPidDirectoryLock(lockDir), 'missing');
  });
});

test('release retry after canonical retirement never deletes a replacement transition', async () => {
  await withFixture(async (_root, lockDir) => {
    const transitionDir = `${lockDir}.transition`;
    const transitionOwnerPath = path.join(transitionDir, 'owner.json');
    let replacementToken = '';
    let injected = false;
    const lease = await acquirePidDirectoryLock(lockDir, {
      label: 'replacement transition',
      timeoutMs: 1000,
      pollMs: 5,
      testHooks: {
        afterReleaseDirectoryRetired: async () => {
          if (injected) return;
          injected = true;
          const original = JSON.parse(await readFile(transitionOwnerPath, 'utf8')) as Record<string, unknown>;
          replacementToken = randomUUID();
          await rm(transitionDir, { recursive: true, force: true });
          await mkdir(transitionDir);
          await writeFile(transitionOwnerPath, `${JSON.stringify({
            ...original,
            token: replacementToken,
            created_at: new Date().toISOString()
          })}\n`, 'utf8');
          throw new Error('INJECTED_REPLACEMENT_TRANSITION');
        }
      }
    });

    await assert.rejects(lease.release(), /release failed and transition release also failed/i);
    await assert.doesNotReject(lease.release());
    const replacement = JSON.parse(await readFile(transitionOwnerPath, 'utf8')) as Record<string, unknown>;
    assert.equal(replacement.token, replacementToken);
    await rm(transitionDir, { recursive: true, force: true });
    assert.equal(await inspectPidDirectoryLock(lockDir), 'missing');
  });
});

test('invalid owner metadata fails closed', async () => {
  await withFixture(async (_root, lockDir) => {
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, 'owner.json'), '{"schema_version":1,"pid":"bad"}\n', 'utf8');
    assert.equal(await inspectPidDirectoryLock(lockDir, 10), 'invalid');
    await assert.rejects(
      acquirePidDirectoryLock(lockDir, { label: 'test', timeoutMs: 100, initializationGraceMs: 10, pollMs: 5 }),
      /metadata is invalid; refusing unsafe automatic recovery/i
    );
  });
});

test('release never removes a lock whose ownership token changed', async () => {
  await withFixture(async (_root, lockDir) => {
    const lease = await acquirePidDirectoryLock(lockDir, { label: 'test' });
    const ownerPath = path.join(lockDir, 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<string, unknown>;
    await writeFile(ownerPath, `${JSON.stringify({ ...owner, token: randomUUID() })}\n`, 'utf8');
    await assert.rejects(lease.release(), /ownership changed before (release|retirement)/i);
    assert.equal(await inspectPidDirectoryLock(lockDir), 'active');
  });
});

test('50 simultaneous stale reclaim contenders never overlap critical sections', async () => {
  await withFixture(async (_root, lockDir) => {
    await writeStaleOwner(lockDir, await deadPid());
    let active = 0;
    let maxActive = 0;
    const workers = Array.from({ length: 50 }, async () => {
      const lease = await acquirePidDirectoryLock(lockDir, { label: 'stress', timeoutMs: 10_000, pollMs: 2 });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 3));
      active -= 1;
      await lease.release();
    });
    await Promise.all(workers);
    assert.equal(maxActive, 1);
    assert.equal(active, 0);
  });
});

test('a recovery marker keeps the canonical stale lock occupied until recovery handoff', async () => {
  await withFixture(async (_root, lockDir) => {
    await writeStaleOwner(lockDir, await deadPid());
    let releaseRecovery!: () => void;
    let recoveryEntered!: () => void;
    const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve; });
    const recoveryStarted = new Promise<void>(resolve => { recoveryEntered = resolve; });

    let firstEntered = false;
    let secondEntered = false;
    const firstPromise = acquirePidDirectoryLock(lockDir, {
      label: 'delayed',
      timeoutMs: 5000,
      pollMs: 2,
      testHooks: {
        afterRecoveryMarkerAcquired: async () => {
          recoveryEntered();
          await recoveryGate;
        }
      }
    }).then(lease => {
      firstEntered = true;
      return { who: 'first' as const, lease };
    });
    await recoveryStarted;
    assert.equal(await inspectPidDirectoryLock(lockDir), 'recovering');

    const secondPromise = acquirePidDirectoryLock(lockDir, { label: 'second', timeoutMs: 5000, pollMs: 2 })
      .then(lease => {
        secondEntered = true;
        return { who: 'second' as const, lease };
      });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(firstEntered, false);
    assert.equal(secondEntered, false);

    releaseRecovery();
    const winner = await Promise.race([firstPromise, secondPromise]);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(Number(firstEntered) + Number(secondEntered), 1);
    await winner.lease.release();

    const loser = winner.who === 'first' ? await secondPromise : await firstPromise;
    assert.notEqual(loser.who, winner.who);
    await loser.lease.release();
  });
});

test('a delayed old-generation reclaimer cannot remove a newly acquired owner', async () => {
  await withFixture(async (_root, lockDir) => {
    await writeStaleOwner(lockDir, await deadPid());
    let releaseDelayed!: () => void;
    let delayedEntered!: () => void;
    const delayedGate = new Promise<void>(resolve => { releaseDelayed = resolve; });
    const delayedStarted = new Promise<void>(resolve => { delayedEntered = resolve; });

    let delayedAcquired = false;
    const delayedPromise = acquirePidDirectoryLock(lockDir, {
      label: 'old reclaimer',
      timeoutMs: 5000,
      pollMs: 2,
      testHooks: {
        beforeRecoveryMarkerAcquire: async () => {
          delayedEntered();
          await delayedGate;
        }
      }
    }).then(lease => {
      delayedAcquired = true;
      return lease;
    });
    await delayedStarted;

    const newOwner = await acquirePidDirectoryLock(lockDir, { label: 'new owner', timeoutMs: 5000, pollMs: 2 });
    const ownerBefore = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8')) as { token?: unknown };
    assert.equal(ownerBefore.token, newOwner.token);

    releaseDelayed();
    await new Promise(resolve => setTimeout(resolve, 60));
    const ownerAfter = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8')) as { token?: unknown };
    assert.equal(ownerAfter.token, newOwner.token);
    assert.equal(delayedAcquired, false);

    await newOwner.release();
    const delayed = await delayedPromise;
    await delayed.release();
  });
});

test('an abandoned stale-recovery marker fails closed instead of being recursively reclaimed', async () => {
  await withFixture(async (_root, lockDir) => {
    const stalePid = await deadPid();
    const staleToken = await writeStaleOwner(lockDir, stalePid);
    const recoveryDir = `${lockDir}.transition`;
    await mkdir(recoveryDir);
    await writeFile(path.join(recoveryDir, 'owner.json'), `${JSON.stringify({
      schema_version: 1,
      kind: 'reclaim',
      pid: await deadPid(),
      token: randomUUID(),
      expected_owner_pid: stalePid,
      expected_owner_token: staleToken,
      created_at: new Date(Date.now() - 60_000).toISOString()
    })}\n`, 'utf8');
    assert.equal(await inspectPidDirectoryLock(lockDir, 10), 'invalid');
    await assert.rejects(
      acquirePidDirectoryLock(lockDir, { label: 'test', timeoutMs: 100, initializationGraceMs: 10, pollMs: 5 }),
      /transition metadata is invalid or abandoned; refusing unsafe automatic takeover/i
    );
  });
});

test('independent Node processes reclaim one stale lock without critical-section overlap', async () => {
  await withFixture(async (root, lockDir) => {
    const workerCount = 12;
    const readyDir = path.join(root, 'ready');
    const gatePath = path.join(root, 'start.gate');
    const criticalDir = path.join(root, 'critical-section');
    await mkdir(readyDir);
    await writeStaleOwner(lockDir, await deadPid());

    const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cross-process-lock-worker.js');
    const workers = Array.from({ length: workerCount }, (_, index) => {
      const child = spawn(process.execPath, [workerPath, lockDir, readyDir, gatePath, criticalDir, String(index)], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      return {
        child,
        result: new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
        })
      };
    });

    const readyDeadline = Date.now() + 15_000;
    while ((await readdir(readyDir)).length < workerCount) {
      if (Date.now() >= readyDeadline) {
        for (const worker of workers) worker.child.kill();
        throw new Error('cross-process workers did not all become ready before timeout.');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    await writeFile(gatePath, 'go\n', { encoding: 'utf8', flag: 'wx' });
    const results = await Promise.all(workers.map(worker => worker.result));
    const failures = results.filter(result => result.code !== 0 || result.signal !== null);
    assert.deepEqual(
      failures.map(result => ({ code: result.code, signal: result.signal, stderr: result.stderr.trim(), stdout: result.stdout.trim() })),
      []
    );
    assert.equal(await inspectPidDirectoryLock(lockDir), 'missing');
    await assert.rejects(stat(criticalDir), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  });
});
