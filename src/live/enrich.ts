import type { GraphNode } from '../core/types.js';
import { addressSchema } from '../connectors/morpho.js';
import { SourceClient } from '../connectors/source.js';
import { GraphBuilder, ZERO } from './builder.js';
import type { RpcReader } from './types.js';
import { keccak256, stringToHex, toHex } from 'viem';

const IMPLEMENTATION_SLOT = toHex(BigInt(keccak256(stringToHex('eip1967.proxy.implementation'))) - 1n, { size: 32 });
const ADMIN_SLOT = toHex(BigInt(keccak256(stringToHex('eip1967.proxy.admin'))) - 1n, { size: 32 });

export async function enrich(builder: GraphBuilder, rpc: RpcReader, source?: SourceClient) {
  const block = builder.snapshot.blockNumber ?? undefined;
  const visited = new Set<string>();
  const queue = builder.finish().nodes.filter(node => ['asset', 'oracle', 'vault', 'administrator', 'yield_source'].includes(node.kind));
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    if (!node.address || visited.has(node.id)) continue;
    if (visited.size >= 60) { builder.unknown(node.id, 'traversal', 'Enrichment node budget reached.'); break; }
    visited.add(node.id);
    const discoveredBefore = new Set(builder.finish().nodes.map(n => n.id));
    if (node.kind === 'oracle') await inspectOracle(builder, rpc, node);
    if (node.kind === 'asset' || node.kind === 'vault') {
      for (const [method, output] of [['symbol', 'string'], ['decimals', 'uint8']] as const) {
        try {
          const value = await rpc.read(node.address, `function ${method}() view returns (${output})`, [], block);
          if (method === 'symbol' && typeof value === 'string') builder.address(node.address, node.kind, value.slice(0, 80), { symbol: value.slice(0, 80) });
          if (method === 'decimals') builder.address(node.address, node.kind, node.label, { decimals: Number(value) });
        } catch {}
      }
      try {
        const asset = addressSchema.parse(await rpc.read(node.address, 'function asset() view returns (address)', [], block));
        const total = await rpc.read(node.address, 'function totalAssets() view returns (uint256)', [], block);
        if (asset !== ZERO && asset !== node.address) {
          builder.address(node.address, 'vault', node.label);
          builder.edge(node.id, builder.address(asset, 'asset', asset.slice(0, 10)), 'ACCOUNTING_ASSET', builder.onchain(node.address, 'asset()'));
          builder.observe(node.id, 'totalAssetsOnchain', String(total), builder.onchain(node.address, 'totalAssets()'), 'raw_asset_units');
          if (node.id !== builder.snapshot.rootPositionId) builder.unknown(node.id, 'underlying', 'Nested vault accounting observed; downstream strategies require a supported adapter.');
        }
      } catch {}
    }
    if (source && ['asset', 'vault', 'administrator', 'yield_source', 'oracle'].includes(node.kind)) {
      try {
        const contract = await source.contract(builder.snapshot.chainId, node.address);
        builder.address(node.address, node.kind, node.label, { contractName: contract.name, sourceVerified: true, sourceLicense: contract.license });
        if (contract.proxy && /^0x[0-9a-fA-F]{40}$/.test(contract.implementation)) {
          const target = builder.address(contract.implementation, 'contract', `${contract.name} implementation`);
          const evidence = { ...builder.onchain(node.address, 'ERC-1967 implementation slot'), sourceType: 'verified_source' as const, verification: 'documentation_only' as const, reference: contract.source, notes: 'Explorer-reported implementation; deployment storage corroboration is separate.' };
          builder.edge(node.id, target, 'USES_CONTRACT', evidence, 'implementation');
          try {
            const storage = await rpc.storage(node.address, IMPLEMENTATION_SLOT, block);
            if (storage?.slice(-40).toLowerCase() === contract.implementation.slice(2).toLowerCase()) builder.corroborate(node.id, target, 'USES_CONTRACT', builder.onchain(node.address, 'ERC-1967 implementation slot'), true, 'implementation');
          } catch {}
        }
        const getters = contract.abi.filter(entry => entry.type === 'function' && entry.inputs?.length === 0 && ['view', 'pure'].includes(entry.stateMutability ?? '') && entry.outputs?.length === 1 && entry.outputs[0]?.type === 'address');
        const priority = new Set(['SY', 'YT', 'market', 'yieldToken', 'underlying', 'stETH', 'owner', 'admin', 'BASE_VAULT', 'QUOTE_VAULT', 'BASE_FEED_1', 'BASE_FEED_2', 'QUOTE_FEED_1', 'QUOTE_FEED_2', 'aggregator', 'quoteOracle', 'pendleOracle', 'priceFeed']);
        for (const getter of getters.filter(entry => priority.has(entry.name ?? '')).slice(0, 20)) {
          const name = getter.name!;
          try {
            const address = addressSchema.parse(await rpc.read(node.address, `function ${name}() view returns (address)`, [], block));
            if (address === ZERO || address === node.address) continue;
            const isAdmin = name === 'owner' || name === 'admin';
            const feed = /FEED|aggregator|Oracle|priceFeed/.test(name);
            const kind = isAdmin ? 'administrator' : feed ? 'oracle' : name === 'SY' || name === 'yieldToken' ? 'yield_source' : name === 'market' ? 'amm' : 'asset';
            const target = builder.address(address, kind, `${name} ${address.slice(0, 10)}`);
            const relation = isAdmin ? 'CONTROLLED_BY' : name === 'SY' && /Pendle.*Principal/i.test(contract.name) ? 'CLAIM_ON' : name === 'market' && /Pendle.*Oracle/i.test(contract.name) ? 'USES_AMM' : feed ? 'USES_PRICE_FEED' : name === 'stETH' && contract.name === 'WstETH' ? 'WRAPS' : name === 'yieldToken' && /^Pendle/.test(contract.name) ? 'WRAPS' : 'USES_CONTRACT';
            builder.edge(node.id, target, relation, builder.onchain(node.address, `${name}()`), name);
            if (relation === 'USES_CONTRACT') builder.unknown(target, 'semantics', `On-chain ${name}() reference observed; economic role needs protocol-specific interpretation.`);
            if (name === 'market') await inspectPendleMarket(builder, rpc, address, /^Pendle/.test(contract.name));
          } catch {}
        }
      } catch { builder.unknown(node.id, 'source', 'Verified source or ABI unavailable, rate-limited, or beyond the source budget.'); }
    }
    if (node.kind === 'yield_source') {
      // Pendle assetInfo is a price denomination, not proof of backing or same-chain deployment.
      try {
        const info = await rpc.read(node.address, 'function assetInfo() view returns (uint8 assetType, address assetAddress, uint8 assetDecimals)', [], block) as unknown[];
        const address = addressSchema.parse(info[1]);
        builder.observe(node.id, 'referenceAssetAddress', address, builder.onchain(node.address, 'assetInfo()'));
        builder.unknown(node.id, 'issuer', 'SY reference asset may be off-chain or on another network; backing is not established by assetInfo().');
      } catch {}
    }
    const next = builder.finish().nodes.filter(n => !discoveredBefore.has(n.id) && ['asset', 'oracle', 'vault', 'yield_source'].includes(n.kind));
    queue.push(...next);
  }
  // Inspect proxy admin slots only on confirmed contract roots; zero slots are normal for immutable vaults.
  const root = builder.finish().nodes.find(node => node.id === builder.snapshot.rootPositionId);
  if (root?.address) {
    try {
      const value = await rpc.storage(root.address, ADMIN_SLOT, block);
      if (value && value.length === 66) {
        const address = addressSchema.parse('0x' + value.slice(-40));
        if (address !== ZERO) builder.edge(root.id, builder.address(address, 'administrator', 'Proxy administrator'), 'UPGRADEABLE_BY', builder.onchain(root.address, 'ERC-1967 admin slot'));
      }
    } catch {}
  }
  builder.snapshot.coverage.underlying = 'partial';
  if (builder.finish().edges.some(e => e.kind === 'USES_AMM')) builder.snapshot.coverage.amm = 'partial';
}

