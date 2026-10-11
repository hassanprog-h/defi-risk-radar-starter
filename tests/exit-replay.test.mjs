import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReplay } from '../dist/live/replay.js';
import { analyzeLive } from '../dist/live/analyze.js';
import { quoteRedemption } from '../dist/live/exit.js';

const recording = JSON.parse(readFileSync(new URL('../fixtures/recordings/steakhouse-usdc.json', import.meta.url)));
const owner = '0x' + '1'.repeat(40);
const asset = recording.nodes.find(node => node.id === recording.rootPositionId && node.kind === 'vault');
const denomination = recording.edges.find(edge => edge.from === asset.id && edge.kind === 'ACCOUNTING_ASSET').to;
function snapshot() {
  const data = structuredClone(recording);
  data.observedAt = new Date().toISOString();
  data.unknowns = data.unknowns.filter(item => item.category !== 'freshness');
  const price = data.observations.find(item => item.entityId === denomination && item.metric === 'priceUsd');
  price.value = 1; price.evidence.blockTimestamp = new Date().toISOString();
  return data;
}
function rpc(overrides = {}) {
  return {
    anchor: async () => ({ number: '123', timestamp: new Date().toISOString(), hash: '0x' + '1'.repeat(64) }),
    sameBlock: async () => true,
    code: async () => '0x',
    read: async (address, signature) => {
      if (signature.includes('balanceOf')) return 1000000n;
      if (signature.includes('maxWithdraw')) return 1000000n;
      if (signature.includes('previewRedeem')) return 990000n;
      if (signature.includes('convertToAssets')) return 1000000n;
      if (signature.includes('asset()')) return denomination.split(':')[2];
      if (signature.includes('decimals()')) return 6;
      throw new Error('Unavailable');
    },
    gasPrice: async () => 1_000_000_000n, estimateRedeem: async () => 100000n,
    ...overrides
  };
}
const api = { base: 'https://api.morpho.org', http: { request: async () => ({ data: { assetByAddress: { price: { usd: 2000, timestamp: String(Math.floor(Date.now() / 1000)) } } } }) } };
test('redemption combines contract fee and gas with fresh reference prices', async () => {
  const quote = await quoteRedemption(snapshot(), rpc(), api, owner);
  assert.equal(quote.feasible, true);
  assert.equal(quote.fullExit, true);
  assert.equal(quote.positionValueUsd, 1);
  assert.equal(quote.feeAssets, '10000');
  assert.ok(Math.abs(quote.costUsd - .21) < 1e-12); // $0.01 redemption friction + $0.20 gas.
  assert.ok(quote.evidence.some(item => item.reference.includes('eth_estimateGas')));
});
test('no balance, restricted withdrawal, failed gas, reorg and stale prices remain distinct', async () => {
  const original = rpc();
  const noBalance = await quoteRedemption(snapshot(), rpc({ read: async () => '0' }), api, owner);
  assert.equal(noBalance.feasible, false);
  assert.ok(noBalance.evidence.length > 0);
  const blocked = await quoteRedemption(snapshot(), rpc({ read: async (a, s) => s.includes('maxWithdraw') ? '0' : original.read(a, s) }), api, owner);
  assert.equal(blocked.feasible, false);
  const failure = await quoteRedemption(snapshot(), rpc({ estimateRedeem: async () => { throw new Error('secret endpoint'); } }), api, owner);
  assert.equal(failure.feasible, null);
  assert.equal(JSON.stringify(failure).includes('secret'), false);
  const smartWallet = await quoteRedemption(snapshot(), rpc({ code: async () => '0x1234' }), api, owner);
  assert.equal(smartWallet.feasible, null);
  assert.equal(smartWallet.costUsd, null);
  const reorg = await quoteRedemption(snapshot(), rpc({ sameBlock: async () => false }), api, owner);
  assert.equal(reorg.feasible, null);
  assert.equal(reorg.costUsd, null);
  const stale = snapshot();
  stale.observations.find(item => item.entityId === denomination && item.metric === 'priceUsd').evidence.blockTimestamp = '2020-01-01T00:00:00.000Z';
  const unpriced = await quoteRedemption(stale, rpc(), api, owner);
  assert.equal(unpriced.feasible, true);
  assert.equal(unpriced.costUsd, null);
});
test('decision needs a fresh full exit; expired unavailable assessments cannot block forever', () => {
  const data = snapshot();
  const market = data.exposures.find(entry => entry.fraction > 0);
  const scenario = { id: 'stress', kind: 'MARKET_LOSS', targetNodeId: market.marketId, severityFraction: .2, horizonHours: 24, probabilityWithinHorizon: .25 };
  const exit = { feasible: true, fullExit: true, quotedAt: new Date().toISOString(), costUsd: 1, reasons: [], evidence: [], sourceBlock: '123' };
  assert.equal(analyzeLive(data, scenario, { positionUsd: 10000, exit }).decision.action, 'EXIT');
  assert.equal(analyzeLive(data, scenario, { positionUsd: 10000, exit: { ...exit, costUsd: 10000 } }).decision.action, 'STAY');
  assert.equal(analyzeLive(data, scenario, { positionUsd: 10000, exit: { ...exit, fullExit: false } }).decision.action, 'INSUFFICIENT_EVIDENCE');
  assert.equal(analyzeLive(data, scenario, { positionUsd: 10000, exit: { ...exit, feasible: false, quotedAt: '2020-01-01T00:00:00.000Z' } }).decision.action, 'INSUFFICIENT_EVIDENCE');
});
test('recordings preserve timestamps, support historical stress and cannot recommend current exit', () => {
  const replay = loadReplay(recording);
  assert.equal(replay.observedAt, recording.observedAt);
  assert.equal(replay.mode, 'historical_replay');
  replay.unknowns.push({ category: 'freshness', entityId: replay.rootPositionId, reason: 'Old recording' });
  const entry = replay.exposures.find(item => item.fraction > 0);
  const report = analyzeLive(replay, { id: 'stress', kind: 'MARKET_LOSS', targetNodeId: entry.marketId, severityFraction: .2, horizonHours: 24, probabilityWithinHorizon: .25 }, { positionUsd: 10000, exit: { feasible: true, fullExit: true, quotedAt: new Date().toISOString(), costUsd: 1, sourceBlock: '123', reasons: [], evidence: [] } });
  assert.equal(report.incident.incrementalLossIfStayingUsd, 10000 * entry.fraction * .2);
  assert.equal(report.decision.action, 'INSUFFICIENT_EVIDENCE');
  assert.ok(report.mechanisms[0].steps.length);
});
test('replay rejects dangling edges, foreign networks, fixture evidence and broken capital paths', () => {
  for (const mutate of [
    data => data.edges[0].to = 'missing',
    data => data.nodes.find(node => node.address).chainId = 8453,
    data => data.edges[0].evidence.sourceType = 'fixture',
    data => data.exposures[0].path = [data.rootPositionId, data.rootPositionId, data.exposures[0].marketId],
    data => data.nodes.push(data.nodes[0])
  ]) {
    const data = structuredClone(recording); mutate(data); assert.throws(() => loadReplay(data));
  }
});
test('vault exploit model uses an explicit shareholder haircut; other contract references do not imply loss', () => {
  const data = snapshot();
  const scenario = { id: 'exploit', kind: 'CONTRACT_EXPLOIT', targetNodeId: data.rootPositionId, severityFraction: .3, horizonHours: 24 };
  assert.equal(analyzeLive(data, scenario, { positionUsd: 10000 }).incident.incrementalLossIfStayingUsd, 3000);
  assert.equal(analyzeLive(data, { ...scenario, targetNodeId: data.nodes.find(node => node.kind === 'administrator').id }, { positionUsd: 10000 }).incident.incrementalLossIfStayingUsd, null);
});
