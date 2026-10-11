import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCandles, labelledExamples, predictDepeg, estimateRegime } from '../dist/forecast/depeg.js';
import { priceCounterfactual } from '../dist/forecast/evaluate.js';
import { PriceClient } from '../dist/connectors/prices.js';
const start = Date.parse('2021-01-01') / 1000;
const candles = Array.from({ length: 100 }, (_, i) => [start + i * 3600, 1, 1, 1, 1, 10]);
const model = { version: 'empirical-depeg-v1', trainedThrough: '2020-01-01', horizonHours: 24, eventDropFraction: .02, examples: [
  { product: 'old', regime: 'PEGGED', asOf: start - 100000, labelAvailableAt: start - 3600, event: false, terminalDownside: .001, drawdown: .002 },
  { product: 'future', regime: 'PEGGED', asOf: start, labelAvailableAt: start + 2000000, event: true, terminalDownside: .5, drawdown: .8 }
] };
test('forecasts and labels cannot consume future candles or unavailable labels', () => {
  assert.equal(estimateRegime(model, 'PEGGED', start + 7200).probability, 0);
  const prediction = predictDepeg(model, candles, start + 30 * 3600);
  assert.equal(prediction.marketAsOf, new Date((start + 30 * 3600) * 1000).toISOString());
  assert.equal(prediction.validatedForLiveExecution, false);
  assert.equal(prediction.reference.samples, 1);
  const labels = labelledExamples('test', candles, start + 60 * 3600);
  assert.ok(labels.length > 0);
  assert.ok(labels.every(e => e.labelAvailableAt <= start + 60 * 3600));
  assert.equal(predictDepeg(model, candles.slice(0, 25), start + 30 * 3600).probabilityWithinHorizon, null);
});
test('time gaps, duplicate bars and invalid OHLC cannot create supported forecasts', () => {
  assert.throws(() => validateCandles([...candles, candles[0]]));
  assert.throws(() => validateCandles([[start, 1, 1, 1, 2, 10]]));
  assert.throws(() => validateCandles([[start, 0, 1, 1, 1, 10]]));
  const missing = candles.filter((_, i) => i !== 28);
  assert.equal(predictDepeg(model, missing, start + 30 * 3600).status, 'INCOMPLETE_HISTORY');
  assert.ok(labelledExamples('gaps', missing, start + 60 * 3600).every(e => e.asOf > start + 28 * 3600 || e.labelAvailableAt <= start + 28 * 3600));
});
test('backtests execute after the signal and include destination outcome and recovery', () => {
  const prices = candles.map(c => [...c]);
  for (let i = 25; i < 40; i++) prices[i] = [start + i * 3600, .9, 1, .96, .96 - (i - 25) * .001, 10];
  const dest = candles.map(c => [...c]); dest.at(-1)[4] = .98; dest.at(-1)[1] = .98;
  const report = priceCounterfactual('token', prices, dest, start, start + 100 * 3600, 30);
  assert.equal(report.status, 'PRICE_ONLY_COUNTERFACTUAL');
  assert.equal(Date.parse(report.executedAt) - Date.parse(report.signalAt), 3600000);
  assert.ok(report.terminalBenefitUsd < 0, 'selling during depeg and missing recovery loses money');
  assert.equal(report.vaultWithdrawalVerified, false);
  assert.equal(report.historicalExecutionVerified, false);
  const gap = dest.filter(c => c[0] !== Date.parse(report.executedAt) / 1000);
  assert.equal(priceCounterfactual('token', prices, gap, start, start + 100 * 3600, 30).status, 'EXECUTION_PRICE_MISSING');
});
test('held-out real benchmark preserves model failures rather than invent avoided loss', () => {
  const report = JSON.parse(readFileSync(new URL('../datasets/backtest-report.json', import.meta.url)));
  const usdc = report.scores.find(s => s.role === 'test' && s.product === 'USDCUSD');
  assert.ok(usdc.brier > usdc.baselineBrier);
  const outcome = report.counterfactuals.find(c => c.role === 'test' && c.product === 'USDCUSD' && c.costBps === 30);
  assert.ok(outcome.terminalBenefitUsd < 0);
  assert.ok(outcome.suspiciousIntrahourBars.length > 0);
  assert.equal(report.model.liveExecutionValidated, false);
  const ust = report.counterfactuals.find(c => c.product === 'UST-USD');
  assert.equal(ust.role, 'training_in_sample');
});
test('price connectors validate provider shapes, remove open candles and refuse arbitrary products', async () => {
  const http = { request: async () => ({ error: [], result: { USDCUSD: [[start, '1', '1', '1', '1', '1', '10', 2]] } }) };
  const client = new PriceClient(http);
  const now = Math.floor(Date.now() / 3600000) * 3600;
  http.request = async () => ({ error: [], result: { USDCUSD: [[now - 3600, '1', '1', '1', '1', '1', '10', 2], [now, '1', '1', '1', '1', '1', '10', 2]] } });
  assert.equal((await client.history('kraken', 'USDCUSD', now - 7200, now)).candles.length, 1);
  await assert.rejects(() => client.history('coinbase', '../fake', now - 3600, now));
  http.request = async () => ({ error: ['bad'], result: {} });
  await assert.rejects(() => client.history('kraken', 'USDCUSD', now - 3600, now));
});