async function inspectOracle(builder: GraphBuilder, rpc: RpcReader, node: GraphNode) {
  const block = builder.snapshot.blockNumber ?? undefined;
  if (!node.address) return;
  const getterMap = { BASE_FEED_1: 'baseFeedOne', BASE_FEED_2: 'baseFeedTwo', QUOTE_FEED_1: 'quoteFeedOne', QUOTE_FEED_2: 'quoteFeedTwo', BASE_VAULT: 'baseOracleVault', QUOTE_VAULT: 'quoteOracleVault' };
  for (const [method, role] of Object.entries(getterMap)) {
    try {
      const address = addressSchema.parse(await rpc.read(node.address, `function ${method}() view returns (address)`, [], block));
      if (address === ZERO) continue;
      const target = builder.address(address, method.includes('VAULT') ? 'vault' : 'oracle', `${role} ${address.slice(0, 10)}`);
      builder.edge(node.id, target, 'USES_CONTRACT', builder.onchain(node.address, `${method}()`), role);
    } catch {}
  }
  try {
    const values = await rpc.read(node.address, 'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)', [], block) as unknown[];
    const updated = BigInt(String(values[3]));
    const answer = BigInt(String(values[1]));
    const round = BigInt(String(values[0]));
    const answered = BigInt(String(values[4]));
    const evidence = builder.onchain(node.address, 'latestRoundData()');
    builder.observe(node.id, 'oracleAnswerRaw', answer.toString(), evidence);
    builder.observe(node.id, 'oracleUpdatedAt', updated.toString(), evidence, 'unix_seconds');
    builder.observe(node.id, 'oracleRoundComplete', updated > 0n && answer > 0n && answered >= round, evidence);
    if (builder.snapshot.blockTimestamp) builder.observe(node.id, 'oracleAgeSeconds', Math.max(0, Math.floor(Date.parse(builder.snapshot.blockTimestamp) / 1000) - Number(updated)), evidence, 'seconds', true);
    builder.unknown(node.id, 'oracle_freshness', 'Age is measured; feed-specific heartbeat and deviation policy are not assumed.');
  } catch { builder.unknown(node.id, 'oracle_freshness', 'No readable AggregatorV3 round data; freshness is unknown for this oracle design.'); }
}

