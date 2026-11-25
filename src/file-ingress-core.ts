import { createHash, randomUUID } from 'node:crypto';
import { open, link, unlink, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX = 128 * 1024 * 1024;
const allowedExtensions = new Set(['.png', '.apng', '.zip']);
export function validatedDownloadUrl(raw: string): URL {
  const u = new URL(raw);
  // Only known OpenAI file storage origins; no generic arbitrary URLs.
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash ||
      !(u.hostname === 'files.openai.com' || /^oaisdmntpr[a-z0-9]*\.blob\.core\.windows\.net$/.test(u.hostname))) {
    throw new Error('File origin not permitted');
  }
  return u;
}
function inside(root: string, candidate: string): boolean {
  const r = path.relative(root, candidate);
  return r !== '' && r !== '..' && !r.startsWith('..'+path.sep) && !path.isAbsolute(r);
}
export async function receiveFile(options: {
  downloadUrl: string; target: string; root: string;
  expectedSize?: number; expectedSha256?: string;
}, fetcher: typeof fetch = fetch) {
  const url = validatedDownloadUrl(options.downloadUrl);
  const root = await realpath(options.root);
  const rootIdentity = await lstat(root,{bigint:true});
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new Error('Invalid ingress root');
  const parent = await realpath(path.dirname(options.target));
  const name = path.basename(options.target);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,179}$/.test(name) ||
      /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ||
      !allowedExtensions.has(path.extname(name).toLowerCase())) throw new Error('Invalid destination filename');
  const target = path.join(parent, name);
  if (!inside(root,target) || path.relative(root,parent)!=='') throw new Error('Outside configured ingress root (flat inbox only)');
  // No symlinks at the destination, including dangling links.
  try { await lstat(target); throw new Error('Destination exists'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize) ||
      options.expectedSize < 1 || options.expectedSize > MAX)) throw new Error('Invalid expected size');
  if (options.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedSha256)) throw new Error('Invalid SHA-256');
  // Never log or return the signed URL. Do not follow redirects.
  const pending = path.join(parent,'.ingress-'+randomUUID()+'.part');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let owned = false;
  try {
    const res = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!res.ok || !res.body) throw new Error('Download failed');
    reader = res.body.getReader();
    const len = res.headers.get('content-length');
    if (len !== null && (!/^\d+$/.test(len) || Number(len)>MAX ||
        (options.expectedSize !== undefined && Number(len)!==options.expectedSize))) throw new Error('Unexpected content length');
    file = await open(pending,'wx',0o600); owned = true;
    const hash = createHash('sha256');
    let size = 0;
    let signature = Buffer.alloc(0);
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX || (options.expectedSize !== undefined && size > options.expectedSize)) throw new Error('Size limit exceeded');
      if (signature.length<8) signature=Buffer.concat([signature,Buffer.from(value.subarray(0,8-signature.length))]);
      hash.update(value);
      let offset=0;
      while(offset<value.byteLength) {
        const written=await file.write(value,offset,value.byteLength-offset);
        if (!written.bytesWritten) throw new Error('Short write');
        offset+=written.bytesWritten;
      }
    }
    const sha256 = hash.digest('hex');
    if (!size || (len!==null && Number(len)!==size) ||
        (options.expectedSize!==undefined && size!==options.expectedSize) ||
        (options.expectedSha256!==undefined && sha256!==options.expectedSha256)) throw new Error('Integrity mismatch');
    const ext=path.extname(target).toLowerCase();
    if (ext==='.zip' ? signature.subarray(0,4).toString('hex')!=='504b0304' :
       signature.toString('hex')!=='89504e470d0a1a0a') throw new Error('Unexpected file signature');
    await file.sync(); await file.close(); file=undefined;
    const finalIdentity = await lstat(root,{bigint:true});
    if (await realpath(path.dirname(target))!==parent || await realpath(options.root)!==root ||
        finalIdentity.dev!==rootIdentity.dev || finalIdentity.ino!==rootIdentity.ino ||
        !finalIdentity.isDirectory() || finalIdentity.isSymbolicLink()) throw new Error('Destination changed');
    // Atomic no-clobber on NTFS: hard link fails if destination already exists.
    await link(pending,target);
    return { path: target, size_bytes: size, sha256, expected_hash_verified: options.expectedSha256!==undefined };
  } catch {
    // Network errors can include a signed URL; expose only a fixed error.
    throw new Error('File receipt failed (origin, network, size, format, integrity or destination)');
  } finally {
    if(reader) await reader.cancel().catch(()=>{});
    if(file) await file.close().catch(()=>{});
    if(owned) await unlink(pending).catch(()=>{});
  }
}
