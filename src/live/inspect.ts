import { z } from 'zod';
import { MorphoClient, parseSelector, addressSchema, rawInteger, type VaultV1, type VaultV2 } from '../connectors/morpho.js';
import { ProviderError } from '../connectors/http.js';
import { SourceClient } from '../connectors/source.js';
import { PendleClient } from '../connectors/pendle.js';
import { MorphoAdapter } from '../adapters/morpho.js';
import { discoverPendleVenues } from '../adapters/pendle.js';
import { discoverErc4626 } from '../adapters/erc4626.js';
import { GraphBuilder, evmId, ZERO } from './builder.js';
import { enrich } from './enrich.js';
import { discoverDocumentedIssuers } from './issuers.js';
import { pinV2Accounting } from './accounting.js';
import type { RpcReader } from './types.js';

export interface InspectOptions { api?: MorphoClient; rpc?: RpcReader; source?: SourceClient; enrichment?: boolean; }
export async function inspectVault(selector: string, options: InspectOptions = {}) {
  const { chainId, address } = parseSelector(selector);
  const builder = new GraphBuilder(chainId, address);
  const api = options.api ?? new MorphoClient();
  let vault: VaultV1 | VaultV2 | undefined;
  let rest: { last_indexed_block: string; gates?: Record<string, string | null>; adapter_registry?: string | null; liquidity_adapter?: string | null } | undefined;
  let apiFailure = 'NOT_INDEXED';
  for (const version of [1, 2] as const) {
    try {
      try {
        const config = z.object({ data: z.object({ chain_id: z.number().int(), address: addressSchema, last_indexed_block: rawInteger,
          gates: z.record(z.string(), addressSchema.nullable()).optional(), adapter_registry: addressSchema.nullable().optional(), liquidity_adapter: addressSchema.nullable().optional()
        }) }).parse(await api.rest(`/v0/vaults-v${version}/${chainId}:${address}`));
        if (config.data.chain_id !== chainId || config.data.address !== address) throw new ProviderError('IDENTITY_MISMATCH');
        rest = config.data;
      } catch (error) {
        if (!(error instanceof ProviderError) || error.code !== 'NOT_INDEXED') throw error;
        rest = undefined; // REST listing/config absence is not proof GraphQL lacks an unlisted vault.
      }
      vault = await api.vault(chainId, address, version);
      builder.snapshot.protocol = `Morpho Vault V${version}`;
      builder.snapshot.blockNumber = 'state' in vault ? vault.state?.blockNumber ?? rest?.last_indexed_block ?? null : rest?.last_indexed_block ?? null;
      builder.snapshot.blockTimestamp = 'state' in vault && vault.state ? new Date(Number(vault.state.timestamp) * 1000).toISOString() : null;
      builder.snapshot.providerStatus.push({ provider: 'morpho', status: 'ok', blockNumber: builder.snapshot.blockNumber ?? undefined, observedAt: builder.snapshot.observedAt });
      break;
    } catch (error) {
      apiFailure = error instanceof ProviderError ? error.code : 'UPSTREAM_SCHEMA_MISMATCH';
      if (apiFailure !== 'NOT_INDEXED') break;
    }
  }
  let rpc = options.rpc;
  if (rpc) {
    try {
      // V2 financial state is rebuilt from RPC, so use a fresh block rather than a lagging REST index.
      const anchor = await rpc.anchor(vault && !('state' in vault) ? undefined : builder.snapshot.blockNumber ?? undefined);
      builder.snapshot.blockNumber = anchor.number;
      builder.snapshot.blockTimestamp = anchor.timestamp;
      builder.snapshot.blockHash = anchor.hash;
      builder.snapshot.providerStatus.push({ provider: 'ethereum_rpc', status: 'ok', blockNumber: anchor.number, observedAt: builder.snapshot.observedAt });
      if (Date.now() - Date.parse(anchor.timestamp) > 15 * 60_000) builder.unknown(builder.snapshot.rootPositionId, 'freshness', 'Anchor block is older than 15 minutes; current-state decisions are disabled.');
    } catch {
      builder.snapshot.providerStatus.push({ provider: 'ethereum_rpc', status: 'unavailable', observedAt: builder.snapshot.observedAt, message: 'Chain mismatch, unavailable historical block, or RPC failure.' });
      builder.unknown(builder.snapshot.rootPositionId, 'rpc', 'On-chain corroboration is unavailable at the requested block.');
      rpc = undefined;
    }
  } else builder.snapshot.providerStatus.push({ provider: 'ethereum_rpc', status: 'not_configured', observedAt: builder.snapshot.observedAt });
  if (vault) {
    await new MorphoAdapter(api).discover(builder, vault);
    builder.snapshot.coverage.settlement = 'verified';
    builder.snapshot.coverage.lending = 'state' in vault && !vault.state ? 'unresolved' : 'partial';
    builder.snapshot.coverage.governance = 'partial';
    builder.snapshot.coverage.oracle = 'partial';
    if ('state' in vault && vault.state) builder.snapshot.coverage.lending = 'verified';
    if (!('state' in vault) && (!rpc || !await pinV2Accounting(builder, rpc, vault))) builder.unknown(builder.snapshot.rootPositionId, 'snapshot_consistency', 'V2 indexed allocations alone have no common block; complete pinned accounting is required for numeric estimates.');
    if (!rest && !('state' in vault)) builder.unknown(builder.snapshot.rootPositionId, 'governance', 'REST gate configuration is unavailable; V2 gates have not been enumerated.');
    if (rest?.gates) for (const [role, gate] of Object.entries(rest.gates)) {
      if (!gate || gate === ZERO) continue;
      const evidence = { ...builder.api(`data.gates.${role}`, rest.last_indexed_block), reference: `${api.base}/v0/vaults-v2/${chainId}:${address}` };
      builder.edge(builder.snapshot.rootPositionId, builder.address(gate, 'contract', `${role} gate`), 'USES_CONTRACT', evidence, role);
      builder.unknown(builder.snapshot.rootPositionId, 'exit', 'A configured gate may affect transfers or withdrawals; owner-specific execution must be checked.');
    }
    if (rpc) await verifyMorpho(builder, rpc, vault);
  } else {
    builder.snapshot.providerStatus.push({ provider: 'morpho', status: 'degraded', observedAt: builder.snapshot.observedAt, message: apiFailure });
    if (!rpc) throw new Error(`${apiFailure}: no indexed vault and no working RPC fallback`);
    await discoverErc4626(builder, rpc, address);
  }
  if (rpc && options.enrichment !== false) {
    await discoverPendleVenues(builder, rpc, new PendleClient(api.http));
    await enrich(builder, rpc, options.source);
    builder.snapshot.providerStatus.push({ provider: 'etherscan', status: options.source ? builder.snapshot.unknowns.some(item => item.category === 'source') ? 'degraded' : 'ok' : 'not_configured', observedAt: builder.snapshot.observedAt, message: options.source ? 'Per-contract source failures and budgets are listed in unknowns.' : undefined });
  }
  discoverDocumentedIssuers(builder);
  const final = builder.finish();
  if (!final.nodes.some(node => node.kind === 'amm')) builder.unknown(final.rootPositionId, 'amm', 'No verified AMM dependency discovered; this is not proof that no exit-liquidity dependency exists.');
  if (!final.nodes.some(node => node.kind === 'issuer')) builder.unknown(final.rootPositionId, 'issuer', 'Off-chain issuer and backing dependencies are not exhaustively established by contract reads.');
  if (rpc && final.blockNumber && final.blockHash) {
    try { if (!await rpc.sameBlock(final.blockNumber, final.blockHash)) builder.unknown(final.rootPositionId, 'reorg', 'Anchor hash changed during inspection; discard this snapshot for decisions.'); }
    catch { builder.unknown(final.rootPositionId, 'reorg', 'Final anchor hash could not be rechecked.'); }
  }
  if (final.unknowns.some(item => ['snapshot_consistency', 'accounting', 'traversal', 'provider_mismatch'].includes(item.category))) final.coverage.lending = 'partial';
  return builder.finish();
}