export async function inspectPendleMarket(builder: GraphBuilder, rpc: RpcReader, address: string, documentedPendle = false) {
  try {
    const tokens = await rpc.read(address, 'function readTokens() view returns (address SY, address PT, address YT)', [], builder.snapshot.blockNumber ?? undefined) as unknown[];
    const [sy, pt, yt] = tokens.map(value => addressSchema.parse(value));
    if (!sy || !pt || !yt || sy === ZERO || pt === ZERO || yt === ZERO) return;
    const id = builder.address(address, 'amm', 'Pendle-compatible PT / SY market');
    const evidence = builder.onchain(address, 'readTokens()');
    const syId = builder.address(sy, 'yield_source', `SY ${sy.slice(0, 10)}`);
    const ptId = builder.address(pt, 'asset', `PT ${pt.slice(0, 10)}`);
    builder.edge(id, syId, 'USES_CONTRACT', evidence, 'SY');
    builder.edge(id, ptId, 'USES_CONTRACT', evidence, 'PT');
    builder.edge(id, builder.address(yt, 'asset', `YT ${yt.slice(0, 10)}`), 'USES_CONTRACT', evidence, 'YT');
    if (documentedPendle) {
      const ptSy = addressSchema.parse(await rpc.read(pt, 'function SY() view returns (address)', [], builder.snapshot.blockNumber ?? undefined));
      if (ptSy === sy) builder.edge(ptId, syId, 'CLAIM_ON', builder.onchain(pt, 'SY()'));
      else builder.unknown(ptId, 'provider_mismatch', 'Market token configuration disagrees with PT SY().');
    } else builder.unknown(ptId, 'semantics', 'readTokens() returned a compatible configuration; Pendle principal-claim semantics are not independently established.');
    builder.snapshot.coverage.amm = 'partial';
  } catch { builder.unknown(builder.snapshot.rootPositionId, 'amm', 'Candidate market does not expose validated Pendle token configuration.'); }
}
