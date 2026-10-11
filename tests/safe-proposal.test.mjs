import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSafeProposal } from '../dist/automation/proposal.js';
import { ETHEREUM_BUNDLER3, ETHEREUM_GENERAL_ADAPTER1, batchChecksum } from '../dist/automation/safe-batch.js';

const safe = '0x' + '5'.repeat(40), source = '0x' + 'a'.repeat(40), destination = '0x' + 'b'.repeat(40), usdc = '0x' + 'c'.repeat(40);
const owners = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40), '0x' + '3'.repeat(40)];
function rpc(overrides = {}) {
  const values = {
    [`${safe}|getThreshold`]: 2n, [`${safe}|getOwners`]: owners, [`${safe}|VERSION`]: '1.4.1', [`${safe}|nonce`]: 7n,
    [`${ETHEREUM_GENERAL_ADAPTER1.toLowerCase()}|BUNDLER3`]: ETHEREUM_BUNDLER3,
    [`${source}|asset`]: usdc, [`${destination}|asset`]: usdc, [`${source}|balanceOf`]: 10n * 10n ** 18n,
    [`${source}|allowance`]: 0n, [`${source}|previewRedeem`]: 11_435_000n, [`${destination}|previewDeposit`]: 10n * 10n ** 18n,
    [`${usdc}|decimals`]: 6, [`${usdc}|symbol`]: 'USDC', ...overrides.values
  };
  const codes = { [safe]: '0x60', [source]: '0x60', [destination]: '0x60', [ETHEREUM_BUNDLER3.toLowerCase()]: '0x60', [ETHEREUM_GENERAL_ADAPTER1.toLowerCase()]: '0x60', ...overrides.codes };
  const reads = [];
  return { reads,
    anchor: async () => ({ number: '26167600', hash: '0x' + 'f'.repeat(64), timestamp: '2026-10-11T07:05:00.000Z' }),
    sameBlock: overrides.sameBlock ?? (async () => true),
    code: async address => codes[address.toLowerCase()] ?? '0x',
    storage: async () => '0x',
    read: async (address, signature, args, block) => {
      reads.push({ address, signature, block });
      const key = `${address.toLowerCase()}|${signature.split('(')[0].replace('function ', '')}`;
      if (!(key in values)) throw new Error('execution reverted');
      return values[key];
    }
  };
}
const base = { chainId: 1, source, destination, safe, now: 1791702300000 };

test('a verified Safe gets an unsigned batch sized from the policy plan, with every read at one block', async () => {
  const reader = rpc();
  const plan = { sourceId: `eip155:1:${source}`, candidates: [{ destinationId: `eip155:1:${destination}`, status: 'POLICY_CANDIDATE', moveFraction: 0.18 }] };
  const p = await prepareSafeProposal({ ...base, rpc: reader, plan });
  assert.equal(p.status, 'READY_FOR_SIMULATION');
  assert.equal(p.mode, 'unsigned_read_only');
  assert.equal(p.sizing.shares, String(18n * 10n ** 17n));
  assert.equal(p.sizing.linkedToPolicyPlan, true);
  assert.deepEqual(p.safe, { address: safe, threshold: '2', owners, version: '1.4.1', nonce: '7' });
  assert.ok(reader.reads.every(r => r.block === '26167600'));
  assert.equal(p.batch.transactions.length, 3);
  assert.equal(p.batch.meta.checksum, batchChecksum(p.batch));
  assert.equal(p.batch.meta.createdFromSafeAddress, safe);
});

test('explicit shares are used as given and stay within the balance', async () => {
  const p = await prepareSafeProposal({ ...base, rpc: rpc(), shares: '1000' });
  assert.equal(p.sizing.shares, '1000'); assert.equal(p.sizing.moveFraction, null);
  await assert.rejects(() => prepareSafeProposal({ ...base, rpc: rpc(), shares: String(11n * 10n ** 18n) }), /INSUFFICIENT_SHARES/);
  await assert.rejects(() => prepareSafeProposal({ ...base, rpc: rpc(), shares: '0' }), /INSUFFICIENT_SHARES/);
});

