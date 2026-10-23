import assert from 'node:assert/strict';
import test from 'node:test';
import { assessUiPostcondition, validateUiPostcondition, uiPostconditionNotChecked } from '../src/computer-use-postcondition.js';

const tree = (elements: Array<{selector?:string; type:string; value?:string; isEnabled?:boolean}>, elementsTruncated=false) =>
  ({ hwnd:101,elements,elementsTruncated });

test('exact full-tree UI value may be verified but application event may not', () => {
  const r=assessUiPostcondition(tree([{selector:'Status',type:'Text',value:'Selected 7'}]),
    {selector:'Status',condition:'value_equals',expected_value:'Selected 7'});
  assert.equal(r.ui_postcondition_verified,true);
  assert.equal(r.ui_postcondition_status,'met');
  assert.equal(r.app_event_verified,false);
  assert.equal(r.business_outcome_verified,false);
});
test('observed wrong scalar value is not met, not a business failure', () => {
  const r=assessUiPostcondition(tree([{selector:'Edit',type:'Edit',value:'pending'}]),
    {selector:'Edit',condition:'value_equals',expected_value:'saved'});
  assert.equal(r.ui_postcondition_status,'not_met');
  assert.equal(r.business_outcome_verified,false);
});
test('not exposed, truncated, ambiguous and no value fail inconclusively', () => {
  const condition={selector:'Target',condition:'present' as const};
  for(const inspection of [
    tree([]), tree([{selector:'Target',type:'Button'}],true),
    tree([{selector:'Target',type:'Button'},{selector:'Target',type:'Button'}])
  ]) assert.equal(assessUiPostcondition(inspection,condition).ui_postcondition_status,'inconclusive');
  assert.equal(assessUiPostcondition(tree([{selector:'Target',type:'Edit'}]),
    {selector:'Target',condition:'value_equals',expected_value:'42'}).ui_postcondition_status,'inconclusive');
});
test('invalid or conflicting condition values are rejected before mutation',()=>{
  assert.throws(()=>validateUiPostcondition({selector:' ',condition:'present'}),/exact selector/);
  assert.throws(()=>validateUiPostcondition({selector:'A',condition:'value_equals'}),/requires expected_value/);
  assert.throws(()=>validateUiPostcondition({selector:'A',condition:'enabled',expected_value:'foo'}),/only applies/);
});
test('backend or lease errors never authorize a retry or imply app success',()=>{
  const r=uiPostconditionNotChecked('provider_or_window_identity_unavailable');
  assert.equal(r.ui_postcondition_status,'inconclusive');
  assert.equal(r.app_event_verified,false);
  assert.equal(r.business_outcome_verified,false);
});
