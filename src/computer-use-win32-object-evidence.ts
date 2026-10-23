/**
 * Evidence-only assessment for a real Microsoft Winver process booted into
 * a lease-scoped, private Win32 desktop object. This intentionally does NOT
 * prove visibility on Windows virtual Desktop2 or grant Computer Use actions.
 */
export interface IsolatedWinverReadEvidence {
  readonly stage?: string;
  readonly pass?: boolean;
  readonly owner_desktop_before?: number | null;
  readonly owner_desktop_after?: number | null;
  readonly hud_lease_verified?: boolean;
  readonly strict_observer_ready?: boolean;
  readonly preassigned_desktop_object?: boolean;
  readonly owned_system_winver_window_found?: boolean;
  readonly system_app_window_count?: number;
  readonly isolated_ui_inspection_status?: string;
  readonly isolated_ui_elements?: number;
  readonly app_business_effect_verified?: boolean;
  readonly windows_virtual_desktop2_visibility_verified?: boolean;
  readonly observer_quiet?: boolean;
  readonly owned_job_terminated?: boolean;
  readonly watcher_terminated?: boolean;
  readonly lease_held_through_teardown?: boolean;
  readonly production_action_authorized?: boolean;
  readonly errors?: readonly unknown[];
}

export function assessIsolatedWinverReadEvidence(value: IsolatedWinverReadEvidence) {
  if(value.stage!=='WIN32_ISOLATED_DESKTOP_OBJECT_PRELAUNCH_WINVER'
    || value.pass!==true
    || value.owner_desktop_before!==1 || value.owner_desktop_after!==1
    || value.hud_lease_verified!==true
    || value.strict_observer_ready!==true
    || value.preassigned_desktop_object!==true
    || value.owned_system_winver_window_found!==true
    || !Number.isSafeInteger(value.system_app_window_count)
    || !(value.system_app_window_count!>=1 && value.system_app_window_count!<=3)
    || value.isolated_ui_inspection_status!=='elements_visible'
    || !Number.isSafeInteger(value.isolated_ui_elements)
    || !(value.isolated_ui_elements!>0 && value.isolated_ui_elements!<=100)
    || value.app_business_effect_verified!==false
    || value.windows_virtual_desktop2_visibility_verified!==false
    || value.observer_quiet!==true
    || value.owned_job_terminated!==true
    || value.watcher_terminated!==true
    || value.lease_held_through_teardown!==true
    || value.production_action_authorized!==false
    || !Array.isArray(value.errors) || value.errors.length!==0
  ) throw Error('ISOLATED_WIN32_UIA_EVIDENCE_NOT_ACCEPTED');
  return {
    verified_isolated_win32_object_launch: true as const,
    verified_read_only_winapp_uia: true as const,
    observed_ui_element_count: value.isolated_ui_elements,
    desktop1_foreground_monitor_clear: true as const,
    windows_virtual_desktop2_visibility_proven: false as const,
    generic_mcp_computer_use_action_proven: false as const,
    business_outcome_proven: false as const,
    production_release_approved: false as const
  };
}
