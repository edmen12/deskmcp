/**
 * Verifies archived BrowserRuntime real-Desktop2 Chrome E2E result metadata.
 * Chrome/CDP-specific evidence does NOT authorize native Computer Use actions.
 */
export interface ChromeD2Result {
  readonly pass?: boolean;
  readonly before?: number;
  readonly after?: number;
  readonly realD2Chrome?: boolean;
  readonly appEffects?: boolean;
  readonly noTargetForeground?: boolean;
  readonly foregroundChangedCount?: number;
  readonly ownedChromeForegroundCount?: number;
  readonly observerExit?: boolean;
  readonly browserExit?: boolean;
  readonly leaseHeldThroughTeardown?: boolean;
  readonly tripwire?: boolean;
  readonly failures?: readonly unknown[];
}
export function assessChromeD2Result(row: ChromeD2Result) {
  if (row.pass !== true
    || row.before !== 1 || row.after !== 1
    || row.realD2Chrome !== true || row.appEffects !== true
    || row.noTargetForeground !== true
    || row.tripwire !== false
    || row.ownedChromeForegroundCount !== 0
    || !Number.isSafeInteger(row.foregroundChangedCount)
    || (row.foregroundChangedCount ?? -1) < 0
    || row.observerExit !== true || row.browserExit !== true
    || row.leaseHeldThroughTeardown !== true
    || !Array.isArray(row.failures) || row.failures.length !== 0) {
    throw new Error('CHROME_D2_EVIDENCE_INCOMPLETE_OR_UNSAFE');
  }
  return {
    chrome_specific_app_effect_verified: true as const,
    owned_browser_foreground_events: 0 as const,
    all_session_foreground_quiet: row.foregroundChangedCount === 0,
    unrelated_foreground_events: row.foregroundChangedCount,
    generalized_native_computer_use_approved: false as const,
    production_release_approved: false as const
  };
}
