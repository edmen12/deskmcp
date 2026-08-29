import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { PolicyDeniedError } from './desktop-policy.js';

export interface FileObservation {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly observedAt: string;
}

export class ObservationRequiredError extends PolicyDeniedError {
  constructor(filePath: string) {
    super(`Read-before-write required: ${filePath} has not been observed in this gateway session.`);
    this.name = 'ObservationRequiredError';
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
  private readonly observations = new Map<string, FileObservation>();

  constructor(
    readonly maxBytes = 5 * 1024 * 1024,
    readonly maxEntries = 1024
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000) {
      throw new Error(`Invalid observation entry limit: ${maxEntries}`);
    }
  }

  private remember(filePath: string, observation: FileObservation): void {
    const key = keyFor(filePath);
    this.observations.delete(key);
    this.observations.set(key, observation);
    while (this.observations.size > this.maxEntries) {
      const oldest = this.observations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.observations.delete(oldest);
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

  async observe(filePath: string): Promise<FileObservation> {
    const observation = await this.capture(filePath);
    this.remember(filePath, observation);
    return observation;
  }

  async recordIfUnchanged(
    filePath: string,
    expected: FileObservation
  ): Promise<FileObservation> {
    const current = await this.capture(filePath);
    if (!sameVersion(expected, current)) {
      this.forget(filePath);
      throw new StaleObservationError(filePath);
    }
    this.remember(filePath, current);
    return current;
  }

  async requireFresh(filePath: string): Promise<FileObservation> {
    const observed = this.observations.get(keyFor(filePath));
    if (!observed) throw new ObservationRequiredError(filePath);

    const current = await this.capture(filePath);
    if (!sameVersion(observed, current)) {
      this.forget(filePath);
      throw new StaleObservationError(filePath);
    }
    return current;
  }

  async requireFreshIfExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    await this.requireFresh(filePath);
    return true;
  }

  forget(filePath: string): void {
    this.observations.delete(keyFor(filePath));
  }
}
