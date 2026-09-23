import assert from 'node:assert/strict';
import test from 'node:test';
import { requireSupportedProcessPresentation, windowsRelativePathBudget } from '../src/process-tools.js';

test('Windows keeps console visibility independent from privilege elevation', () => {
  assert.doesNotThrow(() => requireSupportedProcessPresentation('hidden', 'standard', 'win32'));
  assert.doesNotThrow(() => requireSupportedProcessPresentation('visible', 'standard', 'win32'));
  assert.doesNotThrow(() => requireSupportedProcessPresentation('hidden', 'admin', 'win32'));
  assert.doesNotThrow(() => requireSupportedProcessPresentation('visible', 'admin', 'win32'));
});

test('non-Windows platforms still reject visible console and admin elevation modes', () => {
  assert.doesNotThrow(() => requireSupportedProcessPresentation('hidden', 'standard', 'darwin'));
  assert.throws(
    () => requireSupportedProcessPresentation('visible', 'standard', 'darwin'),
    /supported on Windows only/
  );
  assert.throws(
    () => requireSupportedProcessPresentation('hidden', 'admin', 'darwin'),
    /supported on Windows only/
  );
});

test('Windows legacy path budget reports remaining relative headroom', () => {
  assert.equal(windowsRelativePathBudget('C:\\work'), 251);
  assert.equal(windowsRelativePathBudget('C:\\Users\\User\\Desktop\\DeskMCP'), 229);
});
