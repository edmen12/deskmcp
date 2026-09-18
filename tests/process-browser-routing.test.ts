import assert from 'node:assert/strict';
import test from 'node:test';
import { rejectInteractiveBrowserProcessLaunch } from '../src/process-tools.js';

test('process tool blocks interactive browser singleton escape but keeps headless CLI available', () => {
  for (const command of [
    'chrome.exe https://example.com',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" https://example.com',
    'msedge.exe https://example.com',
    'chromium.exe https://example.com',
    'start https://example.com',
    'powershell.exe -Command "Start-Process https://example.com"'
  ]) {
    assert.throws(() => rejectInteractiveBrowserProcessLaunch(command), /desktop_browser_session.*Agent Desktop lease/i);
  }

  assert.doesNotThrow(() => rejectInteractiveBrowserProcessLaunch('node -i'));
  assert.doesNotThrow(() => rejectInteractiveBrowserProcessLaunch('chrome.exe --headless=new https://example.com'));
  assert.doesNotThrow(() => rejectInteractiveBrowserProcessLaunch('msedge.exe --headless https://example.com'));
});
