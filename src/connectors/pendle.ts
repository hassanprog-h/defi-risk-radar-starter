import { z } from 'zod';
import { JsonClient, ProviderError } from './http.js';
import { addressSchema } from './morpho.js';

const assetId = z.string().regex(/^[1-9]\d*-0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
export const pendleMarketSchema = z.object({
  chainId: z.number().int().positive(), address: addressSchema, name: z.string().max(256), expiry: z.string().datetime(),
  pt: assetId, sy: assetId, yt: assetId, underlyingAsset: assetId, accountingAsset: assetId,
  details: z.object({ liquidity: z.number().finite().nonnegative(), totalPt: z.number().finite().nonnegative(), totalSy: z.number().finite().nonnegative(), feeRate: z.number().finite().min(0).max(1) })
});
export type PendleMarket = z.infer<typeof pendleMarketSchema>;

/** Public, documented GET /v2/markets/all, verified against embedded OpenAPI on 2026-10-11. */
export class PendleClient {
  readonly base = 'https://api-v2.pendle.finance/core';
  constructor(private readonly http = new JsonClient()) {}
  async markets(chainId: number) {
    const records: { market: PendleMarket; source: string; sourcePath: string }[] = [];
    const seen = new Set<string>();
    let total = Infinity;
    for (let skip = 0; skip < total && skip < 1000; skip += 100) {
      const source = `${this.base}/v2/markets/all?chainId=${chainId}&limit=100&skip=${skip}`;
      const page = z.object({ total: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), skip: z.number().int().nonnegative(), results: z.array(pendleMarketSchema).max(100) }).parse(await this.http.request(source));
      if (page.skip !== skip || page.results.some(row => row.chainId !== chainId)) throw new ProviderError('IDENTITY_MISMATCH');
      total = page.total;
      for (const [index, market] of page.results.entries()) {
        if (seen.has(market.address)) continue;
        seen.add(market.address); records.push({ market, source, sourcePath: `results[${index}]` });
      }
      if (page.results.length < 100) break;
    }
    return { records, incomplete: records.length < total };
  }
}
