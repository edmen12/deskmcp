import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { BrowserHumanProofVerifier } from '../src/browser-human-proof.js';
import { createBrowserHandoffBoundary } from '../src/browser-handoff-boundary.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength:2048 });
const PUBLIC = publicKey.export({type:'spki',format:'pem'}).toString();
const SESSION='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const LEASE='33333333-3333-4333-8333-333333333333';
const OTHER_LEASE='44444444-4444-4444-8444-444444444444';
function signed(challenge: {challenge_id:string; message:string}, lease_id=LEASE) {
  return {
    challenge_id:challenge.challenge_id,
    lease_id,
    signature_b64:sign('sha256',Buffer.from(challenge.message,'utf8'),privateKey).toString('base64')
  };
}
test('cryptographic local proof authorizes accept and handback once, bound to session/lease/epoch/action', () => {
  const verifier=new BrowserHumanProofVerifier(PUBLIC);
  const authority=createBrowserHandoffBoundary(()=>undefined,verifier);
  authority.agent.request(SESSION);
  assert.throws(()=>authority.local.accept(SESSION,undefined!),/proof is required/i);
  const accept=verifier.issue(SESSION,LEASE,'accept',authority.agent.epoch(SESSION));
  assert.equal(authority.local.accept(SESSION,signed(accept)).state,'human');
  assert.throws(()=>authority.local.resume(SESSION,signed(accept)),/expired|replayed|mismatched/i);
  const resume=verifier.issue(SESSION,LEASE,'resume',authority.agent.epoch(SESSION));
  assert.equal(authority.local.resume(SESSION,signed(resume)).state,'privacy-reset');
  assert.throws(()=>authority.agent.assertAgentAccess(SESSION),/human control/i);
  assert.equal(authority.runtime.completePrivacyReset(SESSION).state,'agent');
  assert.throws(()=>authority.local.resume(SESSION,signed(resume)),/Invalid browser handoff transition/i);
});
test('forged local IPC confirmation and wrong cryptographic key never move ownership', () => {
  const verifier=new BrowserHumanProofVerifier(PUBLIC);
  const authority=createBrowserHandoffBoundary(()=>undefined,verifier);
  authority.agent.request(SESSION);
  const challenge=verifier.issue(SESSION,LEASE,'accept',authority.agent.epoch(SESSION));
  assert.throws(()=>authority.local.accept(SESSION,{
    challenge_id:challenge.challenge_id,lease_id:LEASE,signature_b64:'Verified'
  }),/Invalid local human confirmation signature/i);
  assert.equal(authority.agent.status(SESSION).state,'handoff-requested');
  assert.throws(()=>authority.local.accept(SESSION,signed(challenge)),/expired|replayed|mismatched/i);
  assert.equal(authority.agent.status(SESSION).state,'handoff-requested');
});
test('challenge rejects wrong lease and cannot reuse a failed signature', () => {
  const verifier=new BrowserHumanProofVerifier(PUBLIC);
  const authority=createBrowserHandoffBoundary(()=>undefined,verifier);
  authority.agent.request(SESSION);
  const challenge=verifier.issue(SESSION,LEASE,'accept',authority.agent.epoch(SESSION));
  assert.throws(()=>authority.local.accept(SESSION,signed(challenge,OTHER_LEASE)),/mismatched/i);
  assert.throws(()=>authority.local.accept(SESSION,signed(challenge)),/replayed|mismatched/i);
});
test('challenge rejects wrong session, action and state epoch', () => {
  const verifier=new BrowserHumanProofVerifier(PUBLIC);
  const authority=createBrowserHandoffBoundary(()=>undefined,verifier);
  authority.agent.request(SESSION);
  authority.agent.request(OTHER);
  const challenge=verifier.issue(SESSION,LEASE,'accept',authority.agent.epoch(SESSION));
  assert.throws(()=>authority.local.accept(OTHER,signed(challenge)),/mismatched/i);
  assert.throws(()=>authority.local.accept(SESSION,signed(challenge)),/replayed|mismatched/i);
  const second=verifier.issue(SESSION,LEASE,'resume',authority.agent.epoch(SESSION));
  assert.throws(()=>authority.local.accept(SESSION,signed(second)),/mismatched/i);
});
test('challenge expiry and replacement reject late confirmation', () => {
  let now=1000;
  const verifier=new BrowserHumanProofVerifier(PUBLIC,()=>now);
  const authority=createBrowserHandoffBoundary(()=>undefined,verifier);
  authority.agent.request(SESSION);
  const old=verifier.issue(SESSION,LEASE,'accept',authority.agent.epoch(SESSION));
  const replacement=verifier.issue(SESSION,LEASE,'accept',authority.agent.epoch(SESSION));
  assert.throws(()=>authority.local.accept(SESSION,signed(old)),/replayed|mismatched/i);
  now+=60000;
  assert.throws(()=>authority.local.accept(SESSION,signed(replacement)),/expired/i);
});
test('failed/revoked handoff cancels outstanding local challenges and never restores Agent authority', () => {
  const verifier=new BrowserHumanProofVerifier(PUBLIC);
  const authority=createBrowserHandoffBoundary(()=>undefined,verifier);
  authority.agent.request(SESSION);
  const challenge=verifier.issue(SESSION,LEASE,'accept',authority.agent.epoch(SESSION));
  authority.agent.revokeIfReserved(SESSION);
  assert.throws(()=>authority.local.accept(SESSION,signed(challenge)),/Invalid browser handoff transition/i);
  assert.equal(authority.agent.status(SESSION).state,'revoked');
  assert.throws(()=>authority.agent.assertAgentAccess(SESSION),/human control/i);
});
test('public verifier rejects untrusted weak or non-RSA keys', () => {
  const weak=generateKeyPairSync('rsa',{modulusLength:1024}).publicKey.export({type:'spki',format:'pem'}).toString();
  assert.throws(()=>new BrowserHumanProofVerifier(weak),/RSA-2048/i);
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'}).toString();
  assert.throws(()=>new BrowserHumanProofVerifier(ec),/RSA-2048/i);
});

test('Windows Hello SPKI DER Base64 pinning verifies the same single-use RSA challenge', () => {
  const der=publicKey.export({type:'spki',format:'der'}).toString('base64');
  const verifier=BrowserHumanProofVerifier.fromPinnedWindowsHelloSpkiBase64(der);
  const boundary=createBrowserHandoffBoundary(()=>undefined,verifier);
  boundary.agent.request(SESSION);
  const challenge=verifier.issue(SESSION,LEASE,'accept',boundary.agent.epoch(SESSION));
  assert.equal(boundary.local.accept(SESSION,signed(challenge)).state,'human');
  assert.throws(()=>BrowserHumanProofVerifier.fromPinnedWindowsHelloSpkiBase64('fake-public-key'),/SPKI/i);
});
