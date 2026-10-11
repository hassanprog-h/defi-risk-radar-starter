import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { labelledExamples, validateCandles } from '../dist/forecast/depeg.js';
import { scoreForecasts, priceCounterfactual } from '../dist/forecast/evaluate.js';
const root = new URL('../datasets/history/', import.meta.url);
const manifestBody = await readFile(new URL('manifest.json', root), 'utf8');
const manifest = JSON.parse(manifestBody), protocol = manifest.protocol;
const series = [];
for (const item of manifest.series) {
  const raw = await readFile(new URL(item.filename, root), 'utf8');
  if (createHash('sha256').update(raw).digest('hex') !== item.sha256) throw new Error('DATASET_HASH_MISMATCH');
  const data = JSON.parse(raw);
  series.push({ ...data, candles: validateCandles(data.candles) });
}
const seconds = t => Date.parse(t) / 1000;
const trainEnd = seconds(protocol.training[1]);
const examples = series.flatMap(s => labelledExamples(s.product, s.candles.filter(c => c[0] >= seconds(protocol.training[0]) && c[0] < trainEnd), trainEnd));
const model = { version: 'empirical-depeg-v1', horizonHours: 24, eventDropFraction: .02, trainedThrough: protocol.training[1],
  datasetHash: createHash('sha256').update(manifestBody).digest('hex'), examples };
const scores = [];
for (const role of ['validation', 'test', 'secondaryTest']) for (const s of series.filter(s => s.roles.includes(role))) {
  const [start, end] = protocol[role].map(seconds);
  scores.push({ role, ...scoreForecasts(model, s.product, s.candles, start, end) });
}
const validation = scores.filter(s => s.role === 'validation' && s.brier !== null);
const n = validation.reduce((s, e) => s + e.samples, 0);
model.validation = { samples: n, events: validation.reduce((s, e) => s + e.events, 0), brier: validation.reduce((s, e) => s + e.brier * e.samples, 0) / n,
  baselineBrier: validation.reduce((s, e) => s + e.baselineBrier * e.samples, 0) / n };
const dest = series.find(s => s.product === 'USDT-USD').candles;
const counterfactuals = [];
for (const role of ['test', 'secondaryTest']) for (const s of series.filter(s => s.roles.includes(role))) {
  const [start, end] = protocol[role].map(seconds);
  for (const cost of protocol.guard.costBps) counterfactuals.push({ role, ...priceCounterfactual(s.product, s.candles, s.product === 'USDT-USD' ? null : dest, start, end, cost) });
}
// Also show the training incident, prominently labelled in-sample: no generalization claim.
const ust = series.find(s => s.product === 'UST-USD');
for (const cost of protocol.guard.costBps) counterfactuals.push({ role: 'training_in_sample', ...priceCounterfactual('UST-USD', ust.candles, dest, seconds('2022-05-01T00:00:00Z'), trainEnd, cost) });
const report = { schemaVersion: '1.0', kind: 'HISTORICAL_PRICE_BENCHMARK', generatedAt: new Date().toISOString(), protocol, datasetHash: model.datasetHash,
  model: { version: model.version, trainedThrough: model.trainedThrough, trainingSamples: examples.length, trainingEvents: examples.filter(e => e.event).length, validation: model.validation, liveExecutionValidated: false },
  series: manifest.series, scores, counterfactuals,
  curves: series.map(s => ({ product: s.product, candles: s.candles.filter(c => c[0] >= seconds('2023-03-08T00:00:00Z') && c[0] < seconds('2023-03-16T00:00:00Z')).map(c => [c[0], c[4]]) })),
  conclusion: 'Experimental price-risk baseline and a frozen protective rule. Counterfactuals do not prove historical vault executions or general exploit forecasting. Failed forecasts and exits that lose money after recovery remain in the report.' };
await mkdir(new URL('../models/', import.meta.url), { recursive: true });
await writeFile(new URL('../models/depeg-v1.json', import.meta.url), JSON.stringify(model) + '\n');
await writeFile(new URL('../datasets/backtest-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ model: report.model, scores: scores.map(({ calibration, ...s }) => s), counterfactuals: counterfactuals.filter(c => c.costBps === 30).map(({ alarms, caveats, ...c }) => c) }, null, 2));
