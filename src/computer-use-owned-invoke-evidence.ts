/**
 * Offline consistency check of a *single owned-fixture* Win32-object Invoke run.
 * Evidence from the independent foreground observer is summarized by the
 * runner; this check does not independently replay the raw observer trace.
 */
export interface OwnedWinFormsInvokeEvidence {
  mode?: string;
  pass?: boolean;
  owner_before?: number | null;
  owner_after?: number | null;
  fixture_verified?: boolean;
  fixture_hash_verified?: boolean;
  observer_armed?: boolean;
  provider_controls?: number;
  matched_owned_button?: number;
  invoke_dispatched?: boolean;
  app_callback_attested?: boolean;
  app_click_callbacks?: number;
  unexpected_focus_events?: number;
  observer_quiet?: boolean;
  owned_job_terminated?: boolean;
  watcher_terminated?: boolean;
  lease_held_to_cleanup?: boolean;
  production_action_authorized?: boolean;
  errors?: unknown[];
  run_stamp?: string;
}

export function checkOwnedWinFormsInvokeEvidence(
  evidence: OwnedWinFormsInvokeEvidence,
  appLog: string,
  expectedStamp?: string
) {
  const stamped = typeof evidence.run_stamp === 'string';
  if (expectedStamp && stamped && evidence.run_stamp !== expectedStamp)
    throw Error('OWNED_INVOKE_EVIDENCE_RUN_MISMATCH');
  if (evidence.mode !== 'invoke' || evidence.pass !== true ||
    evidence.owner_before !== 1 || evidence.owner_after !== 1 ||
    evidence.fixture_verified !== true || evidence.fixture_hash_verified !== true ||
    evidence.observer_armed !== true || evidence.provider_controls == null ||
    !Number.isSafeInteger(evidence.provider_controls) || evidence.provider_controls < 1 ||
    evidence.matched_owned_button !== 1 || evidence.invoke_dispatched !== true ||
    evidence.app_callback_attested !== true || evidence.app_click_callbacks !== 1 ||
    evidence.unexpected_focus_events !== 0 || evidence.observer_quiet !== true ||
    evidence.owned_job_terminated !== true || evidence.watcher_terminated !== true ||
    evidence.lease_held_to_cleanup !== true ||
    evidence.production_action_authorized !== false ||
    !Array.isArray(evidence.errors) || evidence.errors.length !== 0)
    throw Error('OWNED_INVOKE_ACCEPTANCE_INCOMPLETE');

  const lines = appLog.split(/\r?\n/u).filter(Boolean);
  const shown = lines.filter(line => /\bAPP_SHOWN_FOREGROUND=0\s*$/u.test(line));
  const uncloak = lines.filter(line => /\bUNCLOAK_SUCCESS\s*$/u.test(line));
  const callbacks = lines.filter(line => /\bAPP_BUTTON_CLICK=/u.test(line));
  const focus = lines.filter(line =>
    /\b(ROOT_WM_(6|7|8|1C)|BUTTON_WM_(6|7|8))\b/u.test(line));
  if (shown.length !== 1 || uncloak.length !== 1 ||
    callbacks.length !== 1 || !/\bAPP_BUTTON_CLICK=1\s*$/u.test(callbacks[0]!) ||
    focus.length !== 0 ||
    !(lines.indexOf(shown[0]!) < lines.indexOf(uncloak[0]!) &&
      lines.indexOf(uncloak[0]!) < lines.indexOf(callbacks[0]!)))
    throw Error('OWNED_INVOKE_APP_LOG_DID_NOT_CORROBORATE');

  return {
    status: 'OWNED_FIXTURE_INVOKE_AND_APP_LOG_CONSISTENT' as const,
    app_click_callback_count: 1 as const,
    observer_summary_says_quiet: true as const,
    raw_observer_trace_reverified: false as const,
    log_run_binding: stamped ? 'explicit' as const : 'legacy_unbound' as const,
    generic_third_party_approved: false as const,
    production_action_authorized: false as const
  };
}
