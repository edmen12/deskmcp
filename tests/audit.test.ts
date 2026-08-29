import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AuditLogger, type AuditRecord } from '../src/audit.js';
import { TEST_AREA } from '../src/paths.js';

const auditPath = path.join(TEST_AREA, 'audit-unit.jsonl');

function parseRecords(text: string): AuditRecord[] {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditRecord);
}

test('AuditLogger writes paired metadata-only JSONL records', async () => {
  await rm(auditPath, { force: true });
  const audit = new AuditLogger(auditPath);
  await audit.init();

  const allowed = await audit.begin(
    'desktop_read_file', 'read', 'read-only', 'C:\\safe\\file.txt'
  );
  await audit.finish(allowed, 'allow');

  const denied = await audit.begin(
    'desktop_write_file', 'write', 'workspace-write', 'C:\\safe\\blocked.txt'
  );
  await audit.finish(denied, 'deny', new Error('SECRET_CONTENT_MUST_NOT_APPEAR'));

  const text = await readFile(auditPath, 'utf8');
  const records = parseRecords(text);
  assert.equal(records.length, 4);
  assert.equal(records[0]?.phase, 'start');
  assert.equal(records[1]?.phase, 'finish');
  assert.equal(records[0]?.requestId, records[1]?.requestId);
  assert.equal(records[2]?.requestId, records[3]?.requestId);

  const finishAllowed = records[1];
  const finishDenied = records[3];
  assert.ok(finishAllowed?.phase === 'finish');
  assert.ok(finishDenied?.phase === 'finish');
  assert.equal(finishAllowed.outcome, 'allow');
  assert.equal(finishDenied.outcome, 'deny');
  assert.equal(finishDenied.errorType, 'Error');
  assert.doesNotMatch(text, /SECRET_CONTENT_MUST_NOT_APPEAR/);

  await rm(auditPath, { force: true });
});


test('AuditLogger rotates bounded logs while preserving metadata-only records', async () => {
  const rotatingPath = path.join(TEST_AREA, 'audit-rotate.jsonl');
  for (const suffix of ['', '.1', '.2']) await rm(rotatingPath + suffix, { force: true });
  const audit = new AuditLogger(rotatingPath, 1024, 2);
  await audit.init();

  await Promise.all(Array.from({ length: 18 }, async (_, index) => {
    const op = await audit.begin('desktop_read_file', 'read', 'read-only', `C:\\safe\\${index}.txt`);
    await audit.finish(op, index % 3 === 0 ? 'deny' : 'allow', new Error('ROTATE_SECRET_MUST_NOT_APPEAR'));
  }));

  const current = await readFile(rotatingPath, 'utf8');
  const previous = await readFile(rotatingPath + '.1', 'utf8');
  assert.ok(current.length > 0);
  assert.ok(previous.length > 0);
  assert.doesNotMatch(current + previous, /ROTATE_SECRET_MUST_NOT_APPEAR/);

  for (const suffix of ['', '.1', '.2']) await rm(rotatingPath + suffix, { force: true });
});
