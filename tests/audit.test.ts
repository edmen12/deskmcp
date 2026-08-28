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
