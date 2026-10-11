import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDependencies } from '../dist/live/assess.js';

const now = Date.parse('2026-10-11T06:00:00Z');
function sample() {
  const evidence = { status: 'verified', sourceType: 'onchain_call', reference: 'test contract read', observedAt: new Date(now).toISOString(), blockNumber: '100' };
  return {
    schemaVersion: '1.0', snapshotId: 'test', mode: 'live', observedAt: evidence.observedAt, chainId: 1,
    blockNumber: '100', blockTimestamp: evidence.observedAt, rootPositionId: 'vault',
    nodes: [{ id: 'vault', kind: 'vault' }, { id: 'a', kind: 'lending_market', label: 'A' }, { id: 'b', kind: 'lending_market', label: 'B' }, { id: 'oracle', kind: 'oracle', label: 'Shared oracle' }],
    edges: [{ from: 'vault', to: 'a' }, { from: 'vault', to: 'b' }, { from: 'a', to: 'oracle' }, { from: 'b', to: 'oracle' }, { from: 'oracle', to: 'a' }],
    observations: [{ entityId: 'oracle', metric: 'oracleRoundComplete', value: true, evidence }, { entityId: 'oracle', metric: 'oracleAgeSeconds', value: 60, evidence }],
    exposures: [{ vaultId: 'vault', marketId: 'a', fraction: .6, path: ['vault', 'a'], evidence }, { vaultId: 'vault', marketId: 'b', fraction: .4, path: ['vault', 'b'], evidence }], unknowns: []
  };
}
test('automatic checks measure capital without manufacturing probability, loss or reallocation', () => {
  const result = assessDependencies(sample(), 10000, now);
  assert.equal(result.concentrations[0].exposureUsd, 6000);
  assert.equal(result.concentrations[1].exposureUsd, 4000);
  assert.equal(result.oracleChecks.length, 1, 'shared oracle and cycle must not duplicate checks');
  assert.equal(result.forecast.expectedLossUsd, null);
  assert.equal(result.forecast.probabilityWithinHorizon, null);
  assert.equal(result.allocation.action, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.allocation.executionEnabled, false);
});
test('failed verified round is an observation, never a lender haircut or forecast', () => {
  const snapshot = sample(); snapshot.observations[0].value = false;
  const result = assessDependencies(snapshot, 10000, now);
  assert.equal(result.failedRoundChecks, 1);
  assert.equal(result.forecast.prospectiveLossUsd, null);
  snapshot.observations[0].evidence.status = 'inferred';
  assert.equal(assessDependencies(snapshot, 10000, now).failedRoundChecks, 0);
  snapshot.observations[0].evidence.status = 'verified';
  snapshot.unknowns.push({ category: 'reorg', reason: 'Anchor hash changed' });
  assert.equal(assessDependencies(snapshot, 10000, now).failedRoundChecks, 0);
});
test('stale, unanchored and historical snapshots cannot claim current round checks or capital dollars', () => {
  for (const mutation of [s => { s.observedAt = new Date(now - 301000).toISOString(); }, s => { s.blockTimestamp = null; }, s => { s.blockTimestamp = new Date(now - 901000).toISOString(); }, s => { s.mode = 'historical_replay'; }]) {
    const snapshot = sample(); mutation(snapshot);
    const result = assessDependencies(snapshot, 10000, now);
    assert.equal(result.fresh, false); assert.equal(result.concentrations.length, 0); assert.equal(result.unknownOracleChecks, 1);
  }
});
test('duplicate and invalid capital cannot fabricate ranked exposures', () => {
  for (const mutation of [s => s.exposures.push(s.exposures[0]), s => { s.exposures[0].fraction = 2; }, s => { s.exposures[0].fraction = NaN; }, s => { s.exposures[0].evidence.status = 'unresolved'; }, s => s.unknowns.push({ category: 'accounting', reason: 'Incomplete' })]) {
    const snapshot = sample(); mutation(snapshot);
    assert.equal(assessDependencies(snapshot, 10000, now).accountingUsable, false);
  }
});
test('amount-only assessment validates size and does not require manual scenario inputs', () => {
  for (const value of [0, -1, NaN, Infinity, 1e13]) assert.throws(() => assessDependencies(sample(), value, now));
  assert.equal(assessDependencies(sample(), null, now).concentrations[0].exposureUsd, null);
  const snapshot = sample(); snapshot.observations[0].evidence.blockNumber = '99';
  assert.equal(assessDependencies(snapshot, 1, now).oracleChecks[0].status, 'UNKNOWN');
});
