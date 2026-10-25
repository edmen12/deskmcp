/**
 * Read-only categorization of Agent Desktop lease failures.
 * No retry, automatic reattachment or input authorization is ever granted.
 */
export function classifyAgentDesktopLeaseFailure(message: string) {
  if (message === 'Agent Desktop control was revoked or replaced.')
    return 'lease_revoked_or_replaced' as const;
  if (message.startsWith('Agent Desktop safety HUD heartbeat is missing or stale.'))
    return 'hud_heartbeat_missing_or_stale' as const;
  if (message === 'Agent Desktop binding is missing for the active lease.')
    return 'binding_missing' as const;
  if (message === 'STABILITY_OWNER_DESKTOP_CHANGED' || message === 'STABILITY_OWNER_NOT_DESKTOP1')
    return 'owner_desktop_mismatch' as const;
  if (message === 'STABILITY_LEASE_IDENTITY_CHANGED')
    return 'lease_identity_changed' as const;
  if (message === 'STABILITY_REQUIRES_DESKTOP2_HUD_LEASE')
    return 'wrong_desktop_lease' as const;
  return 'backend_or_unclassified_failure' as const;
}

export function assessObservedLeaseLoss(input: {
  readonly initialGeneration: number | null;
  readonly finalGeneration: number | null;
  readonly stillActive: boolean | null;
  readonly currentDesktopNumber: number | null;
  readonly mutationReason?: string | undefined;
}) {
  const {initialGeneration,finalGeneration} = input;
  const delta = initialGeneration !== null && finalGeneration !== null
    ? finalGeneration - initialGeneration : null;
  return {
    generation_delta: delta,
    control_still_active: input.stillActive,
    observed_owner_desktop: input.currentDesktopNumber,
    last_committed_reason: input.mutationReason ?? 'legacy_or_unavailable',
    // A current delta and lastMutation alone do not identify the writer
    // when there were concurrent writes or legacy Gateway instances.
    revoking_actor_verified: false as const,
    safely_reusable_without_new_lease: false as const
  };
}
