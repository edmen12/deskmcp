import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifyNativeListDesktop2Evidence,
  type NativeListStage
} from '../src/computer-use-evidence-gate.js';

const prefix = [
  'HOST_MEMORY_PREFLIGHT_PASS', 'PREFLIGHT_PASS', 'OBSERVER_READY',
  'OWNED_FIXTURE_SPAWNED', 'OWNED_FIXTURE_CLOAKED',
  'TARGET_FOREGROUND_HOOK_ARMED', 'NATIVE_CHILD_CAPABILITY_PASS'
];
const line = '2026-10-23T10:11:39.5699486Z APP_LIST_TOP=20';
function fixture(stage: NativeListStage) {
  const log = stage === 'list-scroll' ? line + '\n' : '';
  const events = [...prefix,
    ...(stage === 'list-scroll' ? ['NATIVE_LIST_TOPINDEX_READBACK_PASS'] : []),
    ...(stage === 'list-deny-stale' ? ['WRONG_TOPINDEX_REJECTED'] : []),
    'FIXTURE_EXIT', 'FINAL_RESULT'];
  return {
    stage,
    result: {
      stage, pass: true, claimedForegroundSafety: true,
      desktopBefore: 1, desktopAfter: 1, tripwire: false,
      ownedGuiExitConfirmed: true, observerExitConfirmed: true,
      leaseHeldThroughTeardown: true,
      appCallbackCount: 0, appButtonCallbackCount: 0,
      appFocusEvents: [], appListTopChanges: stage === 'list-scroll' ? [line] : [],
      observed: [{ controlType: 'NativeWin32.ListBox',
        canScrollNativeList: true, canSetNativeValue: false }]
    },
    timeline: events.map(event => event === 'FINAL_RESULT'
      ? { event, pass: true, desktopAfter: 1, tripwire: false,
        ownedGuiExitConfirmed: true, observerExitConfirmed: true,
        leaseHeldThroughTeardown: true }
      : { event }),
    observer: [
      { kind: 'START', latchedAbort: false, notifications: 0, heartbeatChanges: 0 },
      { kind: 'READY_AFTER_MESSAGE_PUMP', latchedAbort: false, notifications: 0, heartbeatChanges: 0 }
    ],
    log
  };
}
function verify(input: ReturnType<typeof fixture>) {
  return verifyNativeListDesktop2Evidence(
    input.stage, input.result, input.timeline, input.observer, input.log
  );
}
test('owned Desktop2 ListBox inspect, stale denial and scroll traces verify separately', () => {
  for (const stage of ['list-inspect', 'list-deny-stale', 'list-scroll'] as const) {
    const outcome = verify(fixture(stage));
    assert.equal(outcome.pass, true);
    assert.equal(outcome.stale_request_rejected, stage === 'list-deny-stale');
    assert.equal(outcome.top_index_20_observed, stage === 'list-scroll');
  }
});
test('missing GUI cleanup or expired lease always invalidates apparent scroll success', () => {
  for (const key of ['ownedGuiExitConfirmed', 'observerExitConfirmed', 'leaseHeldThroughTeardown'] as const) {
    const data = fixture('list-scroll');
    data.result[key] = false;
    assert.throws(() => verify(data), /LIFECYCLE_UNCONFIRMED/);
  }
});
test('a false PASS, Desktop 1 switch, focus change or tripwire rejects evidence', () => {
  for (const [field, value] of [
    ['pass', false], ['desktopBefore', 2], ['desktopAfter', 2],
    ['tripwire', true], ['appCallbackCount', 1]
  ] as const) {
    const data = fixture('list-scroll');
    Object.assign(data.result, { [field]: value });
    assert.throws(() => verify(data), /DESKTOP2_LIST_EVIDENCE_/);
  }
});
test('independent observer alarm rejects harness reported pass', () => {
  const data = fixture('list-scroll');
  data.observer.push({ kind: 'WIN_EVENT_FOREGROUND', notifications: 1,
    heartbeatChanges: 0, latchedAbort: true });
  assert.throws(() => verify(data), /OBSERVER_EVENTS_NOT_QUIET/);
});
test('missing observer ready evidence rejects purported pass', () => {
  const data = fixture('list-scroll');
  data.observer.splice(1);
  assert.throws(() => verify(data), /OBSERVER_EVENTS_NOT_QUIET/);
});
test('wrong or duplicate application top-state witnesses reject scroll', () => {
  const data = fixture('list-scroll');
  data.log = data.log.replace('APP_LIST_TOP=20', 'APP_LIST_TOP=19');
  assert.throws(() => verify(data), /APP_STATE_TRACE_MISMATCH/);
  const other = fixture('list-scroll');
  other.log += line + '\n';
  assert.throws(() => verify(other), /APP_STATE_TRACE_MISMATCH/);
});
test('stale denial must contain explicit pre-dispatch rejection and never scroll', () => {
  const data = fixture('list-deny-stale');
  data.timeline = data.timeline.filter(row => row.event !== 'WRONG_TOPINDEX_REJECTED');
  assert.throws(() => verify(data), /STALE_REQUEST_NOT_REJECTED/);
  const other = fixture('list-deny-stale');
  other.log = line;
  other.result.appListTopChanges = [line];
  assert.throws(() => verify(other), /READ_ONLY_STAGE_MUTATED_LIST/);
});
test('scan actions must be preceded by observer and foreground hook', () => {
  const data = fixture('list-scroll');
  data.timeline = data.timeline.filter(row => row.event !== 'TARGET_FOREGROUND_HOOK_ARMED');
  assert.throws(() => verify(data), /TIMELINE_ORDER_INVALID/);
});
test('window-control capability and final event must independently be valid', () => {
  const data = fixture('list-scroll');
  data.result.observed[0]!.canScrollNativeList = false;
  assert.throws(() => verify(data), /CHILD_CAPABILITY_MISSING/);
  const other = fixture('list-scroll');
  const final = other.timeline.find(row => row.event === 'FINAL_RESULT');
  assert.ok(final);
  final.pass = false;
  assert.throws(() => verify(other), /FINAL_EVENT_INVALID/);
});
