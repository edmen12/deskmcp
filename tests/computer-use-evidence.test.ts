import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenUiElementsForMcp, flattenUiElementsWithStatusForMcp } from '../src/computer-use-backend.js';
import { computerActionDispatchResult } from '../src/computer-use-tools.js';

const sampleTree = [
  {
    type: 'Window', name: 'Fixture',
    children: [
      { type: 'Edit', name: 'A', selector: 'A', processId: 999 },
      { type: 'Group', children: [{ type: 'Button', name: 'Save', selector: 'Save' }] }
    ]
  }
];

test('UI projection marks truncation only if an actual returned element is omitted', () => {
  const exact = flattenUiElementsWithStatusForMcp(sampleTree, 4);
  assert.deepEqual(exact.elements.map(item => item.type), ['Window', 'Edit', 'Group', 'Button']);
  assert.equal(exact.truncated, false);
  assert.equal(exact.elements[3]?.ancestorPath?.join('/'), 'Window/Group');

  const truncated = flattenUiElementsWithStatusForMcp(sampleTree, 3);
  assert.deepEqual(truncated.elements.map(item => item.type), ['Window', 'Edit', 'Group']);
  assert.equal(truncated.truncated, true);
  assert.equal('processId' in (truncated.elements[1] ?? {}), false);
  assert.deepEqual(flattenUiElementsForMcp(sampleTree, 3), truncated.elements);

  assert.equal(flattenUiElementsWithStatusForMcp(sampleTree, 5).truncated, false);
  assert.equal(flattenUiElementsWithStatusForMcp([], 0).truncated, false);
  assert.equal(flattenUiElementsWithStatusForMcp(sampleTree, 0).truncated, true);
});

test('multiple root elements count toward the snapshot cap', () => {
  const data = [{ type: 'Window', name: 'One' }, { type: 'Window', name: 'Two' }];
  assert.equal(flattenUiElementsWithStatusForMcp(data, 1).truncated, true);
  assert.equal(flattenUiElementsWithStatusForMcp(data, 2).truncated, false);
});

test('backend completion cannot be mistaken for an application outcome', () => {
  const click = computerActionDispatchResult('click', 'snapshot_available');
  assert.equal(click.succeeded, true); // Legacy compatibility: backend call returned.
  assert.equal(click.action_dispatched, true);
  assert.equal(click.outcome_verified, false);
  assert.equal(click.outcome_status, 'unverified');
  assert.equal(click.requires_outcome_check, true);

  const closed = computerActionDispatchResult('invoke', 'window_closed');
  assert.equal(closed.post_action_state, 'window_closed');
  assert.equal(closed.outcome_verified, false);

  const unavailable = computerActionDispatchResult('click', 'observation_unavailable');
  assert.equal(unavailable.action_dispatched, true);
  assert.equal(unavailable.outcome_verified, false);

  const wait = computerActionDispatchResult('wait', 'not_observed');
  assert.equal(wait.action_dispatched, false);
  assert.equal(wait.requires_outcome_check, false);
});
