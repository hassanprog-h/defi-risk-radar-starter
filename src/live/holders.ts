import { MorphoClient, rawInteger } from '../connectors/morpho.js';
import { ZERO } from './builder.js';
import type { LiveSnapshot, RpcReader } from './types.js';

/** Public indexer candidates are verified on-chain. No wallet ownership is inferred. */
export async function findPublicHolder(snapshot: LiveSnapshot, rpc: RpcReader, api: MorphoClient) {
  const root = snapshot.nodes.find(n => n.id === snapshot.rootPositionId);
  if (snapshot.mode !== 'live' || !root?.address || !/^Morpho Vault V[12]$/.test(snapshot.protocol)) throw new Error('PUBLIC_HOLDER_LOOKUP_REQUIRES_LIVE_MORPHO_VAULT');
  const candidates = await api.holders(snapshot.chainId, root.address, snapshot.protocol.endsWith('V2') ? 2 : 1);
  const block = await rpc.anchor();
  const unique = [...new Set(candidates.map(p => p.owner))].filter(a => a !== ZERO && a !== '0x000000000000000000000000000000000000dead').slice(0, 20);
  for (const owner of unique) {
    try {
      const [balance, code] = await Promise.all([
        rpc.read(root.address, 'function balanceOf(address) view returns (uint256)', [owner], block.number), rpc.code(owner, block.number)
      ]);
      const shares = rawInteger.parse(String(balance));
      if (BigInt(shares) === 0n || code && code !== '0x') continue;
      if (!await rpc.sameBlock(block.number, block.hash)) throw new Error('HOLDER_ANCHOR_CHANGED');
      return { owner, shares, sourceBlock: block.number, observedAt: new Date().toISOString(),
        evidence: { sourceType: 'onchain_call', reference: `eip155:${snapshot.chainId}:${root.address}#balanceOf(${owner})`, blockNumber: block.number },
        note: 'Public example holder, not your wallet. Balance is verified; redemption feasibility is assessed separately. Candidate search is limited to 20 indexed holders.' };
    } catch { /* A failing candidate does not imply it has a redeemable position. */ }
  }
  throw new Error('NO_PUBLIC_EOA_HOLDER_FOUND: no verified non-contract holder among the first 20 indexed candidates');
}
