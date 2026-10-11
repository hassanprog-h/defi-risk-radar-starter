import { encodeAbiParameters, keccak256, type Address } from 'viem';
import type { RpcReader } from '../live/types.js';

export interface ForceLeg { adapter: string; data: `0x${string}`; maxAssets: bigint; maxPenaltyWad: bigint; marketId: string; }
/** Only the corroborated Ethereum direct Morpho-market adapter; no curator powers assumed. */
export async function planForceLiquidity(rpc: RpcReader, source: string, asset: string, expectedAssets: bigint, blockNumber: string) {
  const read = (address: string, signature: string, args: readonly unknown[] = []) => rpc.read(address, signature, args, blockNumber);
  const raw = (x: unknown) => { if (!/^\d{1,78}$/.test(String(x))) throw new Error('INVALID_ROUTE_ACCOUNTING'); return BigInt(String(x)); };
  const idle = raw(await read(asset, 'function balanceOf(address) view returns(uint256)', [source]));
  const deficit = expectedAssets > idle ? expectedAssets - idle : 0n;
  if (!deficit) return { legs: [] as ForceLeg[], idleAssets: idle, deficitAssets: 0n, maximumPenaltyAssets: 0n };
  // Other ERC-4626 vaults can source liquidity inside redeem itself. Do not
  // invent a V2 force route for them; the actual redemption simulation decides.
  let liquidityAdapter: string;
  try { liquidityAdapter = String(await read(source, 'function liquidityAdapter() view returns(address)')); }
  catch { return { legs: [] as ForceLeg[], idleAssets: idle, deficitAssets: deficit, maximumPenaltyAssets: 0n }; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(liquidityAdapter)) throw new Error('INVALID_LIQUIDITY_ADAPTER');
  if (liquidityAdapter.toLowerCase() !== '0x0000000000000000000000000000000000000000') return { legs: [] as ForceLeg[], idleAssets: idle, deficitAssets: deficit, maximumPenaltyAssets: 0n };
  let count: number;
  try { count = Number(await read(source, 'function adaptersLength() view returns(uint256)')); } catch { throw new Error('NO_SUPPORTED_LIQUIDITY_ROUTE'); }
  if (!Number.isSafeInteger(count) || count < 1 || count > 4) throw new Error('LIQUIDITY_ROUTE_BUDGET');
  let remaining = deficit + (deficit / 10000n + 10n); // bounded 1bp accrual/rounding buffer, actually pulled only when needed
  const legs: ForceLeg[] = [];
  const seen = new Set<string>();
  let maximumPenaltyAssets = 0n;
  for (let a = 0; a < count && remaining > 0n; a++) {
    const adapter = String(await read(source, 'function adapters(uint256) view returns(address)', [BigInt(a)]));
    const registered = await read(source, 'function isAdapter(address) view returns(bool)', [adapter]);
    const penalty = raw(await read(source, 'function forceDeallocatePenalty(address) view returns(uint256)', [adapter]));
    if (registered !== true || penalty > 100000000000000n) throw new Error('UNAPPROVED_OR_HIGH_PENALTY_ROUTE'); // at most 1bp
    const [parent, core, adapterAsset] = await Promise.all([
      read(adapter, 'function parentVault() view returns(address)'), read(adapter, 'function morpho() view returns(address)'), read(adapter, 'function asset() view returns(address)')
    ]);
    if (String(parent).toLowerCase() !== source.toLowerCase() || String(core).toLowerCase() !== '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' || String(adapterAsset).toLowerCase() !== asset.toLowerCase()) throw new Error('UNSUPPORTED_LIQUIDITY_ADAPTER');
    const markets = Number(await read(adapter, 'function marketIdsLength() view returns(uint256)'));
    if (!Number.isSafeInteger(markets) || markets < 0 || markets > 128) throw new Error('LIQUIDITY_ROUTE_BUDGET');
    for (let i = 0; i < markets && remaining > 0n && legs.length < 4; i++) {
      const id = String(await read(adapter, 'function marketIds(uint256) view returns(bytes32)', [BigInt(i)]));
      if (!/^0x[0-9a-fA-F]{64}$/.test(id) || seen.has(id.toLowerCase())) throw new Error('DUPLICATE_OR_INVALID_ROUTE_MARKET');
      seen.add(id.toLowerCase());
      const [supplyRaw, totalsRaw, paramsRaw] = await Promise.all([
        read(adapter, 'function expectedSupplyAssets(bytes32) view returns(uint256)', [id]),
        read(String(core), 'function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)', [id]),
        read(String(core), 'function idToMarketParams(bytes32) view returns(address,address,address,address,uint256)', [id])
      ]);
      if (!Array.isArray(totalsRaw) || totalsRaw.length !== 6 || !Array.isArray(paramsRaw) || paramsRaw.length !== 5) throw new Error('INVALID_ROUTE_MARKET_STATE');
      const totals = totalsRaw.map(raw), supply = raw(supplyRaw);
      if (totals[2]! > totals[0]!) throw new Error('INVALID_ROUTE_MARKET_STATE');
      const available = totals[0]! - totals[2]!;
      // Haircut read-state availability by 1bp; the actual forceDeallocate remains the ground-truth simulation.
      const cap = (supply < available ? supply : available) * 9999n / 10000n;
      if (cap <= 0n) continue;
      const params = paramsRaw as [Address, Address, Address, Address, bigint];
      if (!params.slice(0, 4).every(p => /^0x[0-9a-fA-F]{40}$/.test(String(p))) || String(params[0]).toLowerCase() !== asset.toLowerCase()) throw new Error('ROUTE_LOAN_ASSET_MISMATCH');
      const data = encodeAbiParameters([{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }] }], [params]);
      if (keccak256(data).toLowerCase() !== id.toLowerCase()) throw new Error('ROUTE_MARKET_ID_MISMATCH');
      const maxAssets = cap < remaining ? cap : remaining;
      maximumPenaltyAssets += (maxAssets * penalty + 999999999999999999n) / 1000000000000000000n + 1n;
      legs.push({ adapter, data, maxAssets, maxPenaltyWad: penalty, marketId: id });
      remaining -= maxAssets;
    }
  }
  if (remaining > 0n) throw new Error('INSUFFICIENT_VERIFIED_MARKET_LIQUIDITY');
  return { legs, idleAssets: idle, deficitAssets: deficit, maximumPenaltyAssets };
}
