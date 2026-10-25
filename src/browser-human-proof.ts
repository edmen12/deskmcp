import { createPublicKey, randomBytes, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export type BrowserHumanAction = 'accept' | 'resume';
export interface BrowserHumanChallenge {
  readonly challenge_id: string;
  readonly message: string;
  readonly expires_at: number;
  readonly desktop_id: string;
}
export interface BrowserHumanResponse {
  readonly challenge_id: string;
  readonly signature_b64: string;
  readonly lease_id: string;
}
type Pending = {
  sessionId: string;
  leaseId: string;
  desktopId: string;
  action: BrowserHumanAction;
  epoch: number;
  message: string;
  expiresAt: number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64 = /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/;

/**
 * Candidate verifier for a locally-pinned Windows Hello credential public key.
 * It does not enroll a key. Its private half MUST be held by an OS-mediated
 * user-verification signer; an ordinary software key is only appropriate for tests.
 * Never expose issue/verify or public key enrollment as remote MCP tools.
 */
export class BrowserHumanProofVerifier {
  private readonly key: KeyObject;
  private readonly pending = new Map<string, Pending>();
  constructor(publicKeyPem: string, private readonly now: () => number = Date.now) {
    this.key = createPublicKey(publicKeyPem);
    if (this.key.asymmetricKeyType !== 'rsa' || (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error('Local human confirmation requires a pinned RSA-2048+ public key.');
    }
  }

  /**
   * Windows Hello KeyCredential.RetrievePublicKey(X509SubjectPublicKeyInfo)
   * supplies DER/SPKI bytes. Pairing/pinning must happen through trusted local
   * enrollment, NEVER an arbitrary untrusted IPC/MCP public-key upload.
   */
  static fromPinnedWindowsHelloSpkiBase64(encoded: string, now: () => number = Date.now): BrowserHumanProofVerifier {
    if (typeof encoded !== 'string' || encoded.length < 64 || encoded.length > 8192 ||
      !B64.test(encoded)) throw new Error('Invalid pinned Windows Hello SPKI.');
    const der = Buffer.from(encoded, 'base64');
    if (der.byteLength > 4096) throw new Error('Pinned Windows Hello SPKI is too large.');
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return new BrowserHumanProofVerifier(publicKey.export({type:'spki',format:'pem'}).toString(), now);
  }

  issue(sessionId: string, leaseId: string, desktopId: string, action: BrowserHumanAction, epoch: number): BrowserHumanChallenge {
    if (!UUID.test(sessionId) || !UUID.test(leaseId) || !UUID.test(desktopId) || !Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error('Invalid scoped human confirmation request.');
    }
    for (const [id, item] of this.pending) if (item.expiresAt <= this.now()) this.pending.delete(id);
    for (const [id, item] of this.pending) if (item.sessionId === sessionId) this.pending.delete(id);
    if (this.pending.size >= 16) throw new Error('Too many pending local human challenges.');
    const id = randomBytes(16).toString('hex');
    const expiresAt = this.now() + 60_000;
    const message = [
      'deskmcp-browser-human-v2', sessionId, leaseId, desktopId, action, String(epoch), id, String(expiresAt)
    ].join('\n');
    this.pending.set(id, { sessionId, leaseId, desktopId, action, epoch, message, expiresAt });
    return Object.freeze({challenge_id:id, message, expires_at:expiresAt, desktop_id:desktopId});
  }

  verify(sessionId: string, action: BrowserHumanAction, epoch: number, proof: BrowserHumanResponse | undefined): void {
    if (!proof || typeof proof.challenge_id !== 'string') throw new Error('OS-backed human confirmation proof is required.');
    const pending = this.pending.get(proof.challenge_id);
    // Consume the challenge even if the signature fails. Never retry the same approval.
    this.pending.delete(proof.challenge_id);
    if (!pending || pending.expiresAt <= this.now() || pending.sessionId !== sessionId ||
      pending.action !== action || pending.epoch !== epoch || pending.leaseId !== proof.lease_id) {
      throw new Error('Human confirmation challenge expired, replayed or mismatched the browser state.');
    }
    const raw = proof.signature_b64;
    if (typeof raw !== 'string' || raw.length > 2048 || raw.length < 32 || !B64.test(raw)) {
      throw new Error('Invalid local human confirmation signature.');
    }
    const signature = Buffer.from(raw, 'base64');
    if (signature.byteLength !== this.key.asymmetricKeyDetails?.modulusLength! / 8 ||
      !cryptoVerify('sha256', Buffer.from(pending.message, 'utf8'), this.key, signature)) {
      throw new Error('Human confirmation signature verification failed.');
    }
  }
  revokeSession(sessionId: string): void {
    for (const [id, item] of this.pending) if (item.sessionId === sessionId) this.pending.delete(id);
  }
}