async function verifyMorpho(builder: GraphBuilder, rpc: RpcReader, vault: VaultV1 | VaultV2) {
  const root = builder.snapshot.rootPositionId;
  const block = builder.snapshot.blockNumber ?? undefined;
  const pairs = [['asset', vault.asset.address, 'ACCOUNTING_ASSET'], ['owner', 'state' in vault ? vault.state?.owner : vault.owner.address, 'CONTROLLED_BY'], ['curator', 'state' in vault ? vault.state?.curator : vault.curator.address, 'CONTROLLED_BY']] as const;
  for (const [getter, expected, relation] of pairs) {
    if (!expected || expected === ZERO) continue;
    try {
      const actual = addressSchema.parse(await rpc.read(vault.address, `function ${getter}() view returns (address)`, [], block));
      builder.corroborate(root, evmId(builder.snapshot.chainId, expected), relation, builder.onchain(vault.address, `${getter}()`), actual === expected, getter === 'asset' ? undefined : getter);
    } catch { builder.unknown(root, 'verification', `Could not corroborate ${getter}() on-chain.`); }
  }
  const markets = builder.finish().nodes.filter(node => node.kind === 'lending_market');
  for (const market of markets) {
    const edges = builder.finish().edges.filter(edge => edge.from === market.id);
    const core = edges.find(edge => edge.role === 'protocol_core');
    const coreNode = builder.finish().nodes.find(node => node.id === core?.to);
    const marketId = market.metadata?.marketId;
    if (!coreNode?.address || typeof marketId !== 'string') continue;
    try {
      const values = await rpc.read(coreNode.address, 'function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)', [marketId], block) as unknown[];
      for (const [relation, index] of [['ACCOUNTING_ASSET', 0], ['ACCEPTS_COLLATERAL', 1], ['USES_ORACLE', 2]] as const) {
        const edge = edges.find(edge => edge.kind === relation);
        if (edge) builder.corroborate(market.id, edge.to, relation, builder.onchain(coreNode.address, `idToMarketParams(${marketId})`), edge.to === evmId(builder.snapshot.chainId, addressSchema.parse(values[index])));
      }
    } catch { builder.unknown(market.id, 'verification', 'Market parameters could not be independently corroborated.'); }
  }
}
