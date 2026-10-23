import type { UiElementSummary, WindowInspection } from './computer-use-backend.js';

/**
 * Evidence for selectors actually returned by WinApp. A zero count is not proof
 * the application exposes no controls: backend depth/filter/provider may limit it.
 */
export function uiSelectorCoverage(elements: readonly UiElementSummary[]) {
  const counts = new Map<string, number>();
  for (const element of elements) {
    if (element.selector) counts.set(element.selector, (counts.get(element.selector) ?? 0) + 1);
  }
  let ambiguous = 0;
  for (const count of counts.values()) if (count > 1) ambiguous += count;
  return {
    scanned_elements: elements.length,
    elements_with_selector: elements.filter(element => Boolean(element.selector)).length,
    unique_selectors: [...counts.values()].filter(count => count === 1).length,
    ambiguous_selector_elements: ambiguous,
    semantic_tree_empty: elements.length === 0,
    scope_complete: false as const
  };
}

export interface UiTargetGuard {
  readonly type?: string | undefined;
  readonly name?: string | undefined;
  readonly automation_id?: string | undefined;
  readonly class_name?: string | undefined;
  readonly require_enabled?: boolean | undefined;
  readonly scan_mode?: 'interactive' | 'full' | undefined;
}

/**
 * Verify the target selector and at least one stable identity field before
 * dispatching an action. Never retry a failed guard with physical coordinates.
 */
export function verifyUiTargetGuard(
  inspection: WindowInspection,
  selector: string,
  guard: UiTargetGuard
): UiElementSummary {
  const hasIdentity = [guard.type, guard.name, guard.automation_id, guard.class_name]
    .some(value => typeof value === 'string' && value.length > 0);
  if (!hasIdentity) throw new Error('target_guard must contain an exact identity field.');
  if (inspection.elementsTruncated === true) {
    throw new Error('target_guard cannot establish selector uniqueness from a truncated UI tree. Narrow the target or retry with a fuller snapshot.');
  }
  const matching = inspection.elements.filter(element => element.selector === selector);
  if (matching.length !== 1) {
    throw new Error(matching.length
      ? 'target_guard rejected an ambiguous selector. Re-observe and narrow the target.'
      : 'target_guard target was not exposed in the current limited UI tree. Re-observe instead of guessing.');
  }
  const element = matching[0]!;
  if (
    (guard.type !== undefined && guard.type !== element.type)
    || (guard.name !== undefined && guard.name !== element.name)
    || (guard.automation_id !== undefined && guard.automation_id !== element.automationId)
    || (guard.class_name !== undefined && guard.class_name !== element.className)
    || (guard.require_enabled === true && element.isEnabled !== true)
  ) {
    throw new Error('target_guard identity mismatch. Target may have changed; re-observe before acting.');
  }
  return element;
}
