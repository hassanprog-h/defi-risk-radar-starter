import { estimateRegime, labelledExamples, regimeAt, type Candle, type DepegModel } from './depeg.js';

export function scoreForecasts(model: DepegModel, product: string, candles: Candle[], start: number, end: number) {
  const examples = labelledExamples(product, candles, end).filter(e => e.asOf >= start);
  const baseline = model.examples.filter(e => e.labelAvailableAt <= start);
  const base = baseline.length ? baseline.filter(e => e.event).length / baseline.length : 0;
  const scored = examples.flatMap(e => {
    const prediction = estimateRegime(model, e.regime, e.asOf);
    return prediction ? [{ ...e, probability: prediction.probability }] : [];
  });
  return {
    product, samples: scored.length, skipped: examples.length - scored.length, events: scored.filter(e => e.event).length,
    brier: scored.length ? scored.reduce((sum, e) => sum + (e.probability - Number(e.event)) ** 2, 0) / scored.length : null,
    baselineBrier: scored.length ? scored.reduce((sum, e) => sum + (base - Number(e.event)) ** 2, 0) / scored.length : null,
    calibration: ['PEGGED', 'WATCH', 'DEPEG', 'DISTRESSED'].map(regime => {
      const rows = scored.filter(e => e.regime === regime);
      return { regime, samples: rows.length, predicted: rows.length ? rows.reduce((s, e) => s + e.probability, 0) / rows.length : null, observed: rows.length ? rows.filter(e => e.event).length / rows.length : null };
    })
  };
}

/** Frozen defensive rule, separate from the experimental probability model. */
export function guardSignal(candles: Candle[], i: number) {
  return regimeAt(candles, i) !== null && candles[i]![4] < .995 && candles[i - 1]![4] < .995 && candles[i]![4] < candles[i - 1]![4];
}
export function priceCounterfactual(product: string, source: Candle[], destination: Candle[] | null, start: number, end: number, costBps: number, positionUsd = 10000) {
  if (!Number.isFinite(costBps) || costBps < 0 || costBps > 1000 || !Number.isFinite(positionUsd) || positionUsd <= 0) throw new Error('INVALID_COUNTERFACTUAL');
  const rows = source.filter(c => c[0] >= start && c[0] < end);
  const first = rows[0], last = rows.at(-1);
  if (!first || !last || rows.length < 25) return { product, status: 'INSUFFICIENT_HISTORY' };
  const units = positionUsd / first[3];
  const alarms = [];
  let previous = false;
  for (let i = 24; i < source.length; i++) {
    const active = guardSignal(source, i);
    if (source[i]![0] >= start && source[i]![0] < end && active && !previous) {
      const future = source.slice(i + 1, i + 25);
      const complete = future.length === 24 && future.at(-1)![0] - source[i]![0] === 24 * 3600;
      alarms.push({ at: source[i]![0] + 3600, candleIndex: i,
        additionalDrop2Percent: complete ? Math.min(...future.map(c => c[4])) <= source[i]![4] * .98 : null });
    }
    previous = active;
  }
  // One-hour delay after the closed-candle signal. No execution at a price already gone.
  const trigger = alarms[0];
  const execution = trigger ? source[trigger.candleIndex + 2] : undefined;
  const destMap = new Map(destination?.map(c => [c[0], c]) ?? []);
  const destAt = execution ? destMap.get(execution[0]) : undefined;
  const destFinal = destMap.get(last[0]);
  const holdingTerminalUsd = units * last[4];
  const holdingMinimumUsd = units * Math.min(...rows.map(c => c[1]));
  const holdingMinimumHourlyCloseUsd = units * Math.min(...rows.map(c => c[4]));
  const suspiciousIntrahourBars = rows.filter(c => c[1] < Math.min(c[3], c[4]) * .8).map(c => ({ at: new Date(c[0] * 1000).toISOString(), low: c[1], close: c[4] }));
  if (trigger && (!execution || execution[0] !== trigger.at + 3600 || execution[0] >= end || destination && (!destAt || !destFinal))) return {
    product, status: 'EXECUTION_PRICE_MISSING', signalAt: new Date(trigger.at * 1000).toISOString(), holdingTerminalUsd, holdingMinimumUsd
  };
  const soldUsd = execution ? units * execution[3] * (1 - costBps / 10000) : null;
  const reallocatedTerminalUsd = soldUsd === null ? holdingTerminalUsd : destination ? soldUsd / destAt![3] * destFinal![4] : soldUsd;
  const futureTrough = execution ? Math.min(...rows.filter(c => c[0] >= execution[0]).map(c => c[4])) : null;
  const destFutureMinimum = execution && destination ? Math.min(...destination.filter(c => c[0] >= execution[0] && c[0] < end).map(c => c[4])) : 1;
  return {
    product, status: 'PRICE_ONLY_COUNTERFACTUAL', costBps, positionUsd,
    start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString(),
    signalAt: trigger ? new Date(trigger.at * 1000).toISOString() : null,
    executedAt: execution ? new Date(execution[0] * 1000).toISOString() : null,
    sourceExecutionPrice: execution?.[3] ?? null, destinationExecutionPrice: destination ? destAt?.[3] ?? null : 1,
    destination: destination ? 'USDT-USD actual market prices' : 'USD cash assumption',
    holdingTerminalUsd, holdingMinimumUsd, holdingMinimumHourlyCloseUsd, reallocatedTerminalUsd, suspiciousIntrahourBars,
    terminalBenefitUsd: reallocatedTerminalUsd - holdingTerminalUsd,
    postSignalTroughBenefitUsd: soldUsd !== null && futureTrough !== null ? (destination ? soldUsd / destAt![3] * destFutureMinimum : soldUsd) - units * futureTrough : null,
    alarms: alarms.map(({ candleIndex, ...a }) => ({ ...a, at: new Date(a.at * 1000).toISOString() })),
    falseAlarms: alarms.filter(a => a.additionalDrop2Percent === false).length,
    historicalExecutionVerified: false, vaultWithdrawalVerified: false,
    caveats: ['No historical order-book depth, market fill or vault withdrawal is established.', 'Costs are sensitivity assumptions, not historical executable quotes.', 'Post-signal benefit compares subsequent minimum hourly-close source/destination values; these minima may occur at different times, not a tradable return.', 'Intrahour lows include isolated venue prints; suspicious bars are retained and flagged, not used for hourly-close benefit.', 'Missing candles are not forward filled; alarms with missing future labels are unknown.', 'The guard detects price stress after it begins; it does not predict an unforeseen exploit.']
  };
}
