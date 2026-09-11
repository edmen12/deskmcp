import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type PidDirectoryLockState = 'missing' | 'initializing' | 'active' | 'stale' | 'recovering' | 'invalid';

interface PidDirectoryLockOwner {
  readonly schema_version: 1;
  readonly pid: number;
  readonly token: string;
  readonly created_at: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

interface PidDirectoryTransitionOwner {
  readonly schema_version: 1;
  readonly kind: 'release' | 'reclaim';
  readonly pid: number;
  readonly token: string;
  readonly expected_owner_pid: number;
  readonly expected_owner_token: string;
  readonly created_at: string;
}

export interface PidDirectoryLockTestHooks {
  readonly beforeRecoveryMarkerAcquire?: () => Promise<void> | void;
  readonly afterRecoveryMarkerAcquired?: () => Promise<void> | void;
  readonly afterRecoveryDirectoryRetired?: () => Promise<void> | void;
  readonly afterReleaseDirectoryRetired?: () => Promise<void> | void;
}

export interface PidDirectoryLockOptions {
  readonly label: string;
  readonly timeoutMs?: number;
  readonly initializationGraceMs?: number;
  readonly pollMs?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly testHooks?: PidDirectoryLockTestHooks;
}

export interface PidDirectoryLockLease {
  readonly token: string;
  release(): Promise<void>;
}

interface ObservedLock {
  readonly state: Exclude<PidDirectoryLockState, 'recovering'>;
  readonly owner?: PidDirectoryLockOwner;
}

interface ObservedTransition {
  readonly state: 'missing' | 'initializing' | 'active' | 'invalid';
  readonly owner?: PidDirectoryTransitionOwner;
}

interface TransitionLease {
  readonly token: string;
  readonly path: string;
}

function transitionPath(lockDir: string): string {
  return `${lockDir}.transition`;
}

function boundedPositive(value: number | undefined, fallback: number, label: string, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} ms.`);
  }
  return selected;
}

function validUuidToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function validOwner(value: unknown): value is PidDirectoryLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<PidDirectoryLockOwner>;
  if (row.schema_version !== 1 || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0) return false;
  if (!validUuidToken(row.token)) return false;
  if (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return false;
  if (row.metadata !== undefined) {
    if (!row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata)) return false;
    for (const [key, item] of Object.entries(row.metadata)) {
      if (!key || key.length > 128 || typeof item !== 'string' || item.length > 4096) return false;
    }
  }
  return true;
}

function validTransitionOwner(value: unknown): value is PidDirectoryTransitionOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<PidDirectoryTransitionOwner>;
  return row.schema_version === 1
    && (row.kind === 'release' || row.kind === 'reclaim')
    && Number.isSafeInteger(row.pid)
    && Number(row.pid) > 0
    && validUuidToken(row.token)
    && Number.isSafeInteger(row.expected_owner_pid)
    && Number(row.expected_owner_pid) > 0
    && validUuidToken(row.expected_owner_token)
    && typeof row.created_at === 'string'
    && Number.isFinite(Date.parse(row.created_at));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function writeJsonAtomically(directory: string, filename: string, payload: unknown, token: string): Promise<void> {
  const finalPath = path.join(directory, filename);
  const tempPath = path.join(directory, `.${filename}.${token}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function transientDirectoryRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return ['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '');
}

async function retireOwnedDirectory(
  source: string,
  destination: string,
  verifyOwnership: () => Promise<boolean>,
  label: string
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (!await verifyOwnership()) throw new Error(`${label} lock ownership changed before retirement.`);
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!transientDirectoryRenameError(error) || attempt >= 7) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(10 * (2 ** attempt), 200)));
    }
  }
}

