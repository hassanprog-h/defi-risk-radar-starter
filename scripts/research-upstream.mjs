import { writeFile, mkdir } from 'node:fs/promises';
import { v1Query, v2Query } from '../dist/connectors/queries.js';

const base = 'https://api.morpho.org';
const response = await fetch(`${base}/graphql`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: '{ __schema { types { name kind fields { name type { kind name ofType { kind name ofType { kind name ofType {kind name} } } } } } } }' }),
  signal: AbortSignal.timeout(20000)
});
const schema = await response.json();
await writeFile('/tmp/morpho-schema.json', JSON.stringify(schema, null, 2));
for (const type of schema.data?.__schema?.types ?? []) {
  if (['Vault', 'VaultState', 'VaultAllocation', 'Market', 'Oracle', 'VaultV2', 'VaultV2Adapter', 'Chain', 'MarketState', 'VaultV2AdapterAllocation'].includes(type.name)) {
    console.log(type.name, JSON.stringify(type.fields));
  }
}
const paths = [
  '/v0/vaults-v1?chain_ids=1&limit=3',
  '/v0/vaults-v2?chain_ids=1&limit=3',
  '/v0/vaults-v1/1:0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB',
  '/v0/vaults-v1/1:0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB/state',
  '/v0/vaults-v2/1:0x04422053aDDbc9bB2759b248B574e3FCA76Bc145',
  '/v1/vaults-v2/1:0x04422053aDDbc9bB2759b248B574e3FCA76Bc145/state'
];
const captures = [];
for (const path of paths) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  const body = await r.json();
  captures.push({ source: base + path, retrievedAt: new Date().toISOString(), status: r.status, body });
  console.log(path, r.status, JSON.stringify(body).slice(0, 5000));
}
await mkdir('fixtures/upstream', { recursive: true });
await writeFile('fixtures/upstream/morpho-rest.json', JSON.stringify(captures, null, 2));
for (const [version, address] of [[1, '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB'], [1, '0x2371e134e3455e0593363cBF89d3b6cf53740618'], [2, '0x04422053aDDbc9bB2759b248B574e3FCA76Bc145']]) {
  const r = await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: version === 1 ? v1Query : v2Query, variables: { address, chainId: 1 } }), signal: AbortSignal.timeout(20000) });
  const body = await r.json();
  await writeFile(`fixtures/upstream/morpho-v${version}-${address.slice(2, 10).toLowerCase()}.json`, JSON.stringify({ source: base + '/graphql', query: version === 1 ? v1Query : v2Query, variables: { address, chainId: 1 }, retrievedAt: new Date().toISOString(), body }, null, 2));
  console.log('GraphQL', version, address, body.errors ?? { fields: Object.keys(body.data ?? {}) });
}
