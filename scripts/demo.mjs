import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateSnapshot } from '../dist/core/graph.js';
import { simulate } from '../dist/core/simulator.js';
import { decide } from '../dist/core/decision.js';

const fixturePath = fileURLToPath(new URL('../fixtures/illustrative-vault.json', import.meta.url));
const snapshot = JSON.parse(readFileSync(fixturePath, 'utf8'));
// All evidence is labelled FIxture/VERIFIED IN FIXTURE ONLY, not verified on-chain.
for (const edge of snapshot.edges) {
  edge.evidence = { status: 'verified', sourceType: 'fixture', reference: 'fixtures/illustrative-vault.json', observedAt: snapshot.observedAt };
}
const issues = validateSnapshot(snapshot);
if (issues.length) throw new Error(`Invalid snapshot: ${issues.join('; ')}`);

const scenario = {
  id: 'illustrative-market-a-loss', kind: 'MARKET_LOSS', targetNodeId: 'market:a',
  severityFraction: 0.20, horizonHours: 24, probabilityWithinHorizon: 0.25
};
const incident = simulate(snapshot, scenario);
const decision = decide(incident, scenario, 200);
console.log(JSON.stringify({ warning: 'ILLUSTRATIVE FIXTURE: not real Morpho data or financial advice',
  graph: { nodes: snapshot.nodes.length, edges: snapshot.edges.length },
  incident, decision }, null, 2));