async function observeBaseLock(lockDir: string, initializationGraceMs: number): Promise<ObservedLock> {
  const info = await lstat(lockDir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return { state: 'missing' };
  if (!info.isDirectory() || info.isSymbolicLink()) return { state: 'invalid' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && Date.now() - info.mtimeMs < initializationGraceMs) {
      return { state: 'initializing' };
    }
    return { state: 'invalid' };
  }
  if (!validOwner(parsed)) return { state: 'invalid' };
  return { state: pidAlive(parsed.pid) ? 'active' : 'stale', owner: parsed };
}

async function transitionPresence(lockDir: string): Promise<'missing' | 'present' | 'invalid'> {
  const info = await lstat(transitionPath(lockDir)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return 'missing';
  if (!info.isDirectory() || info.isSymbolicLink()) return 'invalid';
  return 'present';
}

async function observeTransition(lockDir: string, initializationGraceMs: number): Promise<ObservedTransition> {
  const marker = transitionPath(lockDir);
  const info = await lstat(marker).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return { state: 'missing' };
  if (!info.isDirectory() || info.isSymbolicLink()) return { state: 'invalid' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(marker, 'owner.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && Date.now() - info.mtimeMs < initializationGraceMs) {
      return { state: 'initializing' };
    }
    return { state: 'invalid' };
  }
  if (!validTransitionOwner(parsed) || !pidAlive(parsed.pid)) return { state: 'invalid' };
  return { state: 'active', owner: parsed };
}

async function tryCreateTransition(
  lockDir: string,
  kind: PidDirectoryTransitionOwner['kind'],
  expectedOwner: PidDirectoryLockOwner
): Promise<TransitionLease | undefined> {
  const marker = transitionPath(lockDir);
  const token = randomUUID();
  try {
    await mkdir(marker, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }

  const owner: PidDirectoryTransitionOwner = {
    schema_version: 1,
    kind,
    pid: process.pid,
    token,
    expected_owner_pid: expectedOwner.pid,
    expected_owner_token: expectedOwner.token,
    created_at: new Date().toISOString()
  };
  try {
    await writeJsonAtomically(marker, 'owner.json', owner, token);
  } catch (error) {
    await rm(marker, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }).catch(() => undefined);
    throw error;
  }
  return { token, path: marker };
}

async function transitionStillOwned(
  lockDir: string,
  transition: TransitionLease,
  expectedOwner: PidDirectoryLockOwner,
  kind: PidDirectoryTransitionOwner['kind'],
  initializationGraceMs: number
): Promise<boolean> {
  const observed = await observeTransition(lockDir, initializationGraceMs);
  return observed.state === 'active'
    && observed.owner?.pid === process.pid
    && observed.owner.token === transition.token
    && observed.owner.kind === kind
    && observed.owner.expected_owner_pid === expectedOwner.pid
    && observed.owner.expected_owner_token === expectedOwner.token;
}

async function releaseTransition(lockDir: string, transition: TransitionLease): Promise<void> {
  const observed = await observeTransition(lockDir, 1);
  if (observed.state === 'missing') throw new Error('Cross-process lock transition marker disappeared before release.');
  if (!observed.owner || observed.owner.pid !== process.pid || observed.owner.token !== transition.token) {
    throw new Error('Cross-process lock transition ownership changed before release.');
  }
  await rm(transition.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
}

async function waitForTransitionOrThrow(
  lockDir: string,
  options: PidDirectoryLockOptions,
  initializationGraceMs: number,
  deadline: number,
  pollMs: number
): Promise<void> {
  if (Date.now() >= deadline) {
    const observed = await observeTransition(lockDir, initializationGraceMs);
    if (observed.state === 'invalid') {
      throw new Error(`${options.label} lock transition metadata is invalid or abandoned; refusing unsafe automatic takeover.`);
    }
    throw new Error(`${options.label} is busy in another DeskMCP process.`);
  }
  await new Promise(resolve => setTimeout(resolve, pollMs));
}

async function reclaimObservedStaleLock(
  lockDir: string,
  staleOwner: PidDirectoryLockOwner,
  initializationGraceMs: number,
  options: PidDirectoryLockOptions
): Promise<boolean> {
  await options.testHooks?.beforeRecoveryMarkerAcquire?.();
  const transition = await tryCreateTransition(lockDir, 'reclaim', staleOwner);
  if (!transition) return false;

  await options.testHooks?.afterRecoveryMarkerAcquired?.();

  const rechecked = await observeBaseLock(lockDir, initializationGraceMs);
  const sameStaleOwner = rechecked.state === 'stale'
    && rechecked.owner?.pid === staleOwner.pid
    && rechecked.owner.token === staleOwner.token;
  if (!sameStaleOwner) {
    await releaseTransition(lockDir, transition);
    return rechecked.state === 'missing';
  }

  const retiredPath = `${lockDir}.reclaim-${process.pid}-${transition.token}`;
  try {
    await retireOwnedDirectory(
      lockDir,
      retiredPath,
      async () => {
        const current = await observeBaseLock(lockDir, initializationGraceMs);
        if (current.state !== 'stale' || current.owner?.pid !== staleOwner.pid || current.owner.token !== staleOwner.token) return false;
        return transitionStillOwned(lockDir, transition, staleOwner, 'reclaim', initializationGraceMs);
      },
      `${options.label} stale recovery`
    );
    await options.testHooks?.afterRecoveryDirectoryRetired?.();
    await rm(retiredPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  } catch (error) {
    try {
      await releaseTransition(lockDir, transition);
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], `${options.label} stale recovery failed and transition release also failed.`);
    }
    throw error;
  }
  await releaseTransition(lockDir, transition);
  return true;
}

export async function inspectPidDirectoryLock(lockDir: string, initializationGraceMs = 5_000): Promise<PidDirectoryLockState> {
  const transition = await observeTransition(lockDir, initializationGraceMs);
  if (transition.state === 'active' || transition.state === 'initializing') return 'recovering';
  if (transition.state === 'invalid') return 'invalid';
  return (await observeBaseLock(lockDir, initializationGraceMs)).state;
}

export async function acquirePidDirectoryLock(lockDir: string, options: PidDirectoryLockOptions): Promise<PidDirectoryLockLease> {
  const timeoutMs = boundedPositive(options.timeoutMs, 5_000, `${options.label} lock timeout`, 60_000);
  const initializationGraceMs = boundedPositive(options.initializationGraceMs, 5_000, `${options.label} lock initialization grace`, 60_000);
  const pollMs = boundedPositive(options.pollMs, 50, `${options.label} lock poll interval`, 1_000);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const gate = await transitionPresence(lockDir);
    if (gate === 'invalid') {
      throw new Error(`${options.label} lock transition marker is invalid; refusing unsafe automatic recovery.`);
    }
    if (gate === 'present') {
      await waitForTransitionOrThrow(lockDir, options, initializationGraceMs, deadline, pollMs);
      continue;
    }

    const token = randomUUID();
    let created = false;
    try {
      await mkdir(lockDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    if (created) {
      const gateAfterMkdir = await transitionPresence(lockDir);
      if (gateAfterMkdir !== 'missing') {
        await rm(lockDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
        if (gateAfterMkdir === 'invalid') {
          throw new Error(`${options.label} lock transition marker is invalid; refusing unsafe automatic recovery.`);
        }
        await waitForTransitionOrThrow(lockDir, options, initializationGraceMs, deadline, pollMs);
        continue;
      }

      const owner: PidDirectoryLockOwner = {
        schema_version: 1,
        pid: process.pid,
        token,
        created_at: new Date().toISOString(),
        ...(options.metadata ? { metadata: options.metadata } : {})
      };
      try {
        await writeJsonAtomically(lockDir, 'owner.json', owner, token);
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }).catch(() => undefined);
        throw error;
      }

      const expectedOwner: PidDirectoryLockOwner = owner;
      const retiredPath = `${lockDir}.release-${process.pid}-${token}`;
      let pendingTransition: TransitionLease | undefined;
      let canonicalRetired = false;
      let released = false;

      const transitionMatchesOwnedRelease = async (transition: TransitionLease): Promise<'missing' | 'owned' | 'changed'> => {
        const observed = await observeTransition(lockDir, initializationGraceMs);
        if (observed.state === 'missing') return 'missing';
        if (
          observed.state === 'active'
          && observed.owner?.pid === process.pid
          && observed.owner.token === transition.token
          && observed.owner.kind === 'release'
          && observed.owner.expected_owner_pid === expectedOwner.pid
          && observed.owner.expected_owner_token === expectedOwner.token
        ) return 'owned';
        return 'changed';
      };

      return {
        token,
        release: async () => {
          if (released) return;

          if (canonicalRetired) {
            await rm(retiredPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
            if (pendingTransition) {
              const state = await transitionMatchesOwnedRelease(pendingTransition);
              if (state === 'owned') await releaseTransition(lockDir, pendingTransition);
              else if (state === 'changed') {
                throw new Error(`${options.label} pending release transition ownership changed before retry.`);
              }
              pendingTransition = undefined;
            }
            released = true;
            return;
          }

          const releaseDeadline = Date.now() + timeoutMs;
          let transition = pendingTransition;
          if (transition) {
            const state = await transitionMatchesOwnedRelease(transition);
            if (state === 'missing') {
              pendingTransition = undefined;
              transition = undefined;
            } else if (state === 'changed') {
              throw new Error(`${options.label} pending release transition ownership changed before retry.`);
            }
          }

          for (;;) {
            if (transition) break;
            const presence = await transitionPresence(lockDir);
            if (presence === 'invalid') {
              throw new Error(`${options.label} lock transition marker is invalid; refusing unsafe release.`);
            }
            if (presence === 'missing') transition = await tryCreateTransition(lockDir, 'release', expectedOwner);
            if (transition) break;
            await waitForTransitionOrThrow(lockDir, options, initializationGraceMs, releaseDeadline, pollMs);
          }
          pendingTransition = transition;

          try {
            await retireOwnedDirectory(
              lockDir,
              retiredPath,
              async () => {
                const observed = await observeBaseLock(lockDir, initializationGraceMs);
                if (observed.state !== 'active' || observed.owner?.pid !== process.pid || observed.owner.token !== token) return false;
                return transitionStillOwned(lockDir, transition!, expectedOwner, 'release', initializationGraceMs);
              },
              options.label
            );
            canonicalRetired = true;
            await options.testHooks?.afterReleaseDirectoryRetired?.();
            await rm(retiredPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
          } catch (error) {
            try {
              await releaseTransition(lockDir, transition);
              pendingTransition = undefined;
            } catch (releaseError) {
              throw new AggregateError([error, releaseError], `${options.label} release failed and transition release also failed.`);
            }
            throw error;
          }

          await releaseTransition(lockDir, transition);
          pendingTransition = undefined;
          released = true;
        }
      };
    }

    const gateAfterConflict = await transitionPresence(lockDir);
    if (gateAfterConflict === 'invalid') {
      throw new Error(`${options.label} lock transition marker is invalid; refusing unsafe automatic recovery.`);
    }
    if (gateAfterConflict === 'present') {
      await waitForTransitionOrThrow(lockDir, options, initializationGraceMs, deadline, pollMs);
      continue;
    }

    const observed = await observeBaseLock(lockDir, initializationGraceMs);
    if (observed.state === 'stale' && observed.owner) {
      if (await reclaimObservedStaleLock(lockDir, observed.owner, initializationGraceMs, options)) continue;
    } else if (observed.state === 'invalid') {
      throw new Error(`${options.label} lock metadata is invalid; refusing unsafe automatic recovery.`);
    } else if (observed.state === 'missing') {
      continue;
    }

    if (Date.now() >= deadline) throw new Error(`${options.label} is busy in another DeskMCP process.`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
