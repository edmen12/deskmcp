import { randomUUID } from 'node:crypto';

interface ObservationRecord {
  readonly id: string;
  readonly windowId: string;
  readonly generation: number;
  readonly globalGeneration: number;
  readonly createdAt: number;
}

export class ComputerObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComputerObservationError';
  }
}

export class ComputerObservationRegistry {
  private readonly records = new Map<string, ObservationRecord>();
  private readonly generations = new Map<string, number>();
  private globalGeneration = 0;

  constructor(
    readonly maxRecords = 256,
    readonly ttlMs = 30_000
  ) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 4096) {
      throw new Error(`Invalid computer observation capacity: ${maxRecords}`);
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 10 * 60_000) {
      throw new Error(`Invalid computer observation TTL: ${ttlMs}`);
    }
  }

  issue(windowId: string, now = Date.now()): string {
    this.prune(now);
    while (this.records.size >= this.maxRecords) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
    const id = randomUUID();
    this.records.set(id, {
      id,
      windowId,
      generation: this.generations.get(windowId) ?? 0,
      globalGeneration: this.globalGeneration,
      createdAt: now
    });
    return id;
  }

  consume(id: string, windowId: string, now = Date.now()): void {
    this.prune(now);
    const record = this.records.get(id);
    if (!record) {
      throw new ComputerObservationError(
        'Computer observation is missing, expired, or already used. Take a fresh desktop_ui_snapshot.'
      );
    }
    this.records.delete(id);
    if (record.windowId !== windowId) {
      throw new ComputerObservationError('Computer observation does not belong to the requested window.');
    }
    const generation = this.generations.get(windowId) ?? 0;
    if (record.generation !== generation) {
      throw new ComputerObservationError(
        'Computer observation is stale because another UI action already changed this window. Take a fresh desktop_ui_snapshot.'
      );
    }
    if (record.globalGeneration !== this.globalGeneration) {
      throw new ComputerObservationError(
        'Computer observation is stale because global mouse or keyboard input changed desktop state. Take a fresh desktop_ui_snapshot.'
      );
    }
  }

  advance(windowId: string, globalInput = false): void {
    this.generations.set(windowId, (this.generations.get(windowId) ?? 0) + 1);
    if (globalInput) this.globalGeneration += 1;
  }

  forgetWindow(windowId: string): void {
    this.generations.delete(windowId);
    for (const [id, record] of this.records) {
      if (record.windowId === windowId) this.records.delete(id);
    }
  }

  clear(): void {
    this.records.clear();
    this.generations.clear();
    this.globalGeneration = 0;
  }

  private prune(now: number): void {
    for (const [id, record] of this.records) {
      if (now - record.createdAt > this.ttlMs) this.records.delete(id);
    }
  }
}
