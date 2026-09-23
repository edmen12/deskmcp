import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DesktopPolicy } from '../src/desktop-policy.js';
import { SafeSearchRunner } from '../src/search-runner.js';
import { TEST_AREA } from '../src/paths.js';

const root = path.join(TEST_AREA, 'search-runner-native');

function parseResult(text: string): {
  complete: boolean;
  timedOut: boolean;
  resultCount: number;
  results: Array<{ type: string; file: string; line?: number; match?: string }>;
} {
  return JSON.parse(text) as {
    complete: boolean;
    timedOut: boolean;
    resultCount: number;
    results: Array<{ type: string; file: string; line?: number; match?: string }>;
  };
}

async function prepareFixture(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'public.txt'), 'SEARCH_NATIVE_COMMON public\n', 'utf8');
  await writeFile(path.join(root, '.env'), 'SEARCH_NATIVE_COMMON secret\n', 'utf8');
  await writeFile(path.join(root, 'nested', 'alpha.ts'), 'const needle = "SEARCH_NATIVE_TS";\n', 'utf8');
  await writeFile(path.join(root, 'nested', 'beta.js'), 'const needle = "SEARCH_NATIVE_JS";\n', 'utf8');
}

test('native search pre-excludes sensitive paths before ripgrep returns results', async () => {
  await prepareFixture();
  const policy = await DesktopPolicy.create({ profile: 'read-only', allowedRoots: [root] });
  const runner = new SafeSearchRunner(policy);

  try {
    const result = await runner.run({
      rootPath: root,
      pattern: 'SEARCH_NATIVE_COMMON',
      searchType: 'content',
      ignoreCase: false,
      maxResults: 10,
      includeHidden: true,
      literalSearch: true,
      timeoutMs: 5000
    });
    assert.equal(result.isError, false);
    const body = parseResult(result.text);
    assert.equal(body.timedOut, false);
    assert.equal(body.resultCount, 1);
    assert.match(body.results[0]?.file ?? '', /public\.txt$/);
    assert.doesNotMatch(JSON.stringify(body.results), /\.env/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit sensitive-path opt-in lets native search return hidden sensitive matches', async () => {
  await prepareFixture();
  const policy = await DesktopPolicy.create({
    profile: 'read-only',
    allowedRoots: [root],
    allowSensitivePaths: true
  });
  const runner = new SafeSearchRunner(policy);

  try {
    const result = await runner.run({
      rootPath: root,
      pattern: 'SEARCH_NATIVE_COMMON',
      searchType: 'content',
      filePattern: '.env|*.txt',
      ignoreCase: false,
      maxResults: 10,
      includeHidden: true,
      literalSearch: true,
      timeoutMs: 5000
    });
    assert.equal(result.isError, false);
    const body = parseResult(result.text);
    assert.equal(body.resultCount, 2);
    assert.match(JSON.stringify(body.results), /public\.txt/);
    assert.match(JSON.stringify(body.results), /\.env/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fully-unlocked native search does not inject sensitive-path excludes', async () => {
  await prepareFixture();
  const policy = await DesktopPolicy.create({
    profile: 'fully-unlocked',
    allowedRoots: [root]
  });
  const runner = new SafeSearchRunner(policy);

  try {
    const result = await runner.run({
      rootPath: root,
      pattern: 'SEARCH_NATIVE_COMMON',
      searchType: 'content',
      filePattern: '.env|*.txt',
      ignoreCase: true,
      maxResults: 10,
      includeHidden: true,
      literalSearch: true,
      timeoutMs: 5000
    });
    assert.equal(result.isError, false);
    const body = parseResult(result.text);
    assert.equal(body.resultCount, 2);
    assert.match(JSON.stringify(body.results), /\.env/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native file search preserves file-pattern and substring semantics', async () => {
  await prepareFixture();
  const policy = await DesktopPolicy.create({ profile: 'read-only', allowedRoots: [root] });
  const runner = new SafeSearchRunner(policy);

  try {
    const result = await runner.run({
      rootPath: root,
      pattern: 'alpha',
      searchType: 'files',
      filePattern: '*.ts',
      ignoreCase: true,
      maxResults: 10,
      includeHidden: false,
      literalSearch: false,
      timeoutMs: 5000
    });
    assert.equal(result.isError, false);
    const body = parseResult(result.text);
    assert.equal(body.resultCount, 1);
    assert.match(body.results[0]?.file ?? '', /alpha\.ts$/);
    assert.doesNotMatch(JSON.stringify(body.results), /beta\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native search stops once the requested result limit is satisfied', async () => {
  await prepareFixture();
  const policy = await DesktopPolicy.create({
    profile: 'read-only',
    allowedRoots: [root],
    allowSensitivePaths: true
  });
  const runner = new SafeSearchRunner(policy);

  try {
    const result = await runner.run({
      rootPath: root,
      pattern: 'SEARCH_NATIVE_COMMON',
      searchType: 'content',
      ignoreCase: false,
      maxResults: 1,
      includeHidden: true,
      literalSearch: true,
      timeoutMs: 5000
    });
    assert.equal(result.isError, false);
    const body = parseResult(result.text);
    assert.equal(body.resultCount, 1);
    assert.equal(body.timedOut, false);
    assert.equal(body.complete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
