import assert from 'node:assert/strict';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DesktopPolicy } from '../src/desktop-policy.js';
import { TEST_AREA } from '../src/paths.js';

const sandbox = path.join(TEST_AREA, 'policy-sandbox');
const allowed = path.join(sandbox, 'allowed');
const outside = path.join(sandbox, 'outside');
const insideFile = path.join(allowed, 'inside.txt');
const outsideFile = path.join(outside, 'outside.txt');

async function prepare(): Promise<void> {
  await rm(sandbox, { recursive: true, force: true });
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(insideFile, 'INSIDE', 'utf8');
  await writeFile(outsideFile, 'OUTSIDE', 'utf8');
}

test('DesktopPolicy enforces profile and allowed-root boundaries', async () => {
  await prepare();
  try {
    const readOnly = await DesktopPolicy.create({
      profile: 'read-only',
      allowedRoots: [allowed]
    });
    assert.equal(readOnly.info().profile, 'read-only');
    assert.equal(readOnly.canWrite(), false);
    assert.equal(await readOnly.resolveReadPath(insideFile), await realpath(insideFile));
    await assert.rejects(
      readOnly.resolveReadPath(outsideFile),
      /outside DESKTOP_MCP_ALLOWED_ROOTS/
    );
    await assert.rejects(
      readOnly.resolveWritePath(path.join(allowed, 'new.txt')),
      /read-only/
    );

    const writable = await DesktopPolicy.create({
      profile: 'workspace-write',
      allowedRoots: [allowed]
    });
    assert.equal(writable.canWrite(), true);
    const expectedNew = path.join(await realpath(allowed), 'new.txt');
    assert.equal(await writable.resolveWritePath(path.join(allowed, 'new.txt')), expectedNew);
    assert.equal(await writable.resolveNewWritePath(path.join(allowed, 'new.txt')), expectedNew);
    await assert.rejects(
      writable.resolveNewWritePath(insideFile),
      /Destination already exists/
    );

    await assert.rejects(
      writable.resolveReadPath(path.join(allowed, '..', 'outside', 'outside.txt')),
      /outside DESKTOP_MCP_ALLOWED_ROOTS/
    );

    const escape = path.join(allowed, 'escape-junction');
    await symlink(outside, escape, 'junction');
    await assert.rejects(
      writable.resolveReadPath(path.join(escape, 'outside.txt')),
      /Canonical path escapes DESKTOP_MCP_ALLOWED_ROOTS/
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('DesktopPolicy rejects invalid profiles and non-directory roots', async () => {
  await prepare();
  try {
    await assert.rejects(
      DesktopPolicy.create({ profile: 'god-mode', allowedRoots: [allowed] }),
      /Invalid DESKTOP_MCP_PROFILE/
    );
    await assert.rejects(
      DesktopPolicy.create({ profile: 'read-only', allowedRoots: [insideFile] }),
      /not a directory/
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('DesktopPolicy blocks sensitive paths unless locally opted in', async () => {
  await prepare();
  try {
    const envFile = path.join(allowed, '.env');
    const sshDir = path.join(allowed, '.ssh');
    const sshConfig = path.join(sshDir, 'config');
    await writeFile(envFile, 'TOP_SECRET_TEST_VALUE', 'utf8');
    await mkdir(sshDir, { recursive: true });
    await writeFile(sshConfig, 'Host test', 'utf8');

    const guarded = await DesktopPolicy.create({
      profile: 'full-control',
      allowedRoots: [allowed]
    });
    assert.equal(guarded.info().allowSensitivePaths, false);
    await assert.rejects(guarded.resolveReadPath(envFile), /Sensitive path denied/);
    await assert.rejects(guarded.resolveReadPath(sshConfig), /Sensitive path denied/);
    await assert.rejects(
      guarded.resolveWritePath(path.join(allowed, '.npmrc')),
      /Sensitive path denied/
    );

    const optedIn = await DesktopPolicy.create({
      profile: 'workspace-write',
      allowedRoots: [allowed],
      allowSensitivePaths: true
    });
    assert.equal(optedIn.info().allowSensitivePaths, true);
    assert.equal(await optedIn.resolveReadPath(envFile), await realpath(envFile));
    assert.equal(await optedIn.resolveReadPath(sshConfig), await realpath(sshConfig));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('DesktopPolicy fully-unlocked bypasses workspace and sensitive-path sandboxing', async () => {
  await prepare();
  try {
    const sensitiveOutside = path.join(outside, '.env');
    await writeFile(sensitiveOutside, 'FULLY_UNLOCKED_TEST_VALUE', 'utf8');

    const unlocked = await DesktopPolicy.create({
      profile: 'fully-unlocked',
      allowedRoots: [allowed]
    });

    assert.equal(unlocked.info().profile, 'fully-unlocked');
    assert.equal(unlocked.info().processToolsEnabled, true);
    assert.equal(unlocked.info().writeEnabled, true);
    assert.equal(unlocked.info().allowSensitivePaths, true);
    assert.equal(unlocked.isFullyUnlocked(), true);
    assert.equal(await unlocked.resolveReadPath(outsideFile), await realpath(outsideFile));
    assert.equal(await unlocked.resolveReadPath(sensitiveOutside), await realpath(sensitiveOutside));
    assert.equal(
      await unlocked.resolveWritePath(path.join(outside, 'new-unlocked.txt')),
      path.join(await realpath(outside), 'new-unlocked.txt')
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
