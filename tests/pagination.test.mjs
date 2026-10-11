import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MorphoClient } from '../dist/connectors/morpho.js';
import { JsonClient } from '../dist/connectors/http.js';
import { GraphBuilder } from '../dist/live/builder.js';
import { MorphoAdapter } from '../dist/adapters/morpho.js';
import { analyzeLive } from '../dist/live/analyze.js';

// Synthetic page splits derived from an attributed real response; never used by the live connector.
const capture = JSON.parse(readFileSync(new URL('../fixtures/upstream/morpho-v2-04422053.json', import.meta.url))).body.data.vaultV2ByAddress;
function dataset(counts = [37]) {
  const vault = structuredClone(capture);
  vault.adapters.items = counts.map((count, i) => {
    const adapter = structuredClone(capture.adapters.items[0]);
    adapter.address = '0x' + (i + 1).toString(16).padStart(40, '0');
    adapter.positions.items = Array.from({ length: count }, (_, j) => {
      const position = structuredClone(capture.adapters.items[0].positions.items[0]);
      position.market.marketId = '0x' + (i * 1000 + j + 1).toString(16).padStart(64, '0');
      return position;
    });
    adapter.positions.pageInfo = { count, countTotal: count };
    return adapter;
  });
  vault.adapters.pageInfo = { count: counts.length, countTotal: counts.length };
  return vault;
}
function mock(vault, mutate = () => {}) {
  const calls = [];
  const api = new MorphoClient(new JsonClient(async (url, init) => {
    const { variables } = JSON.parse(init.body);
    calls.push(variables);
    const adapterSkip = variables.adapterSkip ?? 0, positionSkip = variables.positionSkip ?? 0;
    const page = structuredClone(vault);
    page.adapters.items = page.adapters.items.slice(adapterSkip, adapterSkip + 20);
    page.adapters.pageInfo.count = page.adapters.items.length;
    for (const adapter of page.adapters.items) {
      adapter.positions.items = adapter.positions.items.slice(positionSkip, positionSkip + 20);
      adapter.positions.pageInfo.count = adapter.positions.items.length;
    }
    mutate(page, variables);
    return Response.json({ data: { vaultV2ByAddress: page } });
  }));
  return { api, calls };
}
test('V2 retrieves all 37 positions and preserves mixed adapter lengths with two batch requests', async () => {
  const vault = dataset([37, 10]); const { api, calls } = mock(vault);
  const result = await api.vault(1, vault.address, 2);
  assert.equal(result.adapters.items[0].positions.items.length, 37);
  assert.equal(result.adapters.items[1].positions.items.length, 10);
  assert.equal(result.adapters.items[0].positions.pageInfo.count, 37);
  assert.equal(result.paginationIssues, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].positionSkip, 20);
});
test('V2 paginates adapter lists independently of position pages', async () => {
  const vault = dataset(Array(21).fill(2)); const { api, calls } = mock(vault);
  const result = await api.vault(1, vault.address, 2);
  assert.equal(result.adapters.items.length, 21);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].adapterSkip, 20);
  assert.equal(new Set(result.adapters.items.map(a => a.address)).size, 21);
});
test('duplicate, shifting, empty and unavailable pages preserve incomplete data and block loss estimates', async () => {
  const vault = dataset();
  for (const mutation of [
    (page, vars) => { if (vars.positionSkip) page.adapters.items[0].positions.items[0] = structuredClone(vault.adapters.items[0].positions.items[0]); },
    (page, vars) => { if (vars.positionSkip) page.adapters.items[0].positions.pageInfo.countTotal++; },
    (page, vars) => { if (vars.positionSkip) page.adapters.items[0].positions.items = []; },
    (page, vars) => { if (vars.positionSkip) throw new Error('secret endpoint must not leak'); }
  ]) {
    const { api } = mock(vault, mutation);
    const result = await api.vault(1, vault.address, 2);
    assert.equal(result.adapters.items[0].positions.items.length, 20);
    assert.equal(result.adapters.items[0].positions.pageInfo.countTotal, 37);
    assert.ok(result.paginationIssues?.length);
    assert.equal(JSON.stringify(result).includes('secret endpoint'), false);
    const builder = new GraphBuilder(1, vault.address);
    await new MorphoAdapter(api).discover(builder, result);
    const graph = builder.finish();
    assert.ok(graph.unknowns.some(u => u.category === 'traversal'));
    const report = analyzeLive(graph, { id: 'partial', kind: 'MARKET_LOSS', targetNodeId: graph.exposures[0].marketId, severityFraction: .2, horizonHours: 24 }, { positionUsd: 10000 });
    assert.equal(report.incident.incrementalLossIfStayingUsd, null);
  }
});
test('pagination has explicit adapter and position budgets', async () => {
  for (const vault of [dataset([201]), dataset(Array(33).fill(1))]) {
    const { api, calls } = mock(vault);
    const result = await api.vault(1, vault.address, 2);
    assert.match(result.paginationIssues[0], /budget/);
    assert.equal(calls.length, 1);
  }
});
