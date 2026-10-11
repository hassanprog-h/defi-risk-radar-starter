import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MorphoClient, parseSelector, v1Schema, v2Schema } from '../dist/connectors/morpho.js';
import { JsonClient } from '../dist/connectors/http.js';
import { inspectVault } from '../dist/live/inspect.js';
import { analyzeLive } from '../dist/live/analyze.js';
import { GraphBuilder } from '../dist/live/builder.js';
import { MorphoAdapter } from '../dist/adapters/morpho.js';
import { traceAffectedPaths, validateSnapshot } from '../dist/core/graph.js';

const captures = ['morpho-v1-beef0173.json', 'morpho-v1-2371e134.json', 'morpho-v2-04422053.json'].map(file => JSON.parse(readFileSync(new URL(`../fixtures/upstream/${file}`, import.meta.url))));
function mockApi(capture) {
  const version = capture.body.data.vaultByAddress ? 1 : 2;
  const vault = capture.body.data[version === 1 ? 'vaultByAddress' : 'vaultV2ByAddress'];
  return new MorphoClient(new JsonClient(async (url, init) => {
    if (url.endsWith('/graphql')) return Response.json(capture.body);
    if (url.includes(`/v0/vaults-v${version}/`)) return Response.json({ data: { chain_id: vault.chain.id, address: vault.address, last_indexed_block: String(vault.state?.blockNumber ?? vault.chain.headBlock.number) } });
    return new Response('', { status: 404 });
  }));
}
test('two real captured V1 vaults normalize without address-specific edge maps', async () => {
  const results = [];
  for (const capture of captures.slice(0, 2)) {
    const snapshot = await inspectVault(`1:${capture.variables.address}`, { api: mockApi(capture), enrichment: false });
    assert.equal(snapshot.mode, 'live');
    assert.equal(snapshot.schemaVersion, '1.0');
    assert.equal(snapshot.rootPositionUsd, null);
    assert.ok(snapshot.nodes.length > 10);
    assert.ok(snapshot.exposures.length > 1);
    assert.ok(snapshot.edges.every(edge => edge.evidence.reference && edge.evidence.sourcePath));
    assert.ok(snapshot.edges.every(edge => edge.allocationBps === undefined));
    assert.ok(snapshot.nodes.filter(node => node.address).every(node => node.id === `eip155:1:${node.address.toLowerCase()}`));
    assert.ok(snapshot.observations.some(item => item.metric === 'allocationCap'));
    assert.ok(snapshot.observations.some(item => item.metric === 'allocationAssets'));
    assert.equal(new Set(snapshot.nodes.map(node => node.id)).size, snapshot.nodes.length);
    results.push(snapshot);
  }
  assert.notEqual(results[0].rootPositionId, results[1].rootPositionId);
  assert.notDeepEqual(results[0].exposures.map(item => item.marketId), results[1].exposures.map(item => item.marketId));
});
test('captured V2 graph traverses adapter -> underlying markets', async () => {
  const capture = captures[2];
  const snapshot = await inspectVault(`1:${capture.variables.address}`, { api: mockApi(capture), enrichment: false });
  assert.equal(snapshot.protocol, 'Morpho Vault V2');
  const adapters = snapshot.edges.filter(edge => edge.from === snapshot.rootPositionId && edge.kind === 'ALLOCATES_TO');
  assert.equal(adapters.length, 1);
  assert.ok(snapshot.edges.some(edge => edge.from === adapters[0].to && edge.kind === 'ALLOCATES_TO'));
  assert.ok(snapshot.exposures.every(item => item.path.length === 3));
  assert.ok(snapshot.unknowns.some(item => item.category === 'snapshot_consistency'));
});
test('address validation rejects malformed and unsafe selectors; identities remain network-specific', () => {
  for (const input of ['0x123', '0:0x' + 'a'.repeat(40), '1:../../.env', '9007199254740992:0x' + 'a'.repeat(40)]) assert.throws(() => parseSelector(input));
  assert.equal(parseSelector('eip155:1:0x' + 'A'.repeat(40)).address, '0x' + 'a'.repeat(40));
  const a = new GraphBuilder(1, '0x' + 'a'.repeat(40));
  const b = new GraphBuilder(8453, '0x' + 'a'.repeat(40));
  assert.notEqual(a.snapshot.rootPositionId, b.snapshot.rootPositionId);
});
test('null oracle is explicit and missing allocation shape is rejected', async () => {
  const raw = structuredClone(captures[0].body.data.vaultByAddress);
  raw.state.allocation[0].market.oracle = null;
  const parsed = v1Schema.parse(raw);
  const builder = new GraphBuilder(1, parsed.address);
  await new MorphoAdapter(mockApi(captures[0])).discover(builder, parsed);
  assert.ok(builder.snapshot.unknowns.some(item => item.category === 'oracle'));
  raw.state.allocation[0].market = null;
  assert.equal(v1Schema.safeParse(raw).success, false);
  assert.equal(v2Schema.safeParse({}).success, false);
});
test('proportional loss uses deployed snapshots and refuses inconsistent or duplicated exposures', async () => {
  const snapshot = await inspectVault(`1:${captures[0].variables.address}`, { api: mockApi(captures[0]), enrichment: false });
  const exposure = snapshot.exposures[0];
  const scenario = { id: 'test', kind: 'MARKET_LOSS', targetNodeId: exposure.marketId, severityFraction: .2, horizonHours: 24 };
  const report = analyzeLive(snapshot, scenario, { positionUsd: 10000, assumedExitCostUsd: 200 });
  assert.equal(report.incident.incrementalLossIfStayingUsd, 10000 * exposure.fraction * .2);
  assert.equal(report.decision.action, 'INSUFFICIENT_EVIDENCE');
  assert.ok(report.sensitivity);
  const duplicate = structuredClone(snapshot); duplicate.exposures.push(duplicate.exposures[0]);
  assert.equal(analyzeLive(duplicate, scenario, { positionUsd: 10000 }).incident.incrementalLossIfStayingUsd, null);
  const mismatch = structuredClone(snapshot); mismatch.unknowns.push({ entityId: snapshot.rootPositionId, category: 'provider_mismatch', reason: 'test' });
  assert.equal(analyzeLive(mismatch, scenario, { positionUsd: 10000 }).incident.incrementalLossIfStayingUsd, null);
  assert.throws(() => analyzeLive(snapshot, { ...scenario, severityFraction: 2 }, { positionUsd: 10000 }));
});
test('shared oracles report unique exposure; outages and missing/stale quotes do not fabricate exits', async () => {
  const snapshot = await inspectVault(`1:${captures[0].variables.address}`, { api: mockApi(captures[0]), enrichment: false });
  const oracle = snapshot.nodes.find(node => node.kind === 'oracle');
  const oracleResult = analyzeLive(snapshot, { id: 'oracle', kind: 'ORACLE_STALE', targetNodeId: oracle.id, horizonHours: 24 }, { positionUsd: 10000 });
  assert.equal(oracleResult.incident.incrementalLossIfStayingUsd, null);
  assert.equal(oracleResult.decision.action, 'INSUFFICIENT_EVIDENCE');
  assert.ok(oracleResult.exposureUsd === null || oracleResult.exposureUsd <= 10000);
  const chain = snapshot.nodes.find(node => node.kind === 'chain');
  assert.equal(analyzeLive(snapshot, { id: 'chain', kind: 'CHAIN_OUTAGE', targetNodeId: chain.id, horizonHours: 2 }, { positionUsd: 10000 }).decision.action, 'EXIT_UNAVAILABLE');
  const market = snapshot.exposures[0];
  const scenario = { id: 'market', kind: 'MARKET_LOSS', targetNodeId: market.marketId, severityFraction: .2, horizonHours: 24, probabilityWithinHorizon: .25 };
  const exit = { feasible: true, fullExit: true, quotedAt: new Date(Date.now() - 120000).toISOString(), sourceBlock: snapshot.blockNumber, costUsd: 1, reasons: [], evidence: [] };
  assert.equal(analyzeLive(snapshot, scenario, { positionUsd: 10000, exit }).decision.action, 'INSUFFICIENT_EVIDENCE');
});
test('cycles terminate and traversal budgets are reported', () => {
  const evidence = { status: 'verified', sourceType: 'fixture', reference: 'adversarial test', observedAt: new Date().toISOString() };
  const graph = { rootPositionId: 'root', edges: [{ from: 'root', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }] };
  assert.deepEqual(traceAffectedPaths(graph, 'b'), { paths: [['b', 'a', 'root']], truncated: false });
  const edges = Array.from({ length: 25 }, (_, index) => ({ id: String(index), from: index === 0 ? 'root' : String(index - 1), to: String(index), kind: 'USES_CONTRACT', evidence }));
  assert.equal(traceAffectedPaths({ rootPositionId: 'root', edges }, '24').truncated, true);
  assert.ok(validateSnapshot({ rootPositionId: 'root', rootPositionUsd: 0, nodes: [{ id: 'root' }], edges: [{ id: 'missing', from: 'root', to: 'root' }] }).some(item => item.includes('evidence')));
});
test('provider timeouts, rate limits, malformed JSON and caching are explicit', async () => {
  const limited = new JsonClient(async () => new Response('', { status: 429, headers: { 'retry-after': '600' } }));
  await assert.rejects(() => limited.request('https://api.morpho.org/test'), error => error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 600);
  await assert.rejects(() => new JsonClient(async () => { throw new Error('secret RPC URL'); }).request('https://api.morpho.org/test'), error => error.message === 'PROVIDER_TIMEOUT_OR_UNAVAILABLE');
  await assert.rejects(() => new JsonClient(async () => new Response('not json')).request('https://api.morpho.org/test'), error => error.code === 'INVALID_PROVIDER_JSON');
  let requests = 0;
  const cached = new JsonClient(async () => { requests++; return Response.json({ data: 1 }); });
  await Promise.all(Array.from({ length: 10 }, () => cached.request('https://api.morpho.org/test')));
  assert.equal(requests, 1);
});
test('RPC configuration mismatches mark edge evidence unresolved', async () => {
  const capture = captures[0];
  const rpc = {
    anchor: async number => ({ number, hash: '0x' + '1'.repeat(64), timestamp: new Date().toISOString() }), sameBlock: async () => true,
    read: async (address, signature) => {
      if (signature.includes('asset()')) return '0x' + 'b'.repeat(40);
      throw new Error('mock unavailable');
    }
  };
  const snapshot = await inspectVault(`1:${capture.variables.address}`, { api: mockApi(capture), rpc, enrichment: false });
  assert.ok(snapshot.unknowns.some(item => item.category === 'provider_mismatch'));
  assert.ok(snapshot.edges.some(edge => edge.kind === 'ACCOUNTING_ASSET' && edge.evidence.status === 'unresolved'));
});

test('optional real-network smoke test', { skip: process.env.RUN_LIVE !== '1' }, async () => {
  const snapshot = await inspectVault(`1:${captures[0].variables.address}`, { enrichment: false });
  assert.equal(snapshot.mode, 'live');
  assert.ok(snapshot.edges.length > 20);
});
