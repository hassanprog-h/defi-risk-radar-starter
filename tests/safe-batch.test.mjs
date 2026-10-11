import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256, maxUint256, stringToHex, zeroHash } from 'viem';
import { ETHEREUM_BUNDLER3, ETHEREUM_GENERAL_ADAPTER1, adapterAbi, batchChecksum, bundlerAbi, buildBatchFile, buildMigrationCalls, erc20Abi, serializeForChecksum, sharePriceBounds } from '../dist/automation/safe-batch.js';

const safe = '0x' + '5'.repeat(40), source = '0x' + 'a'.repeat(40), destination = '0x' + 'b'.repeat(40);
const input = { chainId: 1, safe, source, destination, shares: 10n ** 18n, minRedeemPriceE27: 10n ** 15n, maxDepositPriceE27: 2n * 10n ** 15n };

test('three calls: exact approval, Bundler3 redeem+deposit for the Safe, allowance reset', () => {
  const [approve, multicall, reset] = buildMigrationCalls(input);
  assert.equal(approve.to, source); assert.equal(reset.to, source); assert.equal(multicall.to, ETHEREUM_BUNDLER3);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args, [ETHEREUM_GENERAL_ADAPTER1, 10n ** 18n]);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: reset.data }).args, [ETHEREUM_GENERAL_ADAPTER1, 0n]);
  const [bundle] = decodeFunctionData({ abi: bundlerAbi, data: multicall.data }).args;
  assert.equal(bundle.length, 2);
  for (const call of bundle) {
    assert.equal(call.to, ETHEREUM_GENERAL_ADAPTER1); assert.equal(call.value, 0n);
    assert.equal(call.skipRevert, false); assert.equal(call.callbackHash, zeroHash);
  }
  const redeem = decodeFunctionData({ abi: adapterAbi, data: bundle[0].data });
  assert.equal(redeem.functionName, 'erc4626Redeem');
  assert.deepEqual(redeem.args.map(v => String(v).toLowerCase()), [source, String(10n ** 18n), String(10n ** 15n), ETHEREUM_GENERAL_ADAPTER1.toLowerCase(), safe]);
  const deposit = decodeFunctionData({ abi: adapterAbi, data: bundle[1].data });
  assert.equal(deposit.functionName, 'erc4626Deposit');
  assert.deepEqual(deposit.args.map(v => String(v).toLowerCase()), [destination, String(maxUint256), String(2n * 10n ** 15n), safe]);
});

test('function selectors match the published Bundler3, adapter and ERC-20 signatures', () => {
  const selector = signature => keccak256(stringToHex(signature)).slice(0, 10);
  const [approve, multicall] = buildMigrationCalls(input);
  assert.equal(approve.data.slice(0, 10), selector('approve(address,uint256)'));
  assert.equal(multicall.data.slice(0, 10), selector('multicall((address,bytes,uint256,bool,bytes32)[])'));
  const [bundle] = decodeFunctionData({ abi: bundlerAbi, data: multicall.data }).args;
  assert.equal(bundle[0].data.slice(0, 10), selector('erc4626Redeem(address,uint256,uint256,address,address)'));
  assert.equal(bundle[1].data.slice(0, 10), selector('erc4626Deposit(address,uint256,uint256,address)'));
});

test('price bounds round in the protective direction and widen by the tolerance only', () => {
  // 1 share (18 dp) previews 1.143500 USDC (6 dp); depositing it previews 0.95e18 destination shares.
  const exact = sharePriceBounds({ shares: 10n ** 18n, previewAssets: 1_143_500n, previewDepositShares: 95n * 10n ** 16n, toleranceBps: 0 });
  assert.equal(exact.minRedeemPriceE27, 1_143_500n * 10n ** 9n);
  assert.equal(exact.maxDepositPriceE27, (1_143_500n * 10n ** 27n + 95n * 10n ** 16n - 1n) / (95n * 10n ** 16n));
  const loose = sharePriceBounds({ shares: 10n ** 18n, previewAssets: 1_143_500n, previewDepositShares: 95n * 10n ** 16n, toleranceBps: 50 });
  assert.equal(loose.minRedeemPriceE27, exact.minRedeemPriceE27 * 9950n / 10000n);
  assert.ok(loose.maxDepositPriceE27 > exact.maxDepositPriceE27);
  assert.throws(() => sharePriceBounds({ shares: 1n, previewAssets: 1n, previewDepositShares: 1n, toleranceBps: 501 }), /INVALID_TOLERANCE/);
  assert.throws(() => sharePriceBounds({ shares: 1n, previewAssets: 0n, previewDepositShares: 1n, toleranceBps: 50 }), /ZERO_PREVIEW/);
});

test('unsafe or ambiguous inputs are refused', () => {
  for (const [patch, error] of [
    [{ chainId: 8453 }, /UNSUPPORTED_CHAIN/], [{ destination: source }, /SOURCE_EQUALS_DESTINATION/],
    [{ safe: '0x123' }, /INVALID_ADDRESS/], [{ shares: 0n }, /INVALID_SHARES/], [{ shares: maxUint256 }, /INVALID_SHARES/],
    [{ destination: safe }, /INVALID_VAULT_ROLE/], [{ source: ETHEREUM_GENERAL_ADAPTER1 }, /INVALID_VAULT_ROLE/],
    [{ minRedeemPriceE27: 0n }, /INVALID_PRICE_BOUND/]
  ]) assert.throws(() => buildMigrationCalls({ ...input, ...patch }), error);
});

test('checksum follows the Transaction Builder serialization: sorted keys, name excluded, content bound', () => {
  assert.equal(serializeForChecksum({ b: 1, a: [true, null, 'x'] }), '{["a","b"][true,null,"x"],1,}');
  const batch = buildBatchFile({ chainId: 1, safe, calls: buildMigrationCalls(input), name: 'Radar migration', description: 'test', createdAt: 1791700000000 });
  assert.equal(batch.version, '1.0'); assert.equal(batch.chainId, '1');
  assert.equal(batch.transactions.length, 3);
  assert.ok(batch.transactions.every(tx => tx.value === '0' && /^0x[0-9a-f]+$/.test(tx.data)));
  assert.equal(batch.meta.checksum, batchChecksum(batch));
  assert.equal(batchChecksum({ ...batch, meta: { ...batch.meta, name: 'Renamed' } }), batch.meta.checksum);
  const tampered = structuredClone(batch); tampered.transactions[0].to = destination;
  assert.notEqual(batchChecksum(tampered), batch.meta.checksum);
  const expected = keccak256(stringToHex(serializeForChecksum({ ...batch, meta: { createdFromSafeAddress: safe, description: 'test', name: null } })));
  assert.equal(batch.meta.checksum, expected);
});
