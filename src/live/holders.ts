import { MorphoClient, rawInteger } from '../connectors/morpho.js';
import { ZERO } from './builder.js';
import { parseUnits } from 'viem';
import { z } from 'zod';
import type { LiveSnapshot, RpcReader } from './types.js';

/** Public indexer candidates are verified on-chain. No wallet ownership is inferred. */
export async function findPublicHolder(snapshot: LiveSnapshot, rpc: RpcReader, api: MorphoClient, positionUsd?: number) {
  const root = snapshot.nodes.find(n => n.id === snapshot.rootPositionId);
  if (snapshot.mode !== 'live' || !root?.address || !/^Morpho Vault V[12]$/.test(snapshot.protocol)) throw new Error('PUBLIC_HOLDER_LOOKUP_REQUIRES_LIVE_MORPHO_VAULT');
  const candidates = await api.holders(snapshot.chainId, root.address, snapshot.protocol.endsWith('V2') ? 2 : 1);
  const block = await rpc.anchor();
  let minimumShares = 1n;
  if (positionUsd !== undefined) {
    if (!Number.isFinite(positionUsd) || positionUsd <= 0 || positionUsd > 1e12) throw new Error('INVALID_POSITION_VALUE');
    const asset = String(await rpc.read(root.address, 'function asset() view returns(address)', [], block.number));
    const decimals = Number(await rpc.read(asset, 'function decimals() view returns(uint8)', [], block.number));
    const raw = await api.http.request(api.base + '/graphql', { query: 'query HolderPrice($address:String!,$chainId:Int!){assetByAddress(address:$address,chainId:$chainId){price{usd timestamp}}}', variables: { address: asset, chainId: snapshot.chainId } });
    const price = z.object({ data: z.object({ assetByAddress: z.object({ price: z.object({ usd: z.number().finite().positive(), timestamp: rawInteger }) }) }) }).parse(raw).data.assetByAddress.price;
    const age = Date.now() / 1000 - Number(price.timestamp);
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36 || age < 0 || age >= 900) throw new Error('HOLDER_SIZING_REQUIRES_FRESH_PRICE');
    // Cover the entered position, plus a small explicit buffer for the bounded fork route fee.
    const desired = positionUsd / price.usd * 1.0002;
    if (desired >= 1e21) throw new Error('HOLDER_SIZING_LIMIT');
    const assets = parseUnits(desired.toFixed(Math.min(decimals, 18)), decimals);
    minimumShares = BigInt(rawInteger.parse(String(await rpc.read(root.address, 'function previewWithdraw(uint256) view returns(uint256)', [assets], block.number))));
    if (minimumShares <= 0n) throw new Error('HOLDER_SIZE_BELOW_SHARE_PRECISION');
  }
  const unique = [...new Set([...candidates].sort((a, b) => BigInt(a.shares) > BigInt(b.shares) ? -1 : BigInt(a.shares) < BigInt(b.shares) ? 1 : 0).map(p => p.owner))].filter(a => a !== ZERO && a !== '0x000000000000000000000000000000000000dead').slice(0, 20);
  for (const owner of unique) {
    try {
      const [balance, code] = await Promise.all([
        rpc.read(root.address, 'function balanceOf(address) view returns (uint256)', [owner], block.number), rpc.code(owner, block.number)
      ]);
      const shares = rawInteger.parse(String(balance));
      if (BigInt(shares) < minimumShares || code && code !== '0x') continue;
      if (!await rpc.sameBlock(block.number, block.hash)) throw new Error('HOLDER_ANCHOR_CHANGED');
      return { owner, shares, minimumShares: minimumShares.toString(), requestedPositionUsd: positionUsd ?? null, sourceVault: root.address, sourceBlock: block.number, observedAt: new Date().toISOString(),
        evidence: { sourceType: 'onchain_call', reference: `eip155:${snapshot.chainId}:${root.address}#balanceOf(${owner})`, blockNumber: block.number },
        note: 'Public example holder, not your wallet. Balance is verified; redemption feasibility is assessed separately. Candidate search is limited to 20 indexed holders.' };
    } catch { /* A failing candidate does not imply it has a redeemable position. */ }
  }
  throw new Error(positionUsd === undefined ? 'NO_PUBLIC_EOA_HOLDER_FOUND: no verified non-contract holder among the first 20 indexed candidates' : 'NO_SUITABLE_PUBLIC_HOLDER: no verified non-contract holder with enough shares among the first 20 indexed candidates');
}
