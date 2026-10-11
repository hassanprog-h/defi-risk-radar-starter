import { readFileSync } from 'node:fs';
import { validateSnapshot } from '../dist/core/graph.js';
import { simulate } from '../dist/core/simulator.js';
import { decide } from '../dist/core/decision.js';

export const warning = 'ILLUSTRATIVE FIXTURE: not real Morpho data or financial advice';
export const defaultScenario = {
  id: 'illustrative-market-a-loss', kind: 'MARKET_LOSS', targetNodeId: 'market:a',
  severityFraction: 0.20, horizonHours: 24, probabilityWithinHorizon: 0.25
};

export function loadFixture() {
  const snapshot = JSON.parse(readFileSync(new URL('../fixtures/illustrative-vault.json', import.meta.url), 'utf8'));
  for (const edge of snapshot.edges) {
    edge.evidence = {
      status: 'verified', sourceType: 'fixture', reference: 'fixtures/illustrative-vault.json',
      observedAt: snapshot.observedAt, notes: 'Verified within the illustrative fixture only; never verified on-chain.'
    };
  }
  const issues = validateSnapshot(snapshot);
  if (issues.length) throw new Error(`Invalid snapshot: ${issues.join('; ')}`);
  return snapshot;
}

export function evaluateFixture(snapshot, scenario = defaultScenario, exitCostUsd = 200) {
  const incident = simulate(snapshot, scenario);
  return { warning, snapshot, scenario, incident, decision: decide(incident, scenario, exitCostUsd) };
}
