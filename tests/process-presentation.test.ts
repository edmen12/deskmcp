import assert from 'node:assert/strict';
import test from 'node:test';
import { commandRequestsUserDesktopBrowser, requireSupportedProcessPresentation } from '../src/process-tools.js';

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


test('process browser escape guard detects shell/default-browser activation without blocking headless or HTTP CLI work', () => {
  for (const command of [
    'start https://example.com',
    'start "" "http://localhost:3000/"',
    'Start-Process https://example.com',
    'Invoke-Item http://localhost:3000',
    'ii https://example.com',
    'explorer.exe https://example.com',
    '[System.Diagnostics.Process]::Start("https://example.com")',
    'rundll32.exe url.dll,FileProtocolHandler https://example.com',
    'chrome.exe http://localhost:3000',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" https://example.com',
    'Start-Process chrome.exe'
  ]) {
    assert.equal(commandRequestsUserDesktopBrowser(command), true, command);
  }

  for (const command of [
    'curl https://example.com',
    'Invoke-WebRequest https://example.com',
    'node -e "fetch(\"https://example.com\")"',
    'chrome.exe --headless=new --remote-debugging-port=0 https://example.com',
    'npm test',
    'npm start -- https://example.com',
    'python -m pytest'
  ]) {
    assert.equal(commandRequestsUserDesktopBrowser(command), false, command);
  }
});
