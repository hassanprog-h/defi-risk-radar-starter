import { addressSchema } from '../connectors/morpho.js';
import { GraphBuilder, ZERO } from '../live/builder.js';
import type { RpcReader } from '../live/types.js';

export async function discoverErc4626(builder: GraphBuilder, rpc: RpcReader, address: string) {
  const block = builder.snapshot.blockNumber ?? undefined;
  const code = await rpc.code(address, block);
  if (!code || code === '0x') throw new Error('ADDRESS_HAS_NO_CONTRACT_CODE');
  let asset: string, totalAssets: bigint, totalSupply: bigint;
  try {
    const values = await Promise.all([
      rpc.read(address, 'function asset() view returns (address)', [], block),
      rpc.read(address, 'function totalAssets() view returns (uint256)', [], block),
      rpc.read(address, 'function totalSupply() view returns (uint256)', [], block)
    ]);
    asset = addressSchema.parse(values[0]); totalAssets = BigInt(String(values[1])); totalSupply = BigInt(String(values[2]));
    if (asset === ZERO || totalAssets < 0n || totalSupply < 0n) throw new Error();
  } catch { throw new Error('UNSUPPORTED_CONTRACT: no validated vault accounting interface'); }
  let label = `Vault ${address.slice(0, 10)}`;
  try { const value = await rpc.read(address, 'function name() view returns (string)', [], block); if (typeof value === 'string') label = value.slice(0, 256); } catch {}
  const id = builder.address(address, 'vault', label, { protocol: 'ERC-4626 compatible' });
  const assetId = builder.address(asset, 'asset', asset.slice(0, 10));
  builder.edge(id, assetId, 'ACCOUNTING_ASSET', builder.onchain(address, 'asset()'));
  builder.node(`eip155:${builder.snapshot.chainId}`, 'chain', builder.snapshot.chainId === 1 ? 'Ethereum' : `Chain ${builder.snapshot.chainId}`);
  builder.edge(id, `eip155:${builder.snapshot.chainId}`, 'SETTLES_ON', builder.onchain(address, 'eth_getCode'));
  builder.observe(id, 'totalAssets', totalAssets.toString(), builder.onchain(address, 'totalAssets()'), 'raw_asset_units');
  builder.observe(id, 'totalSupply', totalSupply.toString(), builder.onchain(address, 'totalSupply()'), 'raw_share_units');
  builder.snapshot.protocol = 'ERC-4626 compatible (strategy semantics unresolved)';
  builder.snapshot.coverage.settlement = 'verified';
  builder.snapshot.coverage.underlying = 'partial';
  builder.unknown(id, 'lending', 'Generic vault accounting does not enumerate deployed strategies.');
  builder.unknown(id, 'classification', 'Successful interface reads identify compatibility; they do not certify ERC-4626 compliance.');
}
