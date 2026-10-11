import { MorphoClient, type Asset, type Market, type VaultV1, type VaultV2 } from '../connectors/morpho.js';
import { GraphBuilder, evmId, ZERO, fraction } from '../live/builder.js';
import type { Evidence } from '../core/types.js';

const time = (value: string) => new Date(Number(value) * 1000).toISOString();
export interface ProtocolAdapter {
  readonly name: string;
  discover(builder: GraphBuilder, vault: VaultV1 | VaultV2): Promise<void>;
}

export class MorphoAdapter implements ProtocolAdapter {
  readonly name = 'Morpho Vault V1 / V2';
  private visited = new Set<string>();
  constructor(private readonly api: MorphoClient, private readonly maxDepth = 4) {}
  asset(builder: GraphBuilder, asset: Asset, evidence: Evidence) {
    const id = builder.address(asset.address, 'asset', asset.symbol, { name: asset.name, symbol: asset.symbol, decimals: asset.decimals });
    if (asset.price) builder.observe(id, 'priceUsd', asset.price.usd, { ...evidence, sourcePath: `${evidence.sourcePath}.price`, blockTimestamp: time(asset.price.timestamp) }, 'USD');
    return id;
  }
  market(builder: GraphBuilder, market: Market, evidence: Evidence) {
    const id = builder.node(`morpho-market:${builder.snapshot.chainId}:${market.marketId}`, 'lending_market', `${market.loanAsset.symbol} / ${market.collateralAsset?.symbol ?? 'No collateral'} market`, undefined, { marketId: market.marketId, lltv: market.lltv });
    builder.edge(id, this.asset(builder, market.loanAsset, { ...evidence, sourcePath: `${evidence.sourcePath}.market.loanAsset` }), 'ACCOUNTING_ASSET', { ...evidence, sourcePath: `${evidence.sourcePath}.market.loanAsset.address` });
    if (market.collateralAsset && market.collateralAsset.address !== ZERO) {
      builder.edge(id, this.asset(builder, market.collateralAsset, { ...evidence, sourcePath: `${evidence.sourcePath}.market.collateralAsset` }), 'ACCEPTS_COLLATERAL', { ...evidence, sourcePath: `${evidence.sourcePath}.market.collateralAsset.address` });
    }
    if (market.oracle && market.oracle.address !== ZERO) {
      const oracle = builder.address(market.oracle.address, 'oracle', `${market.oracle.type} oracle`, { oracleType: market.oracle.type });
      builder.edge(id, oracle, 'USES_ORACLE', { ...evidence, sourcePath: `${evidence.sourcePath}.market.oracle.address` });
      let feeds = 0;
      for (const [role, ref] of Object.entries(market.oracle.data ?? {})) {
        if (!ref || ref.address === ZERO) continue;
        const target = builder.address(ref.address, role === 'baseOracleVault' ? 'vault' : 'oracle', role === 'baseOracleVault' ? `Conversion vault ${ref.address.slice(0, 10)}` : `Price feed ${ref.address.slice(0, 10)}`);
        builder.edge(oracle, target, 'USES_CONTRACT', { ...evidence, sourcePath: `${evidence.sourcePath}.market.oracle.data.${role}.address` }, role);
        feeds++;
      }
      if (!feeds) builder.unknown(oracle, 'oracle', 'Upstream feed semantics are not decoded by the protocol API.');
    } else if (market.collateralAsset) builder.unknown(id, 'oracle', 'No nonzero oracle was provided; collateral pricing remains unresolved.');
    if (market.irmAddress !== ZERO) builder.edge(id, builder.address(market.irmAddress, 'contract', 'Interest rate model'), 'USES_CONTRACT', evidence, 'interest_rate_model');
    builder.edge(id, builder.address(market.morphoBlue.address, 'contract', 'Morpho Blue core'), 'USES_CONTRACT', { ...evidence, sourcePath: `${evidence.sourcePath}.market.morphoBlue.address` }, 'protocol_core');
    builder.edge(id, `eip155:${builder.snapshot.chainId}`, 'SETTLES_ON', evidence);
    if (market.state) {
      const stateEvidence = { ...evidence, blockNumber: market.state.blockNumber, blockTimestamp: time(market.state.timestamp) };
      builder.observe(id, 'marketSupplyAssets', market.state.supplyAssets, stateEvidence, 'raw_asset_units');
      builder.observe(id, 'marketBorrowAssets', market.state.borrowAssets, stateEvidence, 'raw_asset_units');
      builder.observe(id, 'marketLiquidityAssets', market.state.liquidityAssets, stateEvidence, 'raw_asset_units');
    }
    return id;
  }
  async discover(builder: GraphBuilder, vault: VaultV1 | VaultV2, depth = 0) {
    const id = evmId(builder.snapshot.chainId, vault.address);
    if (this.visited.has(id)) { builder.unknown(id, 'traversal', 'Repeated nested vault or cycle; entity traversal deduplicated.'); return; }
    this.visited.add(id);
    if (depth > this.maxDepth) { builder.unknown(id, 'traversal', 'Maximum nested vault depth reached.'); return; }
    const isV1 = 'state' in vault;
    const state = isV1 ? vault.state : null;
    const evidence = builder.api(isV1 ? 'vaultByAddress' : 'vaultV2ByAddress', state?.blockNumber, state ? time(state.timestamp) : undefined);
    builder.address(vault.address, 'vault', vault.name, { symbol: vault.symbol, protocol: isV1 ? 'Morpho V1' : 'Morpho V2', listed: vault.listed });
    builder.node(`eip155:${builder.snapshot.chainId}`, 'chain', vault.chain.network);
    builder.edge(id, `eip155:${builder.snapshot.chainId}`, 'SETTLES_ON', evidence);
    builder.edge(id, this.asset(builder, vault.asset, { ...evidence, sourcePath: `${evidence.sourcePath}.asset` }), 'ACCOUNTING_ASSET', { ...evidence, sourcePath: `${evidence.sourcePath}.asset.address` });
    for (const [role, address] of Object.entries(isV1 ? { owner: state?.owner, curator: state?.curator, guardian: state?.guardian } : { owner: vault.owner.address, curator: vault.curator.address })) {
      if (address && address !== ZERO) builder.edge(id, builder.address(address, 'administrator', `${role} ${address.slice(0, 10)}`), 'CONTROLLED_BY', { ...evidence, sourcePath: `${evidence.sourcePath}.${isV1 ? 'state.' : ''}${role}` }, role);
    }
    const totalAssets = isV1 ? state?.totalAssets : vault.totalAssets;
    builder.observe(id, 'totalAssets', totalAssets ?? null, evidence, 'raw_asset_units');
    builder.observe(id, 'totalAssetsUsd', isV1 ? state?.totalAssetsUsd ?? null : vault.totalAssetsUsd, evidence, 'USD');
    builder.observe(id, 'totalSupply', isV1 ? state?.totalSupply ?? null : vault.totalSupply, evidence, 'raw_share_units');
    if (isV1) {
      if (!state) { builder.unknown(id, 'lending', 'Indexed vault state is unavailable.'); return; }
      for (const [index, allocation] of state.allocation.entries()) {
        const ev = builder.api(`vaultByAddress.state.allocation[${index}]`, allocation.blockNumber, time(state.timestamp));
        const market = this.market(builder, allocation.market, ev);
        const edge = builder.edge(id, market, 'ALLOCATES_TO', ev);
        builder.observe(edge.id, 'allocationAssets', allocation.supplyAssets, ev, 'raw_asset_units');
        builder.observe(edge.id, 'allocationAssetsUsd', allocation.supplyAssetsUsd, ev, 'USD');
        builder.observe(edge.id, 'allocationCap', allocation.supplyCap, ev, 'raw_asset_units');
        const share = fraction(allocation.supplyAssets, state.totalAssets);
        builder.observe(edge.id, 'allocationFraction', share, ev, 'fraction', true);
        if (BigInt(allocation.supplyAssets) > 0n) builder.expose({ marketId: market, vaultId: id, assets: allocation.supplyAssets, fraction: share, evidence: ev, path: [id, market] });
        if (allocation.blockNumber !== state.blockNumber) builder.unknown(market, 'snapshot_consistency', 'Allocation and vault state use different indexed blocks.');
        if (allocation.market.loanAsset.address !== vault.asset.address) builder.unknown(market, 'accounting', 'Loan asset differs from the vault accounting asset.');
      }
      const deployed = state.allocation.reduce((sum, item) => sum + BigInt(item.supplyAssets), 0n);
      if (deployed > BigInt(state.totalAssets)) builder.unknown(id, 'accounting', 'Observed allocations exceed vault totalAssets; numeric loss is disabled.');
    } else {
      for (const reason of vault.paginationIssues ?? []) builder.unknown(id, 'traversal', reason);
      builder.observe(id, 'idleAssets', vault.idleAssets, evidence, 'raw_asset_units');
      const page = vault.adapters;
      if (page.pageInfo && page.pageInfo.countTotal > (page.items?.length ?? 0)) builder.unknown(id, 'traversal', 'Adapter pagination is incomplete; some adapters are missing from this snapshot.');
      for (const [index, adapter] of (page.items ?? []).entries()) {
        const ev = builder.api(`vaultV2ByAddress.adapters.items[${index}]`);
        const aid = builder.address(adapter.address, 'contract', `${adapter.__typename} adapter`, { adapterType: adapter.type });
        const edge = builder.edge(id, aid, 'ALLOCATES_TO', ev);
        builder.observe(edge.id, 'allocationAssets', adapter.assets, ev, 'raw_asset_units');
        builder.observe(edge.id, 'allocationFraction', totalAssets ? fraction(adapter.assets, totalAssets) : null, ev, 'fraction', true);
        if (adapter.positions) {
          if (adapter.positions.pageInfo && adapter.positions.pageInfo.countTotal > (adapter.positions.items?.length ?? 0)) builder.unknown(aid, 'traversal', 'Position pagination is incomplete; some markets are missing from this snapshot.');
          for (const [positionIndex, position] of (adapter.positions.items ?? []).entries()) {
            const positionEvidence = { ...ev, sourcePath: `${ev.sourcePath}.positions.items[${positionIndex}]`, ...(position.state ? { blockTimestamp: time(position.state.timestamp) } : {}) };
            const mid = this.market(builder, position.market, positionEvidence);
            const allocation = builder.edge(aid, mid, 'ALLOCATES_TO', positionEvidence);
            const assets = position.state?.supplyAssets;
            builder.observe(allocation.id, 'allocationAssets', assets ?? null, positionEvidence, 'raw_asset_units');
            if (assets && totalAssets && BigInt(assets) > 0n) builder.expose({ marketId: mid, vaultId: id, assets, fraction: fraction(assets, totalAssets), evidence: positionEvidence, path: [id, aid, mid] });
          }
        } else if (adapter.metaMorpho || adapter.innerVault) {
          const nested = adapter.metaMorpho ?? adapter.innerVault!;
          builder.edge(aid, builder.address(nested.address, 'vault', 'Nested vault'), 'ALLOCATES_TO', ev);
          try {
            const child = adapter.metaMorpho ?? await this.api.vault(builder.snapshot.chainId, nested.address, 2);
            await this.discover(builder, child, depth + 1);
            // Nested financial attribution needs each claim's share conversion, not graph-path multiplication.
            builder.unknown(aid, 'accounting', 'Nested-vault loss attribution requires validated ownership and share-conversion accounting.');
          } catch { builder.unknown(aid, 'traversal', 'Nested vault inspection is unavailable.'); }
        } else builder.unknown(aid, 'lending', 'Unrecognized adapter target semantics.');
      }
    }
  }
}
