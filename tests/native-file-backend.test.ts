import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  createNativeDirectory,
  editNativeTextFile,
  getNativeFileInfo,
  listNativeDirectory,
  moveNativeFile,
  readNativeTextFile,
  writeNativeFile
} from '../src/native-file-backend.js';
import { TEST_AREA } from '../src/paths.js';

const root = path.join(TEST_AREA, 'native-file-backend-unit');

test('native text reader supports bounded and negative line offsets without legacy backend', async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'lines.txt');
  await writeFile(file, 'one\r\ntwo\r\nthree\r\n', 'utf8');

  try {
    const first = await readNativeTextFile(file, 0, 2);
    assert.ok(first);
    assert.match(first.text, /Reading 2 lines from start/);
    assert.match(first.text, /one\ntwo/);

    const last = await readNativeTextFile(file, -2, 10);
    assert.ok(last);
    assert.match(last.text, /Reading last 2 lines/);
    assert.match(last.text, /two\nthree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native text reader delegates rich and binary files to the legacy fallback', async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const pdf = path.join(root, 'sample.pdf');
  const binary = path.join(root, 'sample.bin');
  await writeFile(pdf, 'not-a-real-pdf', 'utf8');
  await writeFile(binary, Buffer.from([0x41, 0x00, 0x42]));

  try {
    assert.equal(await readNativeTextFile(pdf, 0, 10), undefined);
    assert.equal(await readNativeTextFile(binary, 0, 10), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native file backend preserves core list info write edit create and move contracts', async () => {
  await rm(root, { recursive: true, force: true });
  const nested = path.join(root, 'nested');
  const file = path.join(nested, 'file.txt');
  const moved = path.join(nested, 'moved.txt');

  try {
    await createNativeDirectory(nested);
    await writeNativeFile(file, 'alpha', 'rewrite');
    await writeNativeFile(file, ' beta', 'append');
    assert.equal(await readFile(file, 'utf8'), 'alpha beta');

    await editNativeTextFile(file, 'alpha', 'gamma', 1);
    assert.equal(await readFile(file, 'utf8'), 'gamma beta');

    const info = await getNativeFileInfo(file);
    assert.match(info.text, /"isFile": true/);

    const listing = await listNativeDirectory(root, 2);
    assert.match(listing.text, /\[DIR\] nested/);
    assert.match(listing.text, /\[FILE\] file\.txt/);

    await moveNativeFile(file, moved);
    assert.equal(await readFile(moved, 'utf8'), 'gamma beta');
    await assert.rejects(readFile(file, 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native move rejects directories to preserve the public regular-file contract', async () => {
  await rm(root, { recursive: true, force: true });
  const sourceDir = path.join(root, 'source-dir');
  const destinationDir = path.join(root, 'destination-dir');
  await mkdir(sourceDir, { recursive: true });

  try {
    await assert.rejects(
      moveNativeFile(sourceDir, destinationDir),
      /Move requires a regular file/
    );
    await assert.doesNotReject(mkdir(sourceDir, { recursive: true }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
