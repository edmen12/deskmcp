import assert from 'node:assert/strict';
import test from 'node:test';
import { uiSelectorCoverage, verifyUiTargetGuard } from '../src/computer-use-target-guard.js';

test('UIA selector coverage reports empty and duplicate selector risk without false completeness', () => {
  const empty = uiSelectorCoverage([]);
  assert.equal(empty.semantic_tree_empty, true);
  assert.equal(empty.scope_complete, false);
  assert.equal(empty.unique_selectors, 0);
  const summary = uiSelectorCoverage([
    { selector: 'Save', type: 'Button' },
    { selector: 'Save', type: 'Button' },
    { selector: 'Cancel', type: 'Button' },
    { type: 'Text' }
  ]);
  assert.deepEqual(summary, {
    scanned_elements: 4,
    elements_with_selector: 3,
    unique_selectors: 1,
    ambiguous_selector_elements: 2,
    semantic_tree_empty: false,
    scope_complete: false
  });
});

test('guard accepts one exact selector with explicit identity and enabled state', () => {
  const data = {
    hwnd: 101,
    elements: [{ selector: 'Save', type: 'Button', automationId: 'SaveAction', name: 'Save', isEnabled: true }]
  };
  assert.equal(verifyUiTargetGuard(data, 'Save', { type: 'Button', automation_id: 'SaveAction', require_enabled: true }).name, 'Save');
});

test('guard rejects missing, ambiguous, changed or disabled controls before input', () => {
  const one = { hwnd: 101, elements: [{ selector: 'Save', type: 'Button', name: 'Save', isEnabled: false }] };
  assert.throws(() => verifyUiTargetGuard(one, 'Delete', { type: 'Button' }), /not exposed/i);
  assert.throws(() => verifyUiTargetGuard(one, 'Save', { type: 'MenuItem' }), /identity mismatch/i);
  assert.throws(() => verifyUiTargetGuard(one, 'Save', { type: 'Button', require_enabled: true }), /identity mismatch/i);
  assert.throws(() => verifyUiTargetGuard(one, 'Save', { require_enabled: true }), /exact identity field/i);
  const many = { hwnd: 101, elements: [{ selector: 'Save', type: 'Button' }, { selector: 'Save', type: 'Button' }] };
  assert.throws(() => verifyUiTargetGuard(many, 'Save', { type: 'Button' }), /ambiguous/i);
  assert.throws(() => verifyUiTargetGuard({ hwnd: 101, elements: [], elementsTruncated: true }, 'Save', { type: 'Button' }), /truncated UI tree/i);
});

test('guard rejects a truncated tree even if one matching selector is visible', () => {
  const returned = {
    hwnd: 101,
    elements: [{ selector: 'Save', type: 'Button', name: 'Save' }],
    elementsTruncated: true
  };
  assert.throws(() => verifyUiTargetGuard(returned, 'Save', { type: 'Button', name: 'Save' }), /truncated UI tree/i);
});
