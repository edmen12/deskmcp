/**
 * Evidence-only validation of the self-owned WinForms ListBox Desktop2 experiment.
 * Not a selection action, authorization, or a production Computer Use MCP route.
 */
export type SelectionStage = 'list-select-probe' | 'list-managed-event-control' | 'list-select-stale';

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const rows = (x: unknown): Obj[] => Array.isArray(x) ? x.map(obj) : [];
const assertProof = (condition: unknown, reason: string) => {
  if (!condition) throw Error('D2_SELECTION_EVIDENCE_' + reason);
};

export function verifySelectionEvidence(
  stage: SelectionStage, resultInput: unknown, timelineInput: unknown,
  observerInput: unknown, log: string
): { stage: SelectionStage; pass: true; index: 7; managed_selection_events: number;
     foreground_tripwire_clear: true; production_action_authorized: false } {
  const r = obj(resultInput);
  const events = rows(timelineInput);
  const observer = rows(observerInput);
  assertProof(r.stage === stage && r.pass === true && r.claimedForegroundSafety === true,
    'RESULT_INCOMPLETE');
  assertProof(r.desktopBefore === 1 && r.desktopAfter === 1 && r.tripwire === false
    && r.ownedGuiExitConfirmed === true && r.observerExitConfirmed === true
    && r.leaseHeldThroughTeardown === true, 'DESKTOP_OR_LIFECYCLE_NOT_PROVEN');
  assertProof(Array.isArray(r.appFocusEvents) && r.appFocusEvents.length === 0
    && Array.isArray(r.appListTopChanges) && r.appListTopChanges.length === 0
    && r.appCallbackCount === 0 && r.appButtonCallbackCount === 0,
    'UNEXPECTED_APP_EFFECT');
  const seen = rows(r.observed);
  assertProof(seen.length === 1 && seen[0]?.controlType === 'NativeWin32.ListBox'
    && seen[0]?.canScrollNativeList === true
    && seen[0]?.canSetNativeValue === false, 'TARGET_IDENTITY_UNVERIFIED');

  const required = [
    'HOST_MEMORY_PREFLIGHT_PASS', 'OBSERVER_READY', 'OWNED_FIXTURE_CLOAKED',
    'TARGET_FOREGROUND_HOOK_ARMED', 'NATIVE_CHILD_CAPABILITY_PASS'
  ];
  let index = -1;
  for (const name of required) {
    index = events.findIndex((row, i) => i > index && row.event === name);
    assertProof(index >= 0, 'GUARD_ORDER_INCOMPLETE');
  }
  const indexOf = (name: string) => events.findIndex(row => row.event === name);
  assertProof(indexOf('FINAL_RESULT') > index
    && indexOf('FIRST_FAILURE_HALT') < 0
    && indexOf('EARLY_FOREGROUND_OR_DESKTOP_TRIPWIRE') < 0
    && indexOf('OWNER_VIRTUAL_DESKTOP_CHANGE_ABORT') < 0, 'ABORTED_OR_MISSING_FINAL');
  const final = events[indexOf('FINAL_RESULT')];
  assertProof(final?.pass === true && final?.tripwire === false
    && final?.desktopAfter === 1 && final?.ownedGuiExitConfirmed === true
    && final?.observerExitConfirmed === true && final?.leaseHeldThroughTeardown === true,
    'FINAL_GUARD_UNVERIFIED');
  assertProof(observer.some(x => x.kind === 'START')
    && observer.some(x => x.kind === 'READY_AFTER_MESSAGE_PUMP')
    && observer.every(x => (x.kind === 'START' || x.kind === 'READY_AFTER_MESSAGE_PUMP')
      && x.latchedAbort === false && x.notifications === 0
      && x.heartbeatChanges === 0), 'OBSERVER_NOT_QUIET');

  const normalized = (text: string, token: string) => text.split(/\r?\n/)
    .filter(line => line.includes(token)).map(line => line.slice(line.indexOf(token)));
  const state = normalized(log, 'APP_LIST_SELECTED_STATE=');
  const callbacks = normalized(log, 'APP_LIST_SELECTION_CHANGED=');
  assertProof(state.length === 1 && state[0] === 'APP_LIST_SELECTED_STATE=7'
    && Array.isArray(r.selectedStateWitnesses)
    && r.selectedStateWitnesses.length === 1
    && r.selectedStateWitnesses[0] === state[0], 'SELECTED_STATE_MISMATCH');
  assertProof(Array.isArray(r.selectedChangedCallbacks)
    && r.selectedChangedCallbacks.length === callbacks.length
    && r.selectedChangedCallbacks.every((entry, i) => entry === callbacks[i]),
    'CALLBACK_TRACE_MISMATCH');
  const baseline = stage !== 'list-select-probe';
  assertProof(callbacks.length === (baseline ? 1 : 0)
    && callbacks.every(entry => entry === 'APP_LIST_SELECTION_CHANGED=7'),
    'CALLBACK_EXPECTATION_MISMATCH');
  if(stage === 'list-select-probe') {
    assertProof(indexOf('FIXTURE_NATIVE_SELECTION_READBACK_CONFIRMED') > index
      && indexOf('FIXTURE_NATIVE_SELECTION_STALE_REJECTED') < 0,
      'EXTERNAL_SELECTION_READBACK_NOT_ATTESTED');
  } else if (stage === 'list-select-stale') {
    assertProof(indexOf('FIXTURE_NATIVE_SELECTION_STALE_REJECTED') > index
      && indexOf('FIXTURE_NATIVE_SELECTION_READBACK_CONFIRMED') < 0,
      'STALE_REQUEST_NOT_REJECTED');
  } else {
    assertProof(indexOf('FIXTURE_NATIVE_SELECTION_READBACK_CONFIRMED') < 0
      && indexOf('FIXTURE_NATIVE_SELECTION_STALE_REJECTED') < 0,
      'CONTROL_STAGE_PERFORMED_EXTERNAL_SELECTION');
  }
  return {
    stage, pass: true, index: 7,
    managed_selection_events: callbacks.length,
    foreground_tripwire_clear: true,
    production_action_authorized: false
  };
}
