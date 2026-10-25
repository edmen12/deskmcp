import type { WindowInspection } from './computer-use-backend.js';

export interface ComputerUiPostcondition {
  readonly selector: string;
  readonly condition: 'present' | 'enabled' | 'value_equals';
  readonly expected_value?: string | undefined;
  readonly scan_mode?: 'full' | 'interactive' | undefined;
}

export type UiPostconditionAssessment =
  | { readonly ui_postcondition_status: 'met'; readonly ui_postcondition_verified: true; readonly ui_postcondition_reason: 'unique_exact_control'; readonly app_event_verified: false; readonly business_outcome_verified: false }
  | { readonly ui_postcondition_status: 'not_met' | 'inconclusive'; readonly ui_postcondition_verified: false; readonly ui_postcondition_reason: string; readonly app_event_verified: false; readonly business_outcome_verified: false };

export function validateUiPostcondition(condition: ComputerUiPostcondition): void {
  if (!condition.selector.trim()) throw new Error('UI postcondition needs an exact selector.');
  if (condition.condition === 'value_equals' && condition.expected_value === undefined) {
    throw new Error('UI value_equals postcondition requires expected_value.');
  }
  if (condition.condition !== 'value_equals' && condition.expected_value !== undefined) {
    throw new Error('expected_value only applies to a UI value_equals postcondition.');
  }
}

export function assessUiPostcondition(
  inspection: WindowInspection,
  condition: ComputerUiPostcondition
): UiPostconditionAssessment {
  validateUiPostcondition(condition);
  const assessment = (status: 'met' | 'not_met' | 'inconclusive', reason: string): UiPostconditionAssessment =>
    status === 'met'
      ? { ui_postcondition_status: 'met', ui_postcondition_verified: true,
          ui_postcondition_reason: 'unique_exact_control', app_event_verified: false,
          business_outcome_verified: false }
      : { ui_postcondition_status: status, ui_postcondition_verified: false,
          ui_postcondition_reason: reason, app_event_verified: false,
          business_outcome_verified: false };
  if (inspection.elementsTruncated === true) return assessment('inconclusive', 'tree_truncated');
  const hits = inspection.elements.filter(element => element.selector === condition.selector);
  if (hits.length > 1) return assessment('inconclusive', 'selector_ambiguous');
  if (hits.length === 0) return assessment('inconclusive', 'selector_not_exposed_in_limited_scope');
  const element = hits[0]!;
  if (condition.condition === 'present') return assessment('met', 'unique_exact_control');
  if (condition.condition === 'enabled') {
    return element.isEnabled === true
      ? assessment('met', 'unique_exact_control')
      : assessment(element.isEnabled === false ? 'not_met' : 'inconclusive', 'enabled_not_confirmed');
  }
  if (element.value === undefined) return assessment('inconclusive', 'value_not_exposed');
  return element.value === condition.expected_value
    ? assessment('met', 'unique_exact_control')
    : assessment('not_met', 'observed_value_differs');
}

export function uiPostconditionNotChecked(reason: string): UiPostconditionAssessment {
  return { ui_postcondition_status: 'inconclusive', ui_postcondition_verified: false,
    ui_postcondition_reason: reason, app_event_verified: false,
    business_outcome_verified: false };
}
