import { JsonClient } from './http.js';
import { validateCandles, type Candle } from '../forecast/depeg.js';

/** Only direct fiat-USD pairs. Symbols never come from untrusted contract metadata. */
export const stablecoinRegistry = {
  'eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', provider: 'kraken', product: 'USDCUSD' },
  'eip155:1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', provider: 'coinbase', product: 'USDT-USD' },
  'eip155:1:0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', provider: 'coinbase', product: 'DAI-USD' }
} as const;
export class PriceClient {
  constructor(private readonly http = new JsonClient(undefined, 12000, 60_000)) {}
  async history(provider: string, product: string, start: number, end: number): Promise<{ candles: Candle[]; source: string; retrievedAt: string }> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > 298 * 3600) throw new Error('INVALID_PRICE_WINDOW');
    let source: string;
    if (provider === 'coinbase' && ['UST-USD', 'DAI-USD', 'USDT-USD'].includes(product)) {
      source = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    } else if (provider === 'binance_us' && product === 'USDCUSD') {
      source = `https://api.binance.us/api/v3/klines?symbol=USDCUSD&interval=1h&startTime=${start * 1000}&endTime=${end * 1000 - 1}&limit=1000`;
    } else if (provider === 'kraken' && product === 'USDCUSD') {
      if (start < Date.now() / 1000 - 719 * 3600) throw new Error('KRAKEN_RECENT_HISTORY_ONLY');
      source = `https://api.kraken.com/0/public/OHLC?pair=USDCUSD&interval=60&since=${start}`;
    } else throw new Error('UNSUPPORTED_PRICE_PRODUCT');
    const raw = await this.http.request(source);
    const kraken = raw as { error?: unknown; result?: Record<string, unknown> };
    const payload = provider === 'kraken' ? kraken?.result?.USDCUSD : raw;
    if (provider === 'kraken' && (!Array.isArray(kraken?.error) || kraken.error.length)) throw new Error('INVALID_PRICE_RESPONSE');
    if (!Array.isArray(payload)) throw new Error('INVALID_PRICE_RESPONSE');
    const candles = validateCandles(provider === 'coinbase' ? payload : payload.map(r => {
      if (!Array.isArray(r) || r.length < 6) throw new Error('INVALID_PRICE_RESPONSE');
      if (provider === 'kraken') {
        if (r.length !== 8) throw new Error('INVALID_PRICE_RESPONSE');
        return [Number(r[0]), Number(r[3]), Number(r[2]), Number(r[1]), Number(r[4]), Number(r[6])];
      }
      return [Number(r[0]) / 1000, Number(r[3]), Number(r[2]), Number(r[1]), Number(r[4]), Number(r[5])];
    })).filter(c => c[0] >= start && c[0] < end);
    return { candles, source, retrievedAt: new Date().toISOString() };
  }
}
