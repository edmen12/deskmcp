import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopCommanderBridge } from '../src/desktop-commander-bridge.js';
import { DesktopPolicy } from '../src/desktop-policy.js';
import { SafeSearchRunner } from '../src/search-runner.js';
import { TEST_AREA } from '../src/paths.js';

function fakeBridge(capture: (args: Record<string, unknown>) => void): DesktopCommanderBridge {
  return {
    startSearch: async (args: Record<string, unknown>) => {
      capture(args);
      return { text: 'Started content search session: search_test\nStatus: RUNNING', isError: false };
    },
    getSearchResults: async () => ({ text: 'Status: COMPLETED\n✅ Search completed.', isError: false }),
    stopSearch: async () => ({ text: 'Stopped', isError: false })
  } as unknown as DesktopCommanderBridge;
}

test('search pre-excludes sensitive paths before Desktop Commander starts', async () => {
  const policy = await DesktopPolicy.create({ profile: 'read-only', allowedRoots: [TEST_AREA] });
  let captured: Record<string, unknown> = {};
  const runner = new SafeSearchRunner(fakeBridge(args => { captured = args; }), policy);
  const result = await runner.run({
    rootPath: TEST_AREA,
    pattern: 'needle',
    searchType: 'content',
    filePattern: '*.txt',
    ignoreCase: true,
    maxResults: 10,
    includeHidden: true,
    literalSearch: true,
    timeoutMs: 1000
  });
  assert.equal(result.isError, false);
  const filePattern = String(captured.filePattern ?? '');
  assert.match(filePattern, /\*\.txt/);
  for (const required of [
    '!**/.env', '!**/.env.*', '!**/.npmrc', '!**/.pypirc', '!**/.netrc',
    '!**/.ssh/**', '!**/.gnupg/**', '!**/.aws/credentials'
  ]) assert.match(filePattern, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('explicit sensitive-path opt-in does not inject implicit search excludes', async () => {
  const policy = await DesktopPolicy.create({
    profile: 'read-only', allowedRoots: [TEST_AREA], allowSensitivePaths: true
  });
  let captured: Record<string, unknown> = {};
  const runner = new SafeSearchRunner(fakeBridge(args => { captured = args; }), policy);
  const result = await runner.run({
    rootPath: TEST_AREA,
    pattern: 'needle',
    searchType: 'files',
    ignoreCase: true,
    maxResults: 10,
    includeHidden: true,
    literalSearch: false,
    timeoutMs: 1000
  });
  assert.equal(result.isError, false);
  assert.equal(captured.filePattern, undefined);
});

test('fully-unlocked search does not inject sensitive-path excludes', async () => {
  const policy = await DesktopPolicy.create({
    profile: 'fully-unlocked', allowedRoots: [TEST_AREA]
  });
  let captured: Record<string, unknown> = {};
  const runner = new SafeSearchRunner(fakeBridge(args => { captured = args; }), policy);
  const result = await runner.run({
    rootPath: TEST_AREA,
    pattern: 'needle',
    searchType: 'content',
    ignoreCase: true,
    maxResults: 10,
    includeHidden: true,
    literalSearch: true,
    timeoutMs: 1000
  });
  assert.equal(result.isError, false);
  assert.equal(captured.filePattern, undefined);
});
