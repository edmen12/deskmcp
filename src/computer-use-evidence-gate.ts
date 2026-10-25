/**
 * Offline validator of prior, owned Desktop2 WinForms ListBox acceptance traces.
 * This does not create a lease, launch a GUI or authorize a production action.
 * Raw HWND/PID/lease/observer paths stay in local test artifacts.
 */
export type NativeListStage = 'list-inspect' | 'list-deny-stale' | 'list-scroll';
type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : {};
const asRows = (value: unknown): RecordValue[] =>
  Array.isArray(value) ? value.map(asRecord) : [];
function requireEvidence(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error('DESKTOP2_LIST_EVIDENCE_' + code);
}
const EVENT_ORDER = [
  'HOST_MEMORY_PREFLIGHT_PASS', 'PREFLIGHT_PASS', 'OBSERVER_READY',
  'OWNED_FIXTURE_SPAWNED', 'OWNED_FIXTURE_CLOAKED',
  'TARGET_FOREGROUND_HOOK_ARMED', 'NATIVE_CHILD_CAPABILITY_PASS'
];
const GOOD_OBSERVER_EVENTS = new Set(['START', 'READY_AFTER_MESSAGE_PUMP']);

export function verifyNativeListDesktop2Evidence(
  stage: NativeListStage,
  resultInput: unknown,
  timelineInput: unknown,
  observerInput: unknown,
  applicationLog: string
): { stage: NativeListStage; pass: true; desktop1_unchanged: true;
     observer_quiet: true; owned_gui_cleanup: true;
     top_index_20_observed: boolean; stale_request_rejected: boolean } {
  const result = asRecord(resultInput);
  const timeline = asRows(timelineInput);
  const observer = asRows(observerInput);
  requireEvidence(result.stage === stage && result.pass === true
    && result.claimedForegroundSafety === true, 'RUN_NOT_PASSED');
  requireEvidence(result.desktopBefore === 1 && result.desktopAfter === 1
    && result.tripwire === false, 'OWNER_DESKTOP_TRIP');
  requireEvidence(result.ownedGuiExitConfirmed === true
    && result.observerExitConfirmed === true
    && result.leaseHeldThroughTeardown === true,
    'LIFECYCLE_UNCONFIRMED');
  requireEvidence(result.appCallbackCount === 0
    && result.appButtonCallbackCount === 0
    && Array.isArray(result.appFocusEvents) && result.appFocusEvents.length === 0,
    'UNEXPECTED_APP_INPUT');
  const observed = asRows(result.observed);
  requireEvidence(observed.length === 1
    && observed[0]?.controlType === 'NativeWin32.ListBox'
    && observed[0]?.canScrollNativeList === true
    && observed[0]?.canSetNativeValue === false, 'CHILD_CAPABILITY_MISSING');

  let lastIndex = -1;
  for (const event of EVENT_ORDER) {
    const next = timeline.findIndex((row, index) => index > lastIndex && row.event === event);
    requireEvidence(next > lastIndex, 'TIMELINE_ORDER_INVALID');
    lastIndex = next;
  }
  const eventIndex = (name: string) => timeline.findIndex(row => row.event === name);
  requireEvidence(eventIndex('FINAL_RESULT') > lastIndex, 'FINAL_EVENT_MISSING');
  const finalEvent = timeline[eventIndex('FINAL_RESULT')];
  requireEvidence(finalEvent?.pass === true && finalEvent?.tripwire === false
    && finalEvent?.desktopAfter === 1
    && finalEvent?.ownedGuiExitConfirmed === true
    && finalEvent?.observerExitConfirmed === true
    && finalEvent?.leaseHeldThroughTeardown === true,
    'FINAL_EVENT_INVALID');
  requireEvidence(eventIndex('FIRST_FAILURE_HALT') === -1
    && eventIndex('EARLY_FOREGROUND_OR_DESKTOP_TRIPWIRE') === -1
    && eventIndex('OWNER_VIRTUAL_DESKTOP_CHANGE_ABORT') === -1,
    'ABORT_EVENT_PRESENT');

  requireEvidence(observer.length >= 2
    && observer.some(row => row.kind === 'START')
    && observer.some(row => row.kind === 'READY_AFTER_MESSAGE_PUMP')
    && observer.every(row =>
      GOOD_OBSERVER_EVENTS.has(String(row.kind))
      && row.latchedAbort === false
      && row.notifications === 0
      && row.heartbeatChanges === 0),
    'OBSERVER_EVENTS_NOT_QUIET');

  const appTopChanges = applicationLog.split(/\r?\n/).filter(line => line.includes('APP_LIST_TOP='));
  const savedTopChanges = result.appListTopChanges;
  requireEvidence(Array.isArray(savedTopChanges)
    && savedTopChanges.length === appTopChanges.length
    && savedTopChanges.every((line, i) => line === appTopChanges[i]),
    'APP_STATE_TRACE_MISMATCH');
  requireEvidence(!/(APP_EDIT=|APP_BUTTON_CLICK=|ROOT_WM_(6|7|8|1C)\b)/.test(applicationLog),
    'UNEXPECTED_APP_EVENT');
  if (stage === 'list-scroll') {
    requireEvidence(eventIndex('NATIVE_LIST_TOPINDEX_READBACK_PASS') > lastIndex
      && appTopChanges.length === 1
      && appTopChanges[0]?.endsWith('APP_LIST_TOP=20'),
      'SCROLL_STATE_UNVERIFIED');
    requireEvidence(eventIndex('WRONG_TOPINDEX_REJECTED') === -1, 'UNEXPECTED_STALE_DENIAL');
  } else {
    requireEvidence(appTopChanges.length === 0
      && eventIndex('NATIVE_LIST_TOPINDEX_READBACK_PASS') === -1,
      'READ_ONLY_STAGE_MUTATED_LIST');
    requireEvidence(stage !== 'list-deny-stale'
      || eventIndex('WRONG_TOPINDEX_REJECTED') > lastIndex,
      'STALE_REQUEST_NOT_REJECTED');
    requireEvidence(stage !== 'list-inspect'
      || eventIndex('WRONG_TOPINDEX_REJECTED') === -1,
      'UNEXPECTED_DENIAL');
  }
  return {
    stage, pass: true, desktop1_unchanged: true, observer_quiet: true,
    owned_gui_cleanup: true,
    top_index_20_observed: stage === 'list-scroll',
    stale_request_rejected: stage === 'list-deny-stale'
  };
}
