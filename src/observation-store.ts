import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { PolicyDeniedError } from './desktop-policy.js';

export interface FileObservation {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly observedAt: string;
}

interface ObservationCapability {
  readonly id: string;
  readonly observation: FileObservation;
}

export interface IssuedObservation {
  readonly observation: FileObservation;
  readonly observationId: string;
}

export class ObservationRequiredError extends PolicyDeniedError {
  constructor(filePath: string) {
    super(`Read-before-write required: a fresh observation_id from desktop_read_file is required for ${filePath}.`);
    this.name = 'ObservationRequiredError';
  }
}

export class ObservationCapabilityError extends PolicyDeniedError {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationCapabilityError';
  }
}

export class StaleObservationError extends PolicyDeniedError {
  constructor(filePath: string) {
    super(`STALE observation: ${filePath} changed after it was read. Read it again before modifying.`);
    this.name = 'StaleObservationError';
  }
}

function keyFor(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function sameVersion(a: FileObservation, b: FileObservation): boolean {
  return a.size === b.size && a.sha256 === b.sha256;
}

export class ObservationStore {
  private readonly observations = new Map<string, ObservationCapability>();
  private readonly mutationLocks = new Map<string, Promise<void>>();

  constructor(
    readonly maxBytes = 5 * 1024 * 1024,
    readonly maxEntries = 1024
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000) {
      throw new Error(`Invalid observation entry limit: ${maxEntries}`);
    }
  }

  private issueCaptured(observation: FileObservation): string {
    const id = randomUUID();
    this.observations.set(id, { id, observation });
    while (this.observations.size > this.maxEntries) {
      const oldest = this.observations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.observations.delete(oldest);
    }
    return id;
  }

  private takeCapability(filePath: string, observationId: string | undefined): FileObservation {
    if (!observationId) throw new ObservationRequiredError(filePath);
    const capability = this.observations.get(observationId);
    if (!capability) {
      throw new ObservationCapabilityError('Unknown, expired, or already-consumed observation_id. Read the file again before modifying it.');
    }
    this.observations.delete(observationId);
    if (keyFor(capability.observation.path) !== keyFor(filePath)) {
      throw new ObservationCapabilityError('observation_id does not belong to the requested file.');
    }
    return capability.observation;
  }

  private async assertFreshCapability(filePath: string, observationId: string | undefined): Promise<FileObservation> {
    const observed = this.takeCapability(filePath, observationId);
    let current: FileObservation;
    try {
      current = await this.capture(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StaleObservationError(filePath);
      throw error;
    }
    if (!sameVersion(observed, current)) throw new StaleObservationError(filePath);
    return current;
  }

  private async acquireMutationLock(key: string): Promise<() => void> {
    const previous = this.mutationLocks.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>(resolve => { releaseCurrent = resolve; });
    const tail = previous.then(() => current);
    this.mutationLocks.set(key, tail);
    await previous;
    return () => {
      releaseCurrent();
      if (this.mutationLocks.get(key) === tail) this.mutationLocks.delete(key);
    };
  }

  private async withMutationLocks<T>(filePaths: readonly string[], action: () => Promise<T>): Promise<T> {
    const keys = [...new Set(filePaths.map(keyFor))].sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of keys) releases.push(await this.acquireMutationLock(key));
      return await action();
    } finally {
      for (let index = releases.length - 1; index >= 0; index--) releases[index]!();
    }
  }

  size(): number {
    return this.observations.size;
  }

  async capture(filePath: string): Promise<FileObservation> {
    const before = await stat(filePath);
    if (!before.isFile()) {
      throw new PolicyDeniedError(`Observation requires a regular file: ${filePath}`);
    }
    if (before.size > this.maxBytes) {
      throw new PolicyDeniedError(`File exceeds observation limit (${this.maxBytes} bytes): ${filePath}`);
    }

    const bytes = await readFile(filePath);
    const after = await stat(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new StaleObservationError(filePath);
    }

    return {
      path: filePath,
      size: after.size,
      mtimeMs: after.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      observedAt: new Date().toISOString()
    };
  }

  async observe(filePath: string): Promise<IssuedObservation> {
    const observation = await this.capture(filePath);
    return { observation, observationId: this.issueCaptured(observation) };
  }

  async recordIfUnchanged(filePath: string, expected: FileObservation): Promise<IssuedObservation> {
    const current = await this.capture(filePath);
    if (!sameVersion(expected, current)) throw new StaleObservationError(filePath);
    return { observation: current, observationId: this.issueCaptured(current) };
  }

  async withObservedMutation<T>(
    filePath: string,
    observationId: string | undefined,
    action: () => Promise<T>
  ): Promise<T> {
    return this.withMutationLocks([filePath], async () => {
      await this.assertFreshCapability(filePath, observationId);
      return action();
    });
  }

  async withWriteMutation<T>(
    filePath: string,
    observationId: string | undefined,
    action: () => Promise<T>
  ): Promise<T> {
    return this.withMutationLocks([filePath], async () => {
      try {
        await stat(filePath);
        await this.assertFreshCapability(filePath, observationId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (observationId) {
          this.takeCapability(filePath, observationId);
          throw new StaleObservationError(filePath);
        }
      }
      return action();
    });
  }

  async withExclusiveMutation<T>(
    filePaths: readonly string[],
    action: () => Promise<T>
  ): Promise<T> {
    return this.withMutationLocks(filePaths, action);
  }

  async withMoveMutation<T>(
    sourcePath: string,
    sourceObservationId: string | undefined,
    destinationPath: string,
    action: () => Promise<T>
  ): Promise<T> {
    return this.withMutationLocks([sourcePath, destinationPath], async () => {
      await this.assertFreshCapability(sourcePath, sourceObservationId);
      try {
        await stat(destinationPath);
        throw new PolicyDeniedError(`Destination already exists: ${destinationPath}`);
      } catch (error) {
        if (error instanceof PolicyDeniedError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return action();
    });
  }
}