test('EOA owners and contracts that are not Safes are refused in v1', async () => {
  await assert.rejects(() => prepareSafeProposal({ ...base, rpc: rpc({ codes: { [safe]: '0x' } }), shares: '1' }), /OWNER_IS_NOT_A_CONTRACT/);
  await assert.rejects(() => prepareSafeProposal({ ...base, rpc: rpc({ values: { [`${safe}|getThreshold`]: undefined } }), shares: '1' }), /OWNER_IS_NOT_A_SAFE/);
  await assert.rejects(() => prepareSafeProposal({ ...base, rpc: rpc({ values: { [`${safe}|getThreshold`]: 4n } }), shares: '1' }), /OWNER_IS_NOT_A_SAFE/);
});

test('route, asset, plan, size and reorg problems are refused before any batch exists', async () => {
  const cases = [
    [{ rpc: rpc({ values: { [`${ETHEREUM_GENERAL_ADAPTER1.toLowerCase()}|BUNDLER3`]: '0x' + '9'.repeat(40) } }), shares: '1' }, /BUNDLER3_ROUTE_NOT_VERIFIED/],
    [{ rpc: rpc({ values: { [`${destination}|asset`]: '0x' + 'd'.repeat(40) } }), shares: '1' }, /UNDERLYING_ASSET_MISMATCH/],
    [{ rpc: rpc({ codes: { [destination]: '0x' } }), shares: '1' }, /VAULT_HAS_NO_CODE/],
    [{ rpc: rpc(), plan: { sourceId: `eip155:1:${source}`, candidates: [{ destinationId: `eip155:1:${destination}`, status: 'LIMITS_UNACHIEVABLE', moveFraction: null }] } }, /DESTINATION_NOT_PROPOSED/],
    [{ rpc: rpc(), plan: { sourceId: `eip155:1:${destination}`, candidates: [] } }, /PLAN_SOURCE_MISMATCH/],
    [{ rpc: rpc() }, /SIZE_REQUIRED/],
    [{ rpc: rpc(), shares: '1', moveFraction: 0.5 }, /AMBIGUOUS_SIZE/],
    [{ rpc: rpc(), moveFraction: 1.5 }, /INVALID_MOVE_FRACTION/],
    [{ rpc: rpc(), shares: '1', destination: source }, /SOURCE_EQUALS_DESTINATION/],
    [{ rpc: rpc(), shares: '1', chainId: 8453 }, /UNSUPPORTED_CHAIN/],
    [{ rpc: rpc({ values: { [`${source}|previewRedeem`]: 0n } }), shares: '1' }, /ZERO_PREVIEW/],
    [{ rpc: rpc({ sameBlock: async () => false }), shares: '1' }, /ANCHOR_REORGED/]
  ];
  for (const [patch, error] of cases) await assert.rejects(() => prepareSafeProposal({ ...base, ...patch }), error);
});

// Opt-in: real Safe holder of Steakhouse USDC → Gauntlet USDC Prime, simulated on a private Anvil fork.
test('live: a real Safe position yields a fork-verified, importable batch', { skip: process.env.LIVE !== '1' && process.env.RUN_LIVE !== '1' }, async () => {
  const { runSafeProposal } = await import('../scripts/propose.mjs');
  const result = await runSafeProposal({ source: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB', destination: '0xdd0f28e19C1780eb6396170735D45153D261490d', safe: '0xADb2E162935B10A2580bC88C2622e7632B2789d5', moveFraction: 0.01 });
  assert.equal(result.proposal.simulation.status, 'SIMULATION_PASSED', JSON.stringify(result.proposal.simulation));
  assert.ok(Object.values(result.proposal.simulation.checks).every(Boolean));
  assert.equal(result.batch.meta.checksum, batchChecksum(result.batch));
});
