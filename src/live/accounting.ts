import { addressSchema, rawInteger, type VaultV2 } from '../connectors/morpho.js';
import { GraphBuilder, evmId, fraction } from './builder.js';
import type { RpcReader, Exposure, Observation } from './types.js';
class AccountingError extends Error {}

/** Independent implementation of the documented V2 direct-market read interfaces.
 * All financial values use one block. Indexed values remain available as indexed:* observations.
 * Unknown/nested adapters, missing markets and failed reconciliation never unlock estimates.
 */
export async function pinV2Accounting(builder: GraphBuilder, rpc: RpcReader, vault: VaultV2): Promise<boolean> {
  const snapshot = builder.finish(), root = snapshot.rootPositionId, block = snapshot.blockNumber;
  if (!block) return false;
  const observations: Observation[] = [], exposures: Exposure[] = [];
  const read = (address: string, signature: string, args: readonly unknown[] = []) => rpc.read(address, signature, args, block);
  const integer = (value: unknown) => BigInt(rawInteger.parse(String(value)));
  const observe = (entityId: string, metric: string, value: Observation['value'], address: string, call: string, units: string, derived = false) => {
    observations.push({ entityId, metric, value, units, derived, evidence: builder.onchain(address, call) });
  };
  try {
    const [assetRaw, totalRaw, supplyRaw, countRaw] = await Promise.all([
      read(vault.address, 'function asset() view returns (address)'),
      read(vault.address, 'function totalAssets() view returns (uint256)'),
      read(vault.address, 'function totalSupply() view returns (uint256)'),
      read(vault.address, 'function adaptersLength() view returns (uint256)')
    ]);
    const asset = addressSchema.parse(assetRaw), total = integer(totalRaw), count = integer(countRaw);
    if (asset !== vault.asset.address || total <= 0n || count > 32n) throw new AccountingError('Vault asset, positive total assets or adapter budget could not be validated.');
    const idle = integer(await read(asset, 'function balanceOf(address) view returns (uint256)', [vault.address]));
    const addresses = await Promise.all(Array.from({ length: Number(count) }, async (_, i) => addressSchema.parse(await read(vault.address, 'function adapters(uint256) view returns (address)', [BigInt(i)]))));
    const indexed = vault.adapters.items ?? [];
    if (new Set(addresses).size !== addresses.length || new Set(indexed.map(a => a.address)).size !== indexed.length || indexed.length !== addresses.length || indexed.some(adapter => !addresses.includes(adapter.address))) throw new AccountingError('Indexed and on-chain adapter membership differ; inspect again after the indexer catches up.');
    let deployed = 0n;
    for (const adapter of indexed) {
      if (adapter.__typename !== 'MorphoMarketV1Adapter' || !adapter.positions?.items) throw new AccountingError('Pinned accounting currently supports direct Morpho market adapters; nested or unknown adapters remain unresolved.');
      const [parentRaw, adapterAssetRaw, coreRaw, lengthRaw, realRaw] = await Promise.all([
        read(adapter.address, 'function parentVault() view returns (address)'),
        read(adapter.address, 'function asset() view returns (address)'),
        read(adapter.address, 'function morpho() view returns (address)'),
        read(adapter.address, 'function marketIdsLength() view returns (uint256)'),
        read(adapter.address, 'function realAssets() view returns (uint256)')
      ]);
      if (addressSchema.parse(parentRaw) !== vault.address || addressSchema.parse(adapterAssetRaw) !== asset) throw new AccountingError('Adapter parent or accounting asset does not match the vault.');
      const core = addressSchema.parse(coreRaw), length = integer(lengthRaw), real = integer(realRaw);
      if (length > 128n) throw new AccountingError('Adapter market enumeration exceeds the accounting budget.');
      const ids = await Promise.all(Array.from({ length: Number(length) }, async (_, i) => {
        const id = await read(adapter.address, 'function marketIds(uint256) view returns (bytes32)', [BigInt(i)]);
        if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) throw new AccountingError('Invalid on-chain market identifier.');
        return id.toLowerCase();
      }));
      const positions = adapter.positions.items;
      if (new Set(ids).size !== ids.length || new Set(positions.map(p => p.market.marketId)).size !== positions.length || ids.some(id => !positions.some(p => p.market.marketId === id))) throw new AccountingError('An active on-chain market is missing or duplicated in indexed discovery; full market accounting is withheld.');
      const amounts = await Promise.all(ids.map(async id => integer(await read(adapter.address, 'function expectedSupplyAssets(bytes32) view returns (uint256)', [id]))));
      const sum = amounts.reduce((a, b) => a + b, 0n);
      if (sum !== real) throw new AccountingError('Adapter market balances do not reconcile to realAssets().');
      deployed += real;
      const aid = evmId(snapshot.chainId, adapter.address);
      const parentEdge = snapshot.edges.find(e => e.from === root && e.to === aid && e.kind === 'ALLOCATES_TO');
      if (!parentEdge) throw new AccountingError('Missing vault-to-adapter capital relationship.');
      observe(parentEdge.id, 'allocationAssets', real.toString(), adapter.address, 'realAssets()', 'raw_asset_units');
      observe(parentEdge.id, 'allocationFraction', fraction(real.toString(), total.toString()), adapter.address, 'realAssets() / vault.totalAssets()', 'fraction', true);
      for (const position of positions) {
        const market = position.market, mid = `morpho-market:${snapshot.chainId}:${market.marketId}`;
        if (market.loanAsset.address !== asset || market.morphoBlue.address !== core) throw new AccountingError('Market loan asset or Morpho core differs from the adapter.');
        const edge = snapshot.edges.find(e => e.from === aid && e.to === mid && e.kind === 'ALLOCATES_TO');
        if (!edge) throw new AccountingError('Missing adapter-to-market capital relationship.');
        const index = ids.indexOf(market.marketId), amount = index === -1 ? 0n : amounts[index]!;
        const call = index === -1 ? 'marketIds() enumeration: absent from active accounting' : `expectedSupplyAssets(${market.marketId})`;
        const evidence = builder.onchain(adapter.address, call);
        observe(edge.id, 'allocationAssets', amount.toString(), adapter.address, call, 'raw_asset_units');
        observe(edge.id, 'allocationFraction', fraction(amount.toString(), total.toString()), adapter.address, `${call} / vault.totalAssets()`, 'fraction', true);
        observe(edge.id, 'allocationActive', index !== -1, adapter.address, 'marketIds() enumeration', 'boolean');
        exposures.push({ marketId: mid, vaultId: root, assets: amount.toString(), fraction: fraction(amount.toString(), total.toString()), evidence, path: [root, aid, mid] });
      }
    }
    if (deployed + idle !== total) throw new AccountingError('Idle balance plus adapter assets differs from vault totalAssets(); accounting/rate-cap effects remain unresolved.');
    observe(root, 'totalAssets', total.toString(), vault.address, 'totalAssets()', 'raw_asset_units');
    observe(root, 'totalSupply', integer(supplyRaw).toString(), vault.address, 'totalSupply()', 'raw_share_units');
    observe(root, 'idleAssets', idle.toString(), asset, `balanceOf(${vault.address})`, 'raw_asset_units');
    observe(root, 'accountingPinned', true, vault.address, 'adapters() / marketIds() / realAssets() / totalAssets() reconciliation', 'boolean', true);
    const replaced = new Set(observations.map(o => `${o.entityId}|${o.metric}`));
    snapshot.observations = snapshot.observations.map(o => replaced.has(`${o.entityId}|${o.metric}`) ? { ...o, metric: `indexed:${o.metric}` } : o);
    snapshot.observations.push(...observations);
    snapshot.exposures = snapshot.exposures.filter(e => e.vaultId !== root).concat(exposures);
    for (const exposure of exposures) if (BigInt(exposure.assets) > 0n) {
      builder.corroborate(exposure.path[1]!, exposure.marketId, 'ALLOCATES_TO', exposure.evidence, true);
    }
    for (const address of addresses) builder.corroborate(root, evmId(snapshot.chainId, address), 'ALLOCATES_TO', builder.onchain(vault.address, 'adapters() enumeration'), true);
    snapshot.assumptions.push('V2 exposure accounting is reconciled at one RPC block for supported direct-market adapters. Indexed discovery and prices retain their separate timestamps. Inactive indexed markets have zero share in current vault accounting.');
    return true;
  } catch (error) {
    const reason = error instanceof AccountingError ? error.message : 'An accounting contract read failed, returned invalid data or exceeded its budget.';
    builder.unknown(root, 'snapshot_consistency', `Pinned V2 accounting unavailable: ${reason}`);
    return false;
  }
}
