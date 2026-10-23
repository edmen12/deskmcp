import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PROJECT_ROOT } from '../src/paths.js';

const helper = readFileSync(
  path.join(PROJECT_ROOT, 'test-area', 'winforms-native-inventory', 'Program.cs'), 'utf8'
);
const runner = readFileSync(
  path.join(PROJECT_ROOT, 'scripts', 'benchmark-cloaked-winforms-uia.mjs'), 'utf8'
);
const documentation = readFileSync(
  path.join(PROJECT_ROOT, 'docs', 'NATIVE_WINFORMS_CAPABILITY_MATRIX.md'), 'utf8'
);

test('owned native inventory contains read-only Win32 APIs, no UI mutation transports', () => {
  for (const expected of [
    'EnumChildWindows', 'GetAncestor', 'GetWindowThreadProcessId',
    'IsWindow', 'GetClassName', 'GetWindowLongPtr'
  ]) assert.ok(helper.includes(expected), expected);
  for (const forbidden of [
    'PostMessage', 'SendInput', 'SetForegroundWindow',
    'SetActiveWindow', 'SwitchDesktop', 'SetWindowText', 'GetWindowText',
    'DwmSetWindowAttribute', 'ValuePattern', 'Clipboard', 'WM_SETTEXT',
    'BM_CLICK', 'MessageBox', 'LbSetCurSel', 'LbSetTopIndex',
    'LbSetSel', 'LbAddString', 'LbDeleteString', 'LbGetText'
  ]) assert.equal(helper.includes(forbidden), false, forbidden);
  assert.match(helper, /supports_native_action\s*=\s*false/);
  for (const safeQuery of ['LbGetCount', 'LbGetCurSel', 'LbGetTopIndex']) {
    assert.ok(helper.includes(safeQuery), safeQuery);
  }
  assert.match(helper, /if \(message != LbGetCount && message != LbGetCurSel && message != LbGetTopIndex\)/);
  assert.match(helper, /ReadTimeoutMs = 350/);
  assert.match(helper, /SmtoBlock \| SmtoAbortIfHung \| SmtoErrorOnExit/);
  assert.match(helper, /state_double_read_consistent = true/);
  assert.match(helper, /read_only_query_messages = 6/);
  assert.match(helper, /item_text_read = false/);
  assert.match(helper, /dispatch_count\s*=\s*0/);
});

test('owned inventory fails closed on exact fixture ownership, class, child roles and bounded enumeration', () => {
  for (const expected of [
    'OWNED_WINFORMS_INVENTORY_READ_ONLY',
    'WINFORMS_ROOT_PID_MISMATCH', 'OWNED_ROOT_OR_CHILD_IDENTITY_CHANGED',
    'OWNED_CHILD_CLASS_CHANGED', 'OWNED_CHILD_NOT_ENUMERATED_OR_ROOT_CHANGED',
    'MaxChildren = 128', 'CHILD_ENUMERATION_INCOMPLETE_OR_EXCEEDED_BUDGET'
  ]) assert.ok(helper.includes(expected), expected);
  assert.match(helper, /GetAncestor\(child, GaRoot\) != root/);
  assert.match(helper, /enumerated\.Contains\(child\)/);
});

test('benchmark preserves fixture hash pin, no-activate and negative read-only tests', () => {
  for (const token of [
    'OWNED_CLOAKED_WINFORMS_READ_ONLY_ONCE',
    'f6d064ad5d42b20d168423f678cc45241d22029b8d88c529a9349bc5e0dc2d03',
    'OWNED_NONACTIVATING_CLOAK_PROOF_FAILED',
    'wrong_process', 'swapped_control_roles', 'invalid_capability', 'wrong_list_handle', 'wrong_sentinel',
    'supports_native_action !== false', 'dispatch_count !== 0',
    'OWNED_NATIVE_READ_ONLY_FAIL_CLOSED_TEST_FAILED',
    'owned_fixture_exit_confirmed', 'OWNED_FIXTURE_EXIT_NOT_CONFIRMED',
    'fixtureProfile.expectedSelected', 'fixtureProfile.expectedTop',
    'OWNED_SELECTED_WINFORMS_READ_ONLY_ONCE',
    'dc2d60213082279c82bb246cf02568fd2e0541e231848bee7b47ae5728fddbd6'
  ]) assert.ok(runner.includes(token), token);
});

test('native HWND read-only proof is not an automatic Desktop2 or production action grant', () => {
  assert.match(documentation, /NOT EXPOSED/);
  assert.match(documentation, /Release gate remains RED/i);
  assert.match(documentation, /ListBox.*selection and scrolling actions remain NOT TESTED/is);
  assert.match(documentation, /current.*virtual desktop/i);
  assert.match(documentation, /historical.*Desktop2/i);
});

const positiveFixture = readFileSync(
  path.join(PROJECT_ROOT, 'test-area', 'winforms-list-state-fixture', 'Program.cs'), 'utf8'
);

test('selected nonzero ListBox state is preconfigured inside an owned, cloaked fixture', () => {
  assert.match(positiveFixture, /list\.SelectedIndex=7/);
  assert.match(positiveFixture, /list\.TopIndex=12/);
  assert.match(positiveFixture, /DwmSetWindowAttribute\(root,13,ref cloak,4\)/);
  assert.match(positiveFixture, /ShowWithoutActivation => true/);
  assert.match(positiveFixture, /initialForeground=originalForeground/);
  assert.match(positiveFixture, /listSelected=list\.SelectedIndex/);
  for (const forbidden of ['SendInput', 'SetForegroundWindow', 'SwitchDesktop']) {
    assert.equal(positiveFixture.includes(forbidden), false);
  }
});

test('ListBox read enforces stable bounded scalar state without reading item text', () => {
  assert.match(helper, /LbsMultipleSel \| LbsExtendedSel/);
  assert.match(helper, /firstCount != secondCount \|\| firstSelected != secondSelected \|\| firstTop != secondTop/);
  assert.match(helper, /firstCount < 1 \|\| firstCount > MaxListItems/);
  assert.match(helper, /firstSelected < -1 \|\| firstSelected >= firstCount/);
  assert.match(helper, /firstTop < 0 \|\| firstTop >= firstCount/);
  assert.match(helper, /GetWindowThreadProcessId\(root, out uint actualRootOwner\)/);
  assert.match(runner, /native\.list_state\?\.item_count !== proof\.listCount/);
  assert.match(runner, /native\.list_state\?\.top_index !== proof\.listTop/);
  assert.match(runner, /native\.list_state\?\.selected_index !== \(proof\.listSelected \?\? -1\)/);
});
