import { encodeFunctionData, keccak256, maxUint256, parseAbi, stringToHex, zeroHash } from 'viem';

// Entry points from https://docs.morpho.org/developers/contracts/addresses/ (Ethereum), checked on-chain
// 2026-10-11: code present, EthereumGeneralAdapter1.BUNDLER3() == Bundler3, MORPHO() == Morpho Blue.
export const ETHEREUM_BUNDLER3 = '0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245';
export const ETHEREUM_GENERAL_ADAPTER1 = '0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0';

// Signatures from morpho-org/bundler3 src/interfaces/IBundler3.sol and src/adapters/GeneralAdapter1.sol.
export const bundlerAbi = parseAbi([
  'struct Call { address to; bytes data; uint256 value; bool skipRevert; bytes32 callbackHash; }',
  'function multicall(Call[] bundle) payable'
]);
export const adapterAbi = parseAbi([
  'function erc4626Redeem(address vault, uint256 shares, uint256 minSharePriceE27, address receiver, address owner)',
  'function erc4626Deposit(address vault, uint256 assets, uint256 maxSharePriceE27, address receiver)'
]);
export const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

const E27 = 10n ** 27n;
const isAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface PriceBoundsInput { shares: bigint; previewAssets: bigint; previewDepositShares: bigint; toleranceBps: number; }
/** Share-price floors in GeneralAdapter1 units: underlying raw units per share raw unit, scaled by 1e27. */
export function sharePriceBounds({ shares, previewAssets, previewDepositShares, toleranceBps }: PriceBoundsInput) {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > 500) throw new Error('INVALID_TOLERANCE');
  if (shares <= 0n || previewAssets <= 0n || previewDepositShares <= 0n) throw new Error('ZERO_PREVIEW');
  const tol = BigInt(toleranceBps);
  // Redeem check is assets.rDivDown(shares) >= min: round the floor down, then widen it by the tolerance.
  const minRedeemPriceE27 = previewAssets * E27 / shares * (10000n - tol) / 10000n;
  // Deposit check is assets.rDivUp(shares) <= max: round the ceiling up, then widen it by the tolerance.
  const depositPrice = (previewAssets * E27 + previewDepositShares - 1n) / previewDepositShares;
  const maxDepositPriceE27 = (depositPrice * (10000n + tol) + 9999n) / 10000n;
  if (minRedeemPriceE27 <= 0n) throw new Error('PRICE_BOUND_UNDERFLOW');
  return { minRedeemPriceE27, maxDepositPriceE27 };
}

export interface MigrationCallsInput {
  chainId: number; safe: string; source: string; destination: string; shares: bigint;
  minRedeemPriceE27: bigint; maxDepositPriceE27: bigint;
  bundler3?: string; adapter?: string;
}
export interface SafeCall { to: string; value: '0'; data: `0x${string}`; label: string; }
/** Three calls for one atomic Safe MultiSend batch. Shares always return to the Safe; nothing else is callable. */
export function buildMigrationCalls(input: MigrationCallsInput): SafeCall[] {
  const { chainId, safe, source, destination, shares, minRedeemPriceE27, maxDepositPriceE27 } = input;
  const bundler3 = input.bundler3 ?? ETHEREUM_BUNDLER3, adapter = input.adapter ?? ETHEREUM_GENERAL_ADAPTER1;
  if (chainId !== 1) throw new Error('UNSUPPORTED_CHAIN');
  if (![safe, source, destination, bundler3, adapter].every(isAddress)) throw new Error('INVALID_ADDRESS');
  if (same(source, destination)) throw new Error('SOURCE_EQUALS_DESTINATION');
  if ([source, destination].some(vault => same(vault, safe) || same(vault, adapter) || same(vault, bundler3))) throw new Error('INVALID_VAULT_ROLE');
  if (shares <= 0n || shares >= maxUint256) throw new Error('INVALID_SHARES');
  if (minRedeemPriceE27 <= 0n || maxDepositPriceE27 <= 0n) throw new Error('INVALID_PRICE_BOUND');
  const call = (data: `0x${string}`) => ({ to: adapter as `0x${string}`, data, value: 0n, skipRevert: false, callbackHash: zeroHash });
  const redeem = encodeFunctionData({ abi: adapterAbi, functionName: 'erc4626Redeem', args: [source as `0x${string}`, shares, minRedeemPriceE27, adapter as `0x${string}`, safe as `0x${string}`] });
  const deposit = encodeFunctionData({ abi: adapterAbi, functionName: 'erc4626Deposit', args: [destination as `0x${string}`, maxUint256, maxDepositPriceE27, safe as `0x${string}`] });
  return [
    { to: source, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [adapter as `0x${string}`, shares] }), label: 'Allow GeneralAdapter1 to redeem exactly these source shares' },
    { to: bundler3, value: '0', data: encodeFunctionData({ abi: bundlerAbi, functionName: 'multicall', args: [[call(redeem), call(deposit)]] }), label: 'Redeem source shares to the adapter, then deposit everything received into the destination for the Safe' },
    { to: source, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [adapter as `0x${string}`, 0n] }), label: 'Reset the adapter share allowance to zero' }
  ];
}

// Reproduces apps/tx-builder/src/lib/checksum.ts (safe-global/safe-react-apps): sorted keys, undefined → null.
const replacer = (_: string, value: unknown) => (value === undefined ? null : value);
export function serializeForChecksum(json: unknown): string {
  if (Array.isArray(json)) return `[${json.map(serializeForChecksum).join(',')}]`;
  if (typeof json === 'object' && json !== null) {
    const record = json as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    let acc = `{${JSON.stringify(keys, replacer)}`;
    for (const key of keys) acc += `${serializeForChecksum(record[key])},`;
    return `${acc}}`;
  }
  return `${JSON.stringify(json, replacer)}`;
}

export interface BatchFile {
  version: '1.0'; chainId: string; createdAt: number;
  meta: { name: string; description: string; createdFromSafeAddress: string; checksum?: string };
  transactions: { to: string; value: string; data: string }[];
}
export function batchChecksum(batch: BatchFile) {
  const { checksum: _ignored, ...meta } = batch.meta;
  return keccak256(stringToHex(serializeForChecksum({ ...batch, meta: { ...meta, name: null } })));
}
/** Transaction Builder import file. Unsigned; the Safe's own signers review and execute it. */
export function buildBatchFile(input: { chainId: number; safe: string; calls: SafeCall[]; name: string; description: string; createdAt: number }): BatchFile {
  if (!isAddress(input.safe) || !input.calls.length) throw new Error('INVALID_BATCH');
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) throw new Error('INVALID_CREATED_AT');
  const batch: BatchFile = {
    version: '1.0', chainId: String(input.chainId), createdAt: input.createdAt,
    meta: { name: input.name.slice(0, 120), description: input.description.slice(0, 2000), createdFromSafeAddress: input.safe },
    transactions: input.calls.map(({ to, value, data }) => ({ to, value, data }))
  };
  return { ...batch, meta: { ...batch.meta, checksum: batchChecksum(batch) } };
}
