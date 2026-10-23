import assert from 'node:assert/strict';
import test from 'node:test';
import {assessChromeD2Result} from '../src/computer-use-thirdparty-evidence.js';
const good={pass:true,before:1,after:1,realD2Chrome:true,appEffects:true,
  noTargetForeground:true,foregroundChangedCount:0,ownedChromeForegroundCount:0,
  observerExit:true,browserExit:true,leaseHeldThroughTeardown:true,
  tripwire:false,failures:[]};
test('Chrome-specific third-party app E2E is not native Computer Use release evidence',()=>{
  const x=assessChromeD2Result(good);
  assert.equal(x.chrome_specific_app_effect_verified,true);
  assert.equal(x.generalized_native_computer_use_approved,false);
  assert.equal(x.production_release_approved,false);
});
test('unrelated foreground transitions are not relabelled target focus theft, nor full quiet',()=>{
  const x=assessChromeD2Result({...good,foregroundChangedCount:3});
  assert.equal(x.owned_browser_foreground_events,0);
  assert.equal(x.all_session_foreground_quiet,false);
  assert.equal(x.unrelated_foreground_events,3);
});
test('missing real D2, focus attribution, app callbacks, monitor or cleanup fail closed',()=>{
  for(const [key,value] of [
    ['pass',false],['before',2],['after',2],['realD2Chrome',false],
    ['appEffects',false],['noTargetForeground',false],['ownedChromeForegroundCount',1],
    ['observerExit',false],['browserExit',false],['leaseHeldThroughTeardown',false],
    ['tripwire',true],['failures',['error']],['foregroundChangedCount',-1]
  ] as const) assert.throws(()=>assessChromeD2Result({...good,[key]:value}),/INCOMPLETE_OR_UNSAFE/);
});
