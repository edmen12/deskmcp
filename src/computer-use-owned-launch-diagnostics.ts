/**
 * Sanitized, bounded diagnostics for isolated Windows ProcessHost readiness.
 * Pure parser: never starts/retries an app and never grants a GUI action.
 */
export type OwnedLaunchFailureKind =
  | 'shell_invocation_failure' | 'dotnet_runtime_failure'
  | 'process_host_failure' | 'fixture_initialization_failure'
  | 'process_exited_before_ready' | 'no_exit_observed';

export function classifyOwnedLaunchFailure(
  output: string
): { kind: OwnedLaunchFailureKind; process_host_exit_code: number | null; safe_to_retry_automatically: false } {
  const value = output.slice(-12_000);
  const exitMatch = /Process completed with exit code (\d+)/u.exec(value);
  const code = exitMatch ? Number(exitMatch[1]) : null;
  const kind: OwnedLaunchFailureKind =
    /(?:The term .{0,250}is not recognized|CommandNotFoundException|ParserError|cannot be loaded because running scripts)/iu.test(value)
      ? 'shell_invocation_failure'
      : /(?:hostfxr|hostpolicy|Microsoft\.NETCore\.App|You must install \.NET|Framework: .{0,100}was not found)/iu.test(value)
        ? 'dotnet_runtime_failure'
        : /(?:DeskMCP process host failed|Could not (?:start|attach|resume) the owned DeskMCP process)/iu.test(value)
          ? 'process_host_failure'
          : /(?:FIXTURE_ERROR|Unhandled exception|System\.Windows\.Forms\.ThreadException)/iu.test(value)
            ? 'fixture_initialization_failure'
            : code !== null ? 'process_exited_before_ready' : 'no_exit_observed';
  return { kind, process_host_exit_code: code, safe_to_retry_automatically: false };
}

export function describeLeaseLoss(beforeGeneration: number, afterGeneration: number | null) {
  if (!Number.isSafeInteger(beforeGeneration) || beforeGeneration < 0) {
    throw Error('LEASE_DIAGNOSTIC_INVALID_BASE_GENERATION');
  }
  return {
    status: 'lease_no_longer_valid' as const,
    generation_before: beforeGeneration,
    generation_after: Number.isSafeInteger(afterGeneration) ? afterGeneration : null,
    generation_changed: afterGeneration !== null ? afterGeneration !== beforeGeneration : null,
    // Generation changes identify modification, NOT the actor or motive.
    reset_cause_verified: false as const,
    retry_automatically: false as const
  };
}
