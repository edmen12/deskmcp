import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerSnapshotRegistry, diffUiSnapshots, waitForUiCondition, type UiSnapshotRecord } from '../src/computer-use-read-model.js';

const baseline = (elements: UiSnapshotRecord['elements'], extra: Partial<UiSnapshotRecord> = {}): UiSnapshotRecord => ({
  windowId: 'win-a', capturedAt: 1000, elements, truncated: false, maxElements: 80,
  interactiveOnly: true, ...extra
});

test('diff uses unique selectors, tracks real value changes and reports limited scope', () => {
  const before = baseline([
    { selector: 'root', type: 'Window' },
    { selector: 'edit-1', type: 'Edit', value: 'before' },
    { selector: 'old', type: 'Button' }
  ]);
  const after = baseline([
    { selector: 'root', type: 'Window' },
    { selector: 'edit-1', type: 'Edit', value: 'after' },
    { selector: 'new', type: 'Button' }
  ], { truncated: true });
  const result = diffUiSnapshots(before, after);
  assert.equal(result.unchanged, 1);
  assert.equal(result.changed[0]?.key, 'selector:edit-1');
  assert.equal(result.added[0]?.key, 'selector:new');
  assert.equal(result.removed[0]?.key, 'selector:old');
  assert.equal(result.current_truncated, true);
  assert.equal(result.scope_complete, false);
});

test('duplicate selectors do not silently match by selector identity', () => {
  const result = diffUiSnapshots(
    baseline([{ selector: 'same', value: 'a' }, { selector: 'same', value: 'b' }]),
    baseline([{ selector: 'same', value: 'b' }, { selector: 'same', value: 'a' }])
  );
  assert.equal(result.changed.length, 2);
  assert.equal(result.changed[0]?.key, 'position:0');
});

test('ephemeral UI diff baselines are bound to window and lease and expire', () => {
  const store = new ComputerSnapshotRegistry(2, 100);
  store.add('one', baseline([{ selector: 'a', value: 'original' }], { leaseId: 'lease-a' }), 1000);
  assert.throws(() => store.get('one', 'win-b', 'lease-a', 1050), /another window/i);
  assert.throws(() => store.get('one', 'win-a', 'lease-b', 1050), /another window or Agent Desktop lease/i);
  assert.equal(store.get('one', 'win-a', 'lease-a', 1050).elements[0]?.value, 'original');
  store.add('two', baseline([]), 1100);
  store.add('three', baseline([]), 1101);
  assert.throws(() => store.get('one', 'win-a', 'lease-a', 1101), /missing or expired/i);
});

test('wait checks exact selector until condition is verified', async () => {
  let polls = 0;
  let guard = 0;
  const result = await waitForUiCondition(
    async () => {
      polls += 1;
      return { hwnd: 101, elements: [{ selector: 'Apply', isEnabled: polls > 1 }] };
    },
    async () => { guard += 1; },
    'Apply', 'enabled', undefined, 1000, 100, async () => undefined
  );
  assert.equal(result.condition_met, true);
  assert.equal(result.attempts, 2);
  assert.equal(guard, 4);
});

test('wait times out without claiming a missing UIA control is absent', async () => {
  const result = await waitForUiCondition(
    async () => ({ hwnd: 101, elements: [], elementsTruncated: true }),
    async () => undefined, 'never', 'present', undefined, 0, 100
  );
  assert.equal(result.condition_met, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.last_inspection_truncated, true);
});

test('wait rejects ambiguous selectors, missing expected value and guard failures', async () => {
  const inspect = async () => ({ hwnd: 101, elements: [{ selector: 'X' }, { selector: 'X' }] });
  await assert.rejects(waitForUiCondition(inspect, async () => undefined, 'X', 'present', undefined, 0, 100), /ambiguous/i);
  await assert.rejects(waitForUiCondition(inspect, async () => undefined, 'X', 'value_equals', undefined, 0, 100), /expected_value/i);
  let inspected = false;
  await assert.rejects(waitForUiCondition(
    async () => { inspected = true; return inspect(); },
    async () => { throw new Error('Desktop lease revoked'); },
    'X', 'present', undefined, 0, 100
  ), /lease revoked/i);
  assert.equal(inspected, false);
});

test('wait refuses to verify a selector from a known truncated tree', async () => {
  const result = await waitForUiCondition(
    async () => ({
      hwnd: 101, elements: [{ selector: 'Save', type: 'Button', isEnabled: true }],
      elementsTruncated: true
    }),
    async () => undefined, 'Save', 'enabled', undefined, 0, 100
  );
  assert.equal(result.condition_met, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.last_inspection_truncated, true);
});
