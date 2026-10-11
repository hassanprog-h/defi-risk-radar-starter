import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PendleClient } from '../dist/connectors/pendle.js';
import { JsonClient } from '../dist/connectors/http.js';
import { discoverPendleVenues } from '../dist/adapters/pendle.js';
import { GraphBuilder } from '../dist/live/builder.js';

const capture = JSON.parse(readFileSync(new URL('../fixtures/upstream/pendle-markets-page.json', import.meta.url)));
const observed = capture.body.results[0];
const page = { ...capture.body, total: 1, results: [observed] };
const pt = observed.pt.split('-')[1], sy = observed.sy.split('-')[1], yt = observed.yt.split('-')[1];
const vault = '0x' + '1'.repeat(40);
function builder() {
  const b = new GraphBuilder(1, vault); b.address(vault, 'vault', 'Test vault'); b.node('eip155:1', 'chain', 'Ethereum'); b.address(pt, 'asset', 'PT-' + observed.name); return b;
}
function api(body = page) { return new PendleClient(new JsonClient(async () => Response.json(body))); }
const rpc = { read: async (address, signature) => signature.includes('readTokens') ? [sy, pt, yt] : sy };
test('Pendle venue association is corroborated without inventing an oracle dependency or exit quote', async () => {
  const b = builder(); await discoverPendleVenues(b, rpc, api());
  const s = b.finish();
  const association = s.edges.find(edge => edge.kind === 'TRADED_ON');
  assert.equal(association.evidence.sourceType, 'onchain_call');
  assert.ok(association.corroboration.some(e => e.reference.includes('/v2/markets/all')));
  assert.ok(s.edges.some(edge => edge.kind === 'CLAIM_ON'));
  assert.equal(s.edges.some(edge => edge.kind === 'USES_ORACLE'), false);
  assert.equal(s.edges.some(edge => edge.kind === 'EXITS_THROUGH'), false);
  assert.ok(s.unknowns.some(item => item.category === 'exit'));
});
test('venue token mismatch prevents upgrading indexed evidence and principal claims', async () => {
  const b = builder(); await discoverPendleVenues(b, { read: async () => [sy, vault, yt] }, api());
  assert.equal(b.finish().edges.find(edge => edge.kind === 'TRADED_ON').evidence.status, 'unresolved');
  assert.equal(b.finish().edges.some(edge => edge.kind === 'CLAIM_ON'), false);
});
test('directory paging follows documented offsets and bounds total discovery', async () => {
  const urls = [];
  const client = new PendleClient(new JsonClient(async url => {
    urls.push(url); const skip = Number(new URL(url).searchParams.get('skip'));
    return Response.json({ ...page, skip, total: 150, results: Array.from({ length: skip === 0 ? 100 : 50 }, (_, index) => ({ ...observed, address: '0x' + BigInt(index + skip + 1).toString(16).padStart(40, '0') })) });
  }));
  const result = await client.markets(1); assert.equal(result.records.length, 150); assert.equal(result.incomplete, false); assert.equal(urls.length, 2);
  assert.ok(urls[1].endsWith('skip=100'));
});
