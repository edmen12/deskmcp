import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {BrowserHumanProofVerifier} from '../src/browser-human-proof.js';
import {createBrowserHandoffBoundary} from '../src/browser-handoff-boundary.js';
import {
  BrowserHumanConsentCoordinator,
  type BrowserHumanNativeSigner,
  type BrowserHumanLiveLeaseVerifier
} from '../src/browser-human-consent-coordinator.js';

const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const PUBLIC=publicKey.export({type:'spki',format:'pem'}).toString();
const SESSION='11111111-1111-4111-8111-111111111111';
const LEASE='22222222-2222-4222-8222-222222222222';
const make=() => {
  const verifier=new BrowserHumanProofVerifier(PUBLIC);
  const boundary=createBrowserHandoffBoundary(()=>{},verifier);
  const signer: BrowserHumanNativeSigner = {
    // Synthetic cryptographic signer used exclusively in this unit test.
    async signChallenge({challenge,lease_id}) {
      return {challenge_id:challenge.challenge_id,lease_id,
        signature_b64:sign('sha256',Buffer.from(challenge.message,'utf8'),privateKey).toString('base64')};
    }
  };
  const lease: BrowserHumanLiveLeaseVerifier={async assertLeaseForSession(s,id) {
    assert.equal(s,SESSION);assert.equal(id,LEASE);
  }};
  return {verifier,boundary,signer,lease};
};
test('native-signer coordinator checks lease and single-use user proof for both transitions',async()=>{
  const t=make();const log:string[]=[];
  const coordinator=new BrowserHumanConsentCoordinator(t.boundary,t.verifier,t.signer,{
    async assertLeaseForSession(s,id){log.push(s+id);await t.lease.assertLeaseForSession(s,id);}
  });
  t.boundary.agent.request(SESSION);
  assert.equal((await coordinator.confirm(SESSION,LEASE,'accept')).state,'human');
  assert.equal((await coordinator.confirm(SESSION,LEASE,'resume')).state,'privacy-reset');
  assert.equal(log.length,4,'lease checked before and after each native broker confirmation');
  assert.throws(()=>t.boundary.agent.assertAgentAccess(SESSION),/human control/);
});
test('coordinator refuses fake IPC responses without a valid user-private-key signature',async()=>{
  const t=make();t.boundary.agent.request(SESSION);
  const signer:BrowserHumanNativeSigner={async signChallenge({challenge,lease_id}) {
    return {challenge_id:challenge.challenge_id,lease_id,signature_b64:'I clicked confirm'};
  }};
  const coordinator=new BrowserHumanConsentCoordinator(t.boundary,t.verifier,signer,t.lease);
  await assert.rejects(coordinator.confirm(SESSION,LEASE,'accept'),/signature/i);
  assert.equal(t.boundary.agent.status(SESSION).state,'handoff-requested');
});
test('lease invalidation after user signing prevents handoff',async()=>{
  const t=make();t.boundary.agent.request(SESSION);
  let checks=0;
  const coordinator=new BrowserHumanConsentCoordinator(t.boundary,t.verifier,t.signer,{
    async assertLeaseForSession(){checks++;if(checks===2)throw Error('HUD HEARTBEAT LOST');}
  });
  await assert.rejects(coordinator.confirm(SESSION,LEASE,'accept'),/HUD HEARTBEAT LOST/);
  assert.equal(t.boundary.agent.status(SESSION).state,'handoff-requested');
  assert.throws(()=>t.boundary.agent.assertAgentAccess(SESSION),/human control/);
});
test('revocation while OS signer is pending cannot restore prior browser control',async()=>{
  const t=make();t.boundary.agent.request(SESSION);
  let release!:()=>void;
  let entered!:()=>void;
  const held=new Promise<void>(r=>{release=r;});
  const started=new Promise<void>(r=>{entered=r;});
  const signer:BrowserHumanNativeSigner={async signChallenge(payload) {
    entered();await held;return t.signer.signChallenge(payload);
  }};
  const coordinator=new BrowserHumanConsentCoordinator(t.boundary,t.verifier,signer,t.lease);
  const pending=coordinator.confirm(SESSION,LEASE,'accept');
  await started;
  t.boundary.agent.revokeIfReserved(SESSION);
  release();
  await assert.rejects(pending,/Invalid browser handoff transition/i);
  assert.equal(t.boundary.agent.status(SESSION).state,'revoked');
});
