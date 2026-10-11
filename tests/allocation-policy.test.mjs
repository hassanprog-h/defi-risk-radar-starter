import test from 'node:test';
import assert from 'node:assert/strict';
import { planReallocation } from '../dist/automation/allocation.js';
import { authorizeMigration } from '../dist/automation/policy.js';
const now = Date.parse('2026-10-11T06:00:00Z');
function vault(id, market, collateral) {
  const observedAt = new Date(now).toISOString();
  const evidence = { status: 'verified', sourceType: 'onchain_call', blockNumber: '100', observedAt };
  return { schemaVersion: '1.0', snapshotId: id, mode: 'live', observedAt, chainId: 1, blockNumber: '100', blockTimestamp: observedAt, rootPositionId: id,
    nodes: [{ id, kind: 'vault', label: id }, { id: market, kind: 'lending_market' }],
    edges: [{ from: id, to: market, kind: 'ALLOCATES_TO', evidence }, { from: id, to: 'USDC', kind: 'ACCOUNTING_ASSET', evidence },
      { from: market, to: collateral, kind: 'ACCEPTS_COLLATERAL', evidence }, { from: id, to: 'chain', kind: 'SETTLES_ON', evidence }],
    exposures: [{ marketId: market, vaultId: id, fraction: 1, path: [id, market], evidence }], observations: [], unknowns: [] };
}
test('minimum partial allocation enforces market and collateral limits including destination risk', () => {
  const result = planReallocation(vault('source', 'a', 'ETH'), [vault('dest', 'b', 'BTC')], 10000, { maxMarketFraction: .6, maxCollateralFraction: .7, maxMoveFraction: 1 }, now);
  assert.equal(result.status, 'MIGRATION_PROPOSED');
  assert.equal(result.selected.moveFraction, .4);
  assert.equal(result.selected.moveUsd, 4000);
  assert.deepEqual(result.selected.after, { largestMarket: .6, largestCollateral: .6 });
  assert.ok(result.selected.retainedDependencies.includes('USDC'));
  assert.ok(result.selected.retainedDependencies.includes('chain'));
  assert.equal(result.selected.expectedLossReductionUsd, null);
  assert.equal(result.executionEnabled, false);
});
test('new vault cannot disguise shared collateral, impossible limits, incompatible assets or stale accounting', () => {
  const source = vault('source', 'a', 'ETH'), destination = vault('dest', 'b', 'ETH');
  assert.equal(planReallocation(source, [destination], 100, undefined, now).candidates[0].status, 'LIMITS_UNACHIEVABLE');
  const other = vault('dest', 'b', 'BTC');
  assert.equal(planReallocation(source, [other], 100, { maxMarketFraction: .6, maxCollateralFraction: .7, maxMoveFraction: .2 }, now).selected, null);
  other.edges[1].to = 'DAI';
  assert.equal(planReallocation(source, [other], 100, undefined, now).candidates[0].status, 'INCOMPATIBLE_DESTINATION');
  source.observedAt = new Date(now - 301000).toISOString();
  assert.equal(planReallocation(source, [other], 100, undefined, now).status, 'INSUFFICIENT_EVIDENCE');
  assert.throws(() => planReallocation(source, [other], NaN, undefined, now));
});
const a = n => `0x${String(n).padStart(40, '0')}`;
function permission() {
  const createdAt = new Date(now).toISOString(), expiresAt = new Date(now + 60000).toISOString();
  return { intent: { chainId: 1, source: a(1), destination: a(2), asset: a(3), owner: a(4), receiver: a(4), shares: '100', minAssets: '99', minDestinationShares: '99', createdAt, expiresAt },
    policy: { mode: 'local_fork_only', chainId: 1, source: a(1), destinations: [a(2)], asset: a(3), owner: a(4), maxSharesPerMove: '100', maxCumulativeShares: '200', usedShares: '0', validUntil: expiresAt, revoked: false, cooldownSeconds: 300, lastExecutionAt: null } };
}
test('permission boundary rejects live mode, redirected recipients, unexpected destinations, amounts, expiry and revocation', () => {
  assert.equal(authorizeMigration(...Object.values(permission()), now).allowed, true);
  for (const change of [p => { p.policy.mode = 'mainnet'; }, p => { p.intent.receiver = a(5); }, p => { p.intent.destination = a(5); }, p => { p.intent.asset = a(5); }, p => { p.intent.chainId = 10; }, p => { p.intent.shares = '101'; }, p => { p.policy.usedShares = '150'; }, p => { p.policy.revoked = true; }, p => { p.intent.expiresAt = new Date(now).toISOString(); }, p => { p.intent.minAssets = '0'; }, p => { p.policy.lastExecutionAt = new Date(now - 1000).toISOString(); }]) {
    const p = permission(); change(p); assert.equal(authorizeMigration(p.intent, p.policy, now).allowed, false);
  }
});
