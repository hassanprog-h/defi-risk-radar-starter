import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { v2Schema, MorphoClient } from '../dist/connectors/morpho.js';
import { GraphBuilder } from '../dist/live/builder.js';
import { MorphoAdapter } from '../dist/adapters/morpho.js';
import { pinV2Accounting } from '../dist/live/accounting.js';
import { analyzeLive } from '../dist/live/analyze.js';
import { findPublicHolder } from '../dist/live/holders.js';
import { loadReplay } from '../dist/live/replay.js';
import { enrich } from '../dist/live/enrich.js';

const vault = v2Schema.parse(JSON.parse(readFileSync(new URL('../fixtures/upstream/morpho-v2-04422053.json', import.meta.url))).body.data.vaultV2ByAddress);
const adapter = vault.adapters.items[0], positions = adapter.positions.items;
const active = positions.filter(p => BigInt(p.state.supplyAssets) > 0n);
const total = active.reduce((sum, p) => sum + BigInt(p.state.supplyAssets), 0n);
const owner = '0x' + '1'.repeat(40);
async function setup(overrides = {}) {
  const builder = new GraphBuilder(1, vault.address);
  builder.snapshot.protocol = 'Morpho Vault V2';
  builder.snapshot.blockNumber = '123'; builder.snapshot.blockTimestamp = new Date().toISOString();
  await new MorphoAdapter({}).discover(builder, vault);
  const calls = [];
  const rpc = {
    read: async (address, signature, args, block) => {
      calls.push({ signature, block });
      if (signature.includes('asset()')) return vault.asset.address;
      if (signature.includes('totalAssets()') || signature.includes('realAssets()')) return total;
      if (signature.includes('totalSupply()')) return 1000n;
      if (signature.includes('adaptersLength()')) return 1n;
      if (signature.includes('adapters(uint256)')) return adapter.address;
      if (signature.includes('balanceOf')) return 0n;
      if (signature.includes('parentVault()')) return vault.address;
      if (signature.includes('morpho()')) return positions[0].market.morphoBlue.address;
      if (signature.includes('marketIdsLength()')) return BigInt(active.length);
      if (signature.includes('marketIds(uint256)')) return active[Number(args[0])].market.marketId;
      if (signature.includes('expectedSupplyAssets')) return BigInt(active.find(p => p.market.marketId === args[0]).state.supplyAssets);
      throw new Error('Unknown read');
    }, ...overrides
  };
  return { builder, rpc, calls };
}
test('V2 accounting reconciles all active markets at one block and preserves indexed evidence', async () => {
  const { builder, rpc, calls } = await setup();
  assert.equal(await pinV2Accounting(builder, rpc, vault), true);
  const data = builder.finish();
  assert.ok(calls.every(c => c.block === '123'));
  assert.equal(data.exposures.length, positions.length);
  assert.ok(data.exposures.every(e => e.evidence.sourceType === 'onchain_call' && e.evidence.blockNumber === '123'));
  assert.ok(data.exposures.some(e => e.fraction === 0));
  assert.ok(data.observations.some(o => o.metric === 'indexed:totalAssets'));
  assert.ok(data.observations.some(o => o.metric === 'accountingPinned' && o.value === true));
  assert.equal(data.observations.find(o => o.metric === 'totalAssets').value, String(total));
  const target = data.exposures.find(e => e.fraction > 0);
  const result = analyzeLive(data, { id: 'stress', kind: 'MARKET_LOSS', targetNodeId: target.marketId, severityFraction: .2, horizonHours: 24, probabilityWithinHorizon: .25 }, { positionUsd: 10000, assumedExitCostUsd: 500 });
  assert.equal(result.incident.incrementalLossIfStayingUsd, 10000 * target.fraction * .2);
  assert.equal(result.sensitivity.comparison, 'STAY_COST_LOWER');
  assert.equal(result.decision.action, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stressTest.status, 'CALCULATED');
  assert.equal(result.stressTest.expectedLossUsd, result.incident.incrementalLossIfStayingUsd * .25);
  assert.equal(result.stressTest.assumedExitCostUsd, 500);
  assert.ok(result.decisionRequirements.some(r => r.includes('No real redemption')));
  const replayed = analyzeLive(loadReplay(data), result.scenario, { positionUsd: 10000, assumedExitCostUsd: 500 });
  assert.equal(replayed.incident.incrementalLossIfStayingUsd, result.incident.incrementalLossIfStayingUsd);
  assert.equal(replayed.decision.action, 'INSUFFICIENT_EVIDENCE');
});
test('V2 missing active market, duplicate market, wrong parent, failed read and totals mismatch cannot unlock money estimates', async () => {
  const variants = [
    async original => ({ read: async (a, s, args, b) => s.includes('marketIdsLength') ? 129n : original(a, s, args, b) }),
    async original => ({ read: async (a, s, args, b) => s.includes('parentVault') ? owner : original(a, s, args, b) }),
    async original => ({ read: async (a, s, args, b) => s.includes('realAssets') ? total + 1n : original(a, s, args, b) }),
    async original => ({ read: async (a, s, args, b) => s.includes('marketIds(uint256)') ? active[0].market.marketId : original(a, s, args, b) }),
    async original => ({ read: async (a, s, args, b) => s.includes('expectedSupplyAssets') ? Promise.reject(new Error('secret endpoint')) : original(a, s, args, b) })
  ];
  for (const variant of variants) {
    const { builder, rpc } = await setup(); Object.assign(rpc, await variant(rpc.read));
    assert.equal(await pinV2Accounting(builder, rpc, vault), false);
    const data = builder.finish();
    assert.ok(data.unknowns.some(u => u.category === 'snapshot_consistency'));
    assert.equal(JSON.stringify(data).includes('secret endpoint'), false);
    assert.equal(data.observations.some(o => o.metric === 'accountingPinned'), false);
    const result = analyzeLive(data, { id: 'bad', kind: 'MARKET_LOSS', targetNodeId: data.exposures[0].marketId, severityFraction: .2, horizonHours: 24 }, { positionUsd: 10000 });
    assert.equal(result.incident.incrementalLossIfStayingUsd, null);
  }
  const missing = structuredClone(vault); missing.adapters.items[0].positions.items = positions.slice(1);
  const { builder, rpc } = await setup();
  assert.equal(await pinV2Accounting(builder, rpc, missing), false);
});
test('optional contract enrichment limits do not invalidate independently reconciled capital', async () => {
  const { builder, rpc } = await setup();
  assert.equal(await pinV2Accounting(builder, rpc, vault), true);
  for (let i = 0; i < 61; i++) builder.address('0x' + (i + 1000).toString(16).padStart(40, '0'), 'asset', `Unclassified asset ${i}`);
  await enrich(builder, { read: async () => { throw new Error('Unsupported getter'); }, storage: async () => undefined });
  const data = builder.finish();
  assert.ok(data.unknowns.some(u => u.category === 'enrichment' && u.reason.includes('60-node')));
  assert.equal(data.coverage.underlying, 'partial');
  const exposure = data.exposures.find(e => e.fraction > 0);
  const report = analyzeLive(data, { id: 'verified-capital', kind: 'MARKET_LOSS', targetNodeId: exposure.marketId, severityFraction: .2, horizonHours: 24, probabilityWithinHorizon: .25 }, { positionUsd: 10000, assumedExitCostUsd: 300 });
  assert.equal(report.stressTest.status, 'CALCULATED');
  assert.equal(report.incident.incrementalLossIfStayingUsd, 10000 * exposure.fraction * .2);
  assert.equal(report.decision.action, 'INSUFFICIENT_EVIDENCE', 'Partial enrichment does not establish a checked exit or overall safety');
});
test('public holder discovery rejects zero balances and smart wallets, and verifies the selected balance at one block', async () => {
  const { builder } = await setup(), calls = [];
  const candidates = [owner, '0x' + '2'.repeat(40), '0x' + '3'.repeat(40)];
  const api = { holders: async () => candidates.map(owner => ({ owner, shares: '999' })) };
  const rpc = {
    anchor: async () => ({ number: '456', hash: 'hash' }), sameBlock: async () => true,
    read: async (a, s, args, block) => { calls.push(block); return args[0] === candidates[0] ? 0n : 100n; },
    code: async address => address === candidates[1] ? '0x1234' : '0x'
  };
  const holder = await findPublicHolder(builder.finish(), rpc, api);
  assert.equal(holder.owner, candidates[2]); assert.equal(holder.shares, '100');
  assert.ok(calls.every(block => block === '456'));
  await assert.rejects(() => findPublicHolder(builder.finish(), { ...rpc, sameBlock: async () => false }, api), /NO_PUBLIC_EOA_HOLDER_FOUND/);
});
test('holder API validates vault/network identity and sanitizes addresses', async () => {
  const http = { request: async () => ({ data: { vaultV2ByAddress: { address: vault.address.toUpperCase().replace('0X','0x'), chain: { id: 1 }, positions: { items: [{ user: { address: owner }, shares: '1' }] } } } }) };
  const client = new MorphoClient(http);
  assert.equal((await client.holders(1, vault.address, 2))[0].owner, owner);
  await assert.rejects(() => client.holders(8453, vault.address, 2), e => e.code === 'IDENTITY_MISMATCH');
});
