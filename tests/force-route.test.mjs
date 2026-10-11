import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, keccak256 } from 'viem';
import { planForceLiquidity } from '../dist/automation/force-route.js';
const a = n => `0x${String(n).padStart(40, '0')}`;
const source = a(1), asset = a(2), adapter = a(3), core = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const params = [asset, a(4), a(5), a(6), 800000000000000000n];
const data = encodeAbiParameters([{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }] }], [params]);
const id = keccak256(data);
function rpc(overrides = {}) {
  const values = { balanceOf: 16n, liquidityAdapter: a(0), adaptersLength: 1n, adapters: adapter, isAdapter: true, forceDeallocatePenalty: 10000000000000n,
    parentVault: source, morpho: core, asset, marketIdsLength: 1n, marketIds: id, expectedSupplyAssets: 100000n,
    market: [200000n, 200000n, 10000n, 10000n, 0n, 0n], idToMarketParams: params, ...overrides };
  return { read: async (_, signature, __, block) => {
    assert.equal(block, '100');
    const name = signature.match(/function (\w+)/)[1];
    if (values[name] instanceof Error) throw values[name];
    if (values[name] === undefined) throw new Error('UNSUPPORTED');
    return values[name];
  } };
}
test('force route uses verified supply and liquidity, encodes market params and includes nonzero fee budget', async () => {
  const route = await planForceLiquidity(rpc(), source, asset, 5000n, '100');
  assert.equal(route.deficitAssets, 4984n);
  assert.equal(route.legs.length, 1);
  assert.equal(route.legs[0].data, data);
  assert.equal(route.legs[0].marketId, id);
  assert.ok(route.maximumPenaltyAssets > 0n);
  assert.ok(route.legs[0].maxAssets >= route.deficitAssets);
});
test('missing liquidity, high penalty, alien adapter/core/asset, changed ID or duplicate markets cannot create executable routes', async () => {
  for (const overrides of [{ expectedSupplyAssets: 0n }, { forceDeallocatePenalty: 100000000000001n }, { parentVault: a(9) }, { morpho: a(9) }, { asset: a(9) },
    { idToMarketParams: [a(9), ...params.slice(1)] }, { marketIds: '0x' + '0'.repeat(64) }, { market: [1n, 1n, 2n, 2n, 0n, 0n] },
    { marketIdsLength: 2n, expectedSupplyAssets: 2000n }]) {
    await assert.rejects(() => planForceLiquidity(rpc(overrides), source, asset, 5000n, '100'));
  }
});
test('idle or default/unknown automatic liquidity paths are tested through actual redeem, not synthetic V2 routes', async () => {
  assert.equal((await planForceLiquidity(rpc({ balanceOf: 5000n }), source, asset, 5000n, '100')).legs.length, 0);
  assert.equal((await planForceLiquidity(rpc({ liquidityAdapter: a(10) }), source, asset, 5000n, '100')).legs.length, 0);
  assert.equal((await planForceLiquidity(rpc({ liquidityAdapter: new Error('not a V2') }), source, asset, 5000n, '100')).legs.length, 0);
});
