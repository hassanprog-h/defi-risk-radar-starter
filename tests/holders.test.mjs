import test from 'node:test';
import assert from 'node:assert/strict';
import { findPublicHolder } from '../dist/live/holders.js';
const addr = n => `0x${String(n).padStart(40, '0')}`;
const vault = addr(1), asset = addr(2), tiny = addr(3), large = addr(4);
const snapshot = { rootPositionId: 'root', mode: 'live', protocol: 'Morpho Vault V1', chainId: 1, nodes: [{ id: 'root', address: vault }] };
const api = { holders: async () => [{ owner: tiny, shares: '1' }, { owner: large, shares: '200000000000' }], base: 'https://api.morpho.org', http: { request: async () => ({ data: { assetByAddress: { price: { usd: 1, timestamp: String(Math.floor(Date.now() / 1000)) } } } }) } };
const rpc = { anchor: async () => ({ number: '100', hash: 'hash' }), sameBlock: async () => true, code: async () => '0x',
  read: async (_address, signature, args) => {
    if (signature.includes('balanceOf')) return args[0] === large ? 200000000000n : 1n;
    if (signature.includes('asset()')) return asset;
    if (signature.includes('decimals')) return 6n;
    if (signature.includes('previewWithdraw')) return args[0];
    throw new Error('UNEXPECTED_READ');
  } };
test('public-holder sizing rejects dust and verifies enough real shares for the entered amount', async () => {
  const holder = await findPublicHolder(snapshot, rpc, api, 100000);
  assert.equal(holder.owner, large);
  assert.equal(holder.sourceVault, vault);
  assert.equal(holder.requestedPositionUsd, 100000);
  assert.equal(holder.minimumShares, '100020000000');
  await assert.rejects(findPublicHolder(snapshot, rpc, api, 300000), /NO_SUITABLE_PUBLIC_HOLDER/);
});
test('indexed shares cannot replace actual balances; contract owners and stale sizing prices are rejected', async () => {
  await assert.rejects(findPublicHolder(snapshot, { ...rpc, read: async (a, s, args) => s.includes('balanceOf') ? 1n : rpc.read(a, s, args) }, api, 100000), /NO_SUITABLE_PUBLIC_HOLDER/);
  await assert.rejects(findPublicHolder(snapshot, { ...rpc, code: async () => '0x1234' }, api, 100000), /NO_SUITABLE_PUBLIC_HOLDER/);
  const stale = { ...api, http: { request: async () => ({ data: { assetByAddress: { price: { usd: 1, timestamp: '1' } } } }) } };
  await assert.rejects(findPublicHolder(snapshot, rpc, stale, 100000), /FRESH_PRICE/);
});
