import { readFile } from 'node:fs/promises';
import { loadReplay } from '../dist/live/replay.js';
import { analyzeLive } from '../dist/live/analyze.js';

try {
  const [file, sizeInput, severityInput = '0.2', targetInput] = process.argv.slice(2);
  if (!file || !sizeInput) throw new Error('USAGE');
  const bytes = await readFile(file);
  if (bytes.length > 2_000_000) throw new Error('TOO_LARGE');
  const snapshot = loadReplay(JSON.parse(bytes.toString('utf8')));
  const size = Number(sizeInput), severity = Number(severityInput);
  const target = targetInput ?? snapshot.exposures.find(entry => entry.fraction !== null && entry.fraction > 0)?.marketId;
  if (!target || snapshot.nodes.find(node => node.id === target)?.kind !== 'lending_market') throw new Error('NO_MARKET');
  const report = analyzeLive(snapshot, { id: 'historical-hypothetical-market-loss', kind: 'MARKET_LOSS', targetNodeId: target, severityFraction: severity, horizonHours: 24 }, { positionUsd: size });
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error('Cannot replay this recording. Usage: npm run replay -- <exported-live-graph.json> <assumed-position-usd> [loss-fraction] [market-node-id]. Requires a valid exported graph; never treats a recording as current data.');
  process.exitCode = 1;
}
