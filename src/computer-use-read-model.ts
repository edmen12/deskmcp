import type { UiElementSummary, WindowInspection } from './computer-use-backend.js';

export type WaitCondition = 'present' | 'enabled' | 'value_equals';

export interface UiSnapshotRecord {
  readonly windowId: string;
  readonly leaseId?: string;
  readonly capturedAt: number;
  readonly elements: readonly UiElementSummary[];
  readonly truncated: boolean;
  readonly maxElements: number;
  readonly interactiveOnly: boolean;
}

export interface UiDiff {
  readonly added: readonly { key: string; element: UiElementSummary }[];
  readonly removed: readonly { key: string; element: UiElementSummary }[];
  readonly changed: readonly { key: string; before: UiElementSummary; after: UiElementSummary }[];
  readonly unchanged: number;
  readonly baseline_truncated: boolean;
  readonly current_truncated: boolean;
  readonly scope_complete: false;
  readonly identity_strategy: 'unique_selector_else_position';
}

function indexedElements(
  current: readonly UiElementSummary[],
  other: readonly UiElementSummary[]
): Map<string, UiElementSummary> {
  const counts = (items: readonly UiElementSummary[]) => {
    const result = new Map<string, number>();
    for (const item of items) {
      if (item.selector) result.set(item.selector, (result.get(item.selector) ?? 0) + 1);
    }
    return result;
  };
  const a = counts(current);
  const b = counts(other);
  const map = new Map<string, UiElementSummary>();
  for (const [index, element] of current.entries()) {
    const selector = element.selector;
    // Do not match duplicate selectors across snapshots as if they were unique.
    const key = selector && a.get(selector) === 1 && (b.get(selector) ?? 0) <= 1
      ? `selector:${selector}`
      : `position:${index}`;
    map.set(key, element);
  }
  return map;
}

/** Diff only the sanitized elements exposed by the backend; never infer global absence. */
export function diffUiSnapshots(before: UiSnapshotRecord, after: UiSnapshotRecord): UiDiff {
  const oldMap = indexedElements(before.elements, after.elements);
  const newMap = indexedElements(after.elements, before.elements);
  const added: { key: string; element: UiElementSummary }[] = [];
  const removed: { key: string; element: UiElementSummary }[] = [];
  const changed: { key: string; before: UiElementSummary; after: UiElementSummary }[] = [];
  let unchanged = 0;
  for (const [key, element] of newMap) {
    const old = oldMap.get(key);
    if (!old) added.push({ key, element });
    else if (JSON.stringify(old) !== JSON.stringify(element)) changed.push({ key, before: old, after: element });
    else unchanged += 1;
  }
  for (const [key, element] of oldMap) if (!newMap.has(key)) removed.push({ key, element });
  return {
    added, removed, changed, unchanged,
    baseline_truncated: before.truncated,
    current_truncated: after.truncated,
    scope_complete: false,
    identity_strategy: 'unique_selector_else_position'
  };
}

/** Baselines are bounded, ephemeral, scoped to the exact window capability and desktop lease. */
export class ComputerSnapshotRegistry {
  private readonly records = new Map<string, UiSnapshotRecord>();
  constructor(readonly maxEntries = 128, readonly ttlMs = 120_000) {}

  add(id: string, record: UiSnapshotRecord, now = Date.now()): void {
    this.prune(now);
    this.records.delete(id);
    this.records.set(id, {
      ...record,
      // Independent copy, never hold provider-native mutable references.
      elements: record.elements.map(item => ({
        ...item,
        ...(item.ancestorPath ? { ancestorPath: [...item.ancestorPath] } : {})
      }))
    });
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }

  get(id: string, windowId: string, leaseId?: string, now = Date.now()): UiSnapshotRecord {
    this.prune(now);
    const record = this.records.get(id);
    if (!record) throw new Error('UI diff baseline is missing or expired. Capture a new full snapshot.');
    if (record.windowId !== windowId || record.leaseId !== leaseId) {
      throw new Error('UI diff baseline belongs to another window or Agent Desktop lease.');
    }
    return record;
  }

  private prune(now: number): void {
    for (const [key, record] of this.records) {
      if (now - record.capturedAt > this.ttlMs) this.records.delete(key);
    }
  }
}

export interface WaitOutcome {
  readonly condition_met: boolean;
  readonly attempts: number;
  readonly timed_out: boolean;
  readonly last_inspection_truncated: boolean;
}

/** Poll a precise backend selector; lack of a match does not establish UI-tree completeness. */
export async function waitForUiCondition(
  inspect: () => Promise<WindowInspection>,
  verifyTarget: () => Promise<void>,
  selector: string,
  condition: WaitCondition,
  expectedValue: string | undefined,
  maxWaitMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
): Promise<WaitOutcome> {
  if (!selector.trim()) throw new Error('wait_for needs an exact selector.');
  if (condition === 'value_equals' && expectedValue === undefined) throw new Error('value_equals requires expected_value.');
  const deadline = Date.now() + maxWaitMs;
  let attempts = 0;
  let lastInspectionTruncated = false;
  for (;;) {
    await verifyTarget();
    const snapshot = await inspect();
    await verifyTarget();
    attempts += 1;
    lastInspectionTruncated = snapshot.elementsTruncated === true;
    const matching = snapshot.elements.filter(element => element.selector === selector);
    if (matching.length > 1) throw new Error('wait_for selector is ambiguous in the current UI snapshot.');
    const element = matching[0];
    const met = condition === 'present' ? Boolean(element)
      : condition === 'enabled' ? element?.isEnabled === true
      : element?.value === expectedValue;
    if (met) return { condition_met: true, timed_out: false, attempts, last_inspection_truncated: lastInspectionTruncated };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { condition_met: false, timed_out: true, attempts, last_inspection_truncated: lastInspectionTruncated };
    await sleep(Math.min(pollMs, remaining));
  }
}
