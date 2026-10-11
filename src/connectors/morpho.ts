import { z } from 'zod';
import { JsonClient, ProviderError } from './http.js';
import { v1Query, v2Query } from './queries.js';

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const text = z.string().max(256);
export const rawInteger = z.union([z.string().regex(/^\d+$/).max(78), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]).transform(String);
const usd = z.number().finite().nonnegative().nullable();
export const assetSchema = z.object({ address: addressSchema, name: text, symbol: text, decimals: z.number().int().min(0).max(36), price: z.object({ usd: z.number().finite().nonnegative(), timestamp: rawInteger }).nullish() });
const ref = z.object({ address: addressSchema });
export const marketSchema = z.object({
  marketId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase()),
  irmAddress: addressSchema, lltv: rawInteger, morphoBlue: ref,
  loanAsset: assetSchema, collateralAsset: assetSchema.nullable(),
  oracle: z.object({ address: addressSchema, type: text, data: z.object({
    baseFeedOne: ref.nullish(), baseFeedTwo: ref.nullish(), quoteFeedOne: ref.nullish(), quoteFeedTwo: ref.nullish(), baseOracleVault: ref.nullish()
  }).nullish() }).nullable(),
  state: z.object({ blockNumber: rawInteger, timestamp: rawInteger, supplyAssets: rawInteger, borrowAssets: rawInteger, liquidityAssets: rawInteger }).nullable()
});
const chain = z.object({ id: z.number().int().positive(), network: text, headBlock: z.object({ number: rawInteger, timestamp: rawInteger }).nullable() });
const allocation = z.object({ blockNumber: rawInteger, supplyAssets: rawInteger, supplyAssetsUsd: usd, supplyShares: rawInteger, supplyCap: rawInteger, market: marketSchema });
export const v1Schema = z.object({
  address: addressSchema, name: text, symbol: text, listed: z.boolean(), asset: assetSchema, chain,
  state: z.object({ blockNumber: rawInteger, timestamp: rawInteger, totalAssets: rawInteger, totalAssetsUsd: usd, totalSupply: rawInteger,
    owner: addressSchema, curator: addressSchema, guardian: addressSchema, timelock: rawInteger, allocation: z.array(allocation).max(200)
  }).nullable()
});
const position = z.object({ market: marketSchema, state: z.object({ timestamp: rawInteger, supplyAssets: rawInteger.nullable(), supplyAssetsUsd: usd, supplyShares: rawInteger }).nullable() });
const pageInfo = z.object({ count: z.number().int().nonnegative(), countTotal: z.number().int().nonnegative() }).nullable();
export const v2Schema = z.object({
  address: addressSchema, name: text, symbol: text, listed: z.boolean(), asset: assetSchema, chain,
  totalAssets: rawInteger.nullable(), totalAssetsUsd: usd, totalSupply: rawInteger, idleAssets: rawInteger, liquidity: rawInteger,
  owner: ref, curator: ref, sentinels: z.array(z.object({ sentinel: ref })).max(100),
  adapters: z.object({ pageInfo, items: z.array(z.object({
    address: addressSchema, type: text, __typename: text, assets: rawInteger, assetsUsd: usd,
    positions: z.object({ pageInfo, items: z.array(position).max(100).nullable() }).optional(),
    metaMorpho: v1Schema.optional(), innerVault: ref.optional()
  })).max(100).nullable() })
});
export type VaultV1 = z.infer<typeof v1Schema>;
export type VaultV2 = z.infer<typeof v2Schema>;
export type Market = z.infer<typeof marketSchema>;
export type Asset = z.infer<typeof assetSchema>;

export function parseSelector(selector: string) {
  const match = /^(?:eip155:)?([1-9]\d*):(0x[0-9a-fA-F]{40})$/.exec(selector);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('INVALID_SELECTOR: use <chainId>:<0x-address>');
  return { chainId: Number(match[1]), address: addressSchema.parse(match[2]) as `0x${string}` };
}

export class MorphoClient {
  constructor(public readonly http = new JsonClient(), public readonly base = 'https://api.morpho.org') {
    if (!/^https:\/\//.test(base)) throw new Error('Morpho API must use HTTPS');
  }
  async rest(path: string) { return this.http.request(this.base + path); }
  async vault(chainId: number, address: string, version: 1 | 2) {
    const raw = await this.http.request(this.base + '/graphql', { query: version === 1 ? v1Query : v2Query, variables: { address, chainId } });
    const envelope = z.object({ data: z.record(z.string(), z.unknown()).nullish(), errors: z.array(z.unknown()).optional() }).parse(raw);
    if (envelope.errors?.length) {
      const notFound = envelope.errors.every(error => error !== null && typeof error === 'object' && 'status' in error && error.status === 'NOT_FOUND');
      throw new ProviderError(notFound ? 'NOT_INDEXED' : 'GRAPHQL_ERROR', notFound ? 404 : undefined);
    }
    const value = envelope.data?.[version === 1 ? 'vaultByAddress' : 'vaultV2ByAddress'];
    if (!value) throw new ProviderError('NOT_INDEXED', 404);
    try {
      const result = version === 1 ? v1Schema.parse(value) : v2Schema.parse(value);
      if (result.chain.id !== chainId || result.address !== address.toLowerCase()) throw new ProviderError('IDENTITY_MISMATCH');
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('UPSTREAM_SCHEMA_MISMATCH');
    }
  }
  async list(chainId: number, version: 1 | 2, cursor?: string) {
    const path = `/v0/vaults-v${version}?chain_ids=${chainId}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const schema = z.object({ data: z.array(z.object({ chain_id: z.number().int().positive(), vault_address: addressSchema, name: text, symbol: text, version: text, asset_address: addressSchema })).max(100), cursor: z.string().max(2000).nullable().optional() });
    const response = schema.parse(await this.rest(path));
    if (response.data.some(row => row.chain_id !== chainId)) throw new ProviderError('IDENTITY_MISMATCH');
    return { ...response, source: this.base + path, observedAt: new Date().toISOString() };
  }
}
