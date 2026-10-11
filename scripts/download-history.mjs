import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PriceClient } from '../dist/connectors/prices.js';
const protocol = JSON.parse(await readFile(new URL('../datasets/PROTOCOL.json', import.meta.url)));
const client = new PriceClient();
await mkdir(new URL('../datasets/history/', import.meta.url), { recursive: true });
const manifest = { protocol, retrievedAt: new Date().toISOString(), series: [] };
for (const spec of protocol.products) {
  const rows = new Map(), sources = [];
  for (const role of spec.roles) {
    const [start, end] = protocol[role].map(t => Date.parse(t) / 1000);
    for (let cursor = start; cursor < end; cursor += 298 * 3600) {
      const record = await client.history(spec.provider, spec.product, cursor, Math.min(cursor + 298 * 3600, end));
      const hash = createHash('sha256').update(JSON.stringify(record.candles)).digest('hex');
      sources.push({ role, source: record.source, retrievedAt: record.retrievedAt, normalizedSha256: hash, rows: record.candles.length });
      for (const c of record.candles) {
        const previous = rows.get(c[0]);
        if (previous && JSON.stringify(previous) !== JSON.stringify(c)) throw new Error('HISTORICAL_PROVIDER_CHANGED');
        rows.set(c[0], c);
      }
      // Deliberately below public request limits; no synthetic forward-filled candles.
      await new Promise(resolve => setTimeout(resolve, 220));
    }
  }
  const candles = [...rows.values()].sort((a, b) => a[0] - b[0]);
  const filename = `${spec.product}.json`;
  const body = JSON.stringify({ ...spec, candles, sources });
  await writeFile(new URL(`../datasets/history/${filename}`, import.meta.url), body + '\n');
  manifest.series.push({ ...spec, filename, rows: candles.length, sha256: createHash('sha256').update(body + '\n').digest('hex') });
  console.log(`${spec.product}: ${candles.length} actual hourly candles`);
}
await writeFile(new URL('../datasets/history/manifest.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
