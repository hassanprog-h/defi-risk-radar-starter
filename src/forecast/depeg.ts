/** An auditable empirical baseline. It predicts price risk, not hacks or lender bad debt. */
export type Candle = [number, number, number, number, number, number]; // UTC start seconds, low, high, open, close, volume
export type Regime = 'PEGGED' | 'WATCH' | 'DEPEG' | 'DISTRESSED';
export interface Example {
  product: string; asOf: number; labelAvailableAt: number; regime: Regime;
  event: boolean; terminalDownside: number; drawdown: number;
}
export interface DepegModel {
  version: 'empirical-depeg-v1'; horizonHours: 24; eventDropFraction: .02;
  trainedThrough: string; examples: Example[]; datasetHash: string;
  validation?: { brier: number; baselineBrier: number; samples: number; events: number };
}
export function validateCandles(input: unknown): Candle[] {
  if (!Array.isArray(input) || input.length > 100_000) throw new Error('INVALID_CANDLES');
  const seen = new Set<number>();
  const result = input.map(row => {
    if (!Array.isArray(row) || row.length !== 6 || !row.every(Number.isFinite)) throw new Error('INVALID_CANDLE');
    const [time, low, high, open, close, volume] = row as Candle;
    if (!Number.isSafeInteger(time) || time % 3600 || low <= 0 || high < low || Math.min(open, close) < low || Math.max(open, close) > high || volume < 0 || seen.has(time)) throw new Error('INVALID_CANDLE');
    seen.add(time); return row as Candle;
  });
  return result.sort((a, b) => a[0] - b[0]);
}
export function regimeAt(candles: Candle[], i: number): Regime | null {
  if (i < 24 || !candles[i] || candles[i]![0] - candles[i - 24]![0] !== 24 * 3600) return null;
  const price = candles[i]![4];
  const momentum = price / candles[i - 1]![4] - 1;
  if (price < .95) return 'DISTRESSED';
  if (price < .99) return 'DEPEG';
  if (price < .995 || momentum < -.002) return 'WATCH';
  return 'PEGGED';
}
export function labelledExamples(product: string, candles: Candle[], cutoff: number): Example[] {
  const result: Example[] = [];
  for (let i = 24; i + 24 < candles.length; i++) {
    const regime = regimeAt(candles, i);
    const last = candles[i + 24]!;
    const asOf = candles[i]![0] + 3600;
    const labelAvailableAt = last[0] + 3600;
    if (!regime || labelAvailableAt > cutoff || last[0] - candles[i]![0] !== 24 * 3600) continue;
    const price = candles[i]![4];
    const drawdown = Math.max(0, 1 - Math.min(...candles.slice(i + 1, i + 25).map(c => c[4])) / price);
    result.push({ product, asOf, labelAvailableAt, regime, event: drawdown >= .02,
      terminalDownside: Math.max(0, 1 - last[4] / price), drawdown });
  }
  return result;
}
export function estimateRegime(model: DepegModel, regime: Regime, asOf: number) {
  // Labels, not merely feature dates, must precede the decision. No hindsight leakage.
  const history = model.examples.filter(e => e.regime === regime && e.labelAvailableAt <= asOf);
  if (!history.length) return null;
  const events = history.filter(e => e.event).length;
  const clusters = new Set(history.map(e => `${e.product}:${Math.floor(e.asOf / 86400)}`)).size;
  return {
    probability: events / history.length, expectedTerminalDownsideFraction: history.reduce((s, e) => s + e.terminalDownside, 0) / history.length,
    expectedDrawdownFraction: history.reduce((s, e) => s + e.drawdown, 0) / history.length,
    conditionalDrawdownFraction: events ? history.filter(e => e.event).reduce((s, e) => s + e.drawdown, 0) / events : null,
    samples: history.length, productDayClusters: clusters, independentEvents: null,
    support: clusters >= 30 ? 'HISTORICAL_SUPPORT' : 'SPARSE_SUPPORT',
    caveat: 'Overlapping 24-hour labels are correlated. Product-day clusters are not independent incidents. Zero observed events is not zero true risk.'
  };
}
export function predictDepeg(model: DepegModel, candles: Candle[], now: number) {
  const closed = candles.filter(c => c[0] + 3600 <= now);
  const last = closed.at(-1);
  const regime = regimeAt(closed, closed.length - 1);
  const fresh = !!last && now - (last[0] + 3600) < 2 * 3600;
  const reference = last && regime ? estimateRegime(model, regime, last[0] + 3600) : null;
  return {
    status: !fresh ? 'STALE_OR_MISSING_DATA' : !regime ? 'INCOMPLETE_HISTORY' : !reference ? 'OUT_OF_SUPPORT' : 'EXPERIMENTAL_REFERENCE',
    modelVersion: model.version, trainedThrough: model.trainedThrough, regime, horizonHours: 24,
    event: 'A further 2% price drop from the observed close during the next 24 hours (hourly closes).',
    priceUsd: last?.[4] ?? null, marketAsOf: last ? new Date((last[0] + 3600) * 1000).toISOString() : null,
    probabilityWithinHorizon: fresh && reference ? reference.probability : null,
    expectedTerminalDownsideFraction: fresh && reference ? reference.expectedTerminalDownsideFraction : null,
    reference, validatedForLiveExecution: false,
    explanation: 'Pooled historical regime frequencies, without a user-supplied probability. Different stablecoin mechanisms and regime drift limit transfer. This research model cannot authorize live execution.'
  };
}
