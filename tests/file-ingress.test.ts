import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { receiveFile, validatedDownloadUrl } from '../src/file-ingress-core.js';

const bytes=Buffer.from('UEsDBBQAAAAAAAAAIQBlEF8jHAAAABwAAAALAAAAZml4dHVyZS50eHREZXNrTUNQIHN5bnRoZXRpYyB0ZXN0IGRhdGEKUEsBAhQAFAAAAAAAAAAhAGUQXyMcAAAAHAAAAAsAAAAAAAAAAAAAAIABAAAAAGZpeHR1cmUudHh0UEsFBgAAAAABAAEAOQAAAEUAAAAAAA==','base64');
const digest=createHash('sha256').update(bytes).digest('hex');

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'deskmcp-ingress-'));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const fake: typeof fetch = async (_url, init) => {
  assert.equal(init?.redirect, 'error');
  return new Response(Uint8Array.from(bytes), { headers: { 'content-length': String(bytes.length) } });
};
function options(root: string, name = 'test.zip') {
  return { downloadUrl: 'https://files.openai.com/content?fake=test', root, target: path.join(root,name),
    expectedSize: bytes.length, expectedSha256: digest };
}
test('receives exact synthetic ZIP bytes', () => fixture(async root => {
  const opts = options(root);
  const r = await receiveFile(opts,fake);
  assert.equal(r.sha256,digest);
  assert.equal(r.size_bytes,bytes.length);
  assert.deepEqual(await readFile(opts.target),bytes);
}));
test('does not overwrite existing files', () => fixture(async root => {
  const opts = options(root);
  await receiveFile(opts,fake);
  await assert.rejects(receiveFile(opts,fake),/Destination exists/);
  assert.deepEqual(await readFile(opts.target),bytes);
}));
test('rejects wrong hash, size and signature, and cleans temporary files', () => fixture(async root => {
  await assert.rejects(receiveFile({...options(root,'hash.zip'), expectedSha256:'0'.repeat(64)},fake));
  await assert.rejects(receiveFile({...options(root,'size.zip'), expectedSize:bytes.length-1},fake));
  await assert.rejects(receiveFile({downloadUrl: options(root).downloadUrl,root,target:path.join(root,'signature.zip'),expectedSize:4},async()=>new Response('oops')));
  assert.deepEqual(await readdir(root),[]);
}));
test('rejects unsupported origins, credentials, redirects and outside destinations', () => fixture(async root => {
  for(const url of ['http://files.openai.com/x','https://files.openai.com.evil.test/x','https://localhost/x','https://name:password@files.openai.com/x','https://files.openai.com:444/x']) assert.throws(()=>validatedDownloadUrl(url));
  await assert.rejects(receiveFile({...options(root),target:path.join(root,'..','outside.zip')},fake),/Outside/);
  await assert.rejects(receiveFile(options(root),async()=>new Response(null,{status:302,headers:{location:'https://example.org'}})));
}));
test('limits writes to a flat inbox and prevents concurrent clobber', () => fixture(async root => {
  await mkdir(path.join(root,'nested'));
  await assert.rejects(receiveFile({...options(root),target:path.join(root,'nested','a.zip')},fake),/Outside/);
  const opts=options(root,'race.zip');
  const rs=await Promise.allSettled([receiveFile(opts,fake),receiveFile(opts,fake)]);
  assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(rs.filter(r=>r.status==='rejected').length,1);
  assert.deepEqual(await readFile(opts.target),bytes);
  assert(!(await readdir(root)).some(n=>n.endsWith('.part')));
}));
