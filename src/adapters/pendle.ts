import { addressSchema } from '../connectors/morpho.js';
import { PendleClient } from '../connectors/pendle.js';
import { GraphBuilder, evmId } from '../live/builder.js';
import { inspectPendleMarket } from '../live/enrich.js';
import type { RpcReader } from '../live/types.js';

/** Venue association is distinct from an actual oracle dependency or a feasible exit quote. */
export async function discoverPendleVenues(builder: GraphBuilder, rpc: RpcReader, api = new PendleClient()) {
  const candidates = builder.finish().nodes.filter(node => node.address && (node.label.startsWith('PT-') || /Pendle.*Principal/.test(String(node.metadata?.contractName ?? ''))));
  if (!candidates.length) return;
  try {
    const directory = await api.markets(builder.snapshot.chainId);
    builder.snapshot.providerStatus.push({ provider: 'pendle', status: directory.incomplete ? 'degraded' : 'ok', observedAt: builder.snapshot.observedAt, message: 'Whitelisted market directory; unlisted venues may be absent.' });
    for (const pt of candidates) {
      const matches = directory.records.filter(({ market }) => market.pt === `${builder.snapshot.chainId}-${pt.address}`);
      if (!matches.length) { builder.unknown(pt.id, 'amm', 'No matching whitelisted Pendle venue found; unlisted markets may exist.'); continue; }
      for (const { market, source, sourcePath } of matches.slice(0, 5)) {
        const amm = builder.address(market.address, 'amm', `Pendle ${market.name} · ${market.expiry.slice(0, 10)}`, { protocol: 'Pendle', venueAssociationOnly: true });
        const indexed = { ...builder.api(sourcePath), reference: source, notes: 'Indexed trading venue association. Does not establish oracle usage, execution availability or slippage.' };
        builder.edge(pt.id, amm, 'TRADED_ON', indexed);
        builder.observe(amm, 'indexedLiquidityUsd', market.details.liquidity, indexed, 'USD');
        builder.observe(amm, 'indexedPtReserve', market.details.totalPt, indexed, 'natural_pt_units');
        builder.observe(amm, 'indexedSyReserve', market.details.totalSy, indexed, 'natural_sy_units');
        builder.observe(amm, 'indexedFeeRate', market.details.feeRate, indexed, 'fraction');
        builder.observe(pt.id, 'expiry', market.expiry, indexed);
        try {
          const tokens = await rpc.read(market.address, 'function readTokens() view returns (address SY, address PT, address YT)', [], builder.snapshot.blockNumber ?? undefined) as unknown[];
          const actualPt = addressSchema.parse(tokens[1]), actualSy = addressSchema.parse(tokens[0]);
          const matches = actualPt === pt.address && `${builder.snapshot.chainId}-${actualSy}` === market.sy;
          builder.corroborate(pt.id, amm, 'TRADED_ON', builder.onchain(market.address, 'readTokens()'), matches);
          if (matches) {
            await inspectPendleMarket(builder, rpc, market.address, true);
            builder.edge(amm, `eip155:${builder.snapshot.chainId}`, 'SETTLES_ON', builder.onchain(market.address, 'readTokens()'));
            const sy = evmId(builder.snapshot.chainId, actualSy);
            builder.unknown(sy, 'underlying', 'SY yield token, strategy and redemption constraints need independent reads; reference denomination alone is not backing.');
          }
        } catch { builder.unknown(amm, 'verification', 'Venue token configuration could not be corroborated at the inspection block.'); }
        builder.unknown(amm, 'exit', 'Venue identified, but no position-sized swap quote or executable exit route has been verified.');
      }
    }
    builder.snapshot.coverage.amm = 'partial';
  } catch {
    builder.snapshot.providerStatus.push({ provider: 'pendle', status: 'unavailable', observedAt: builder.snapshot.observedAt });
    builder.unknown(builder.snapshot.rootPositionId, 'amm', 'Pendle directory is unavailable, rate-limited or has an incompatible schema.');
  }
}
