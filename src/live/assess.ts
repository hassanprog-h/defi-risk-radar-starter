import type { Evidence } from '../core/types.js';
import type { LiveSnapshot } from './types.js';

/** Observational checks, not an incident-probability or lender-loss forecaster. */
export function assessDependencies(snapshot: LiveSnapshot, positionUsd: number | null, now = Date.now()) {
  if (positionUsd !== null && (!Number.isFinite(positionUsd) || positionUsd <= 0 || positionUsd > 1e12)) throw new Error('INVALID_POSITION_VALUE');
  const age = now - Date.parse(snapshot.observedAt);
  const blockAge = snapshot.blockTimestamp === null ? NaN : now - Date.parse(snapshot.blockTimestamp);
  const fresh = snapshot.mode === 'live' && Number.isFinite(age) && age >= -60_000 && age <= 300_000
    && Number.isFinite(blockAge) && blockAge >= -60_000 && blockAge <= 900_000;
  const verified = (e: Evidence) => e.status === 'verified' && ['onchain_call', 'protocol_api'].includes(e.sourceType);
  // Forward reachability is bounded by the finite snapshot; shared nodes/cycles are visited once.
  const reachable = new Set([snapshot.rootPositionId]);
  const outgoing = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to); outgoing.set(edge.from, list);
  }
  const queue = [snapshot.rootPositionId];
  for (let i = 0; i < queue.length; i++) for (const id of outgoing.get(queue[i]!) ?? []) {
    if (!reachable.has(id)) { reachable.add(id); queue.push(id); }
  }
  const dependencies = snapshot.nodes.filter(n => reachable.has(n.id));
  const capital = snapshot.exposures.filter(e => e.vaultId === snapshot.rootPositionId);
  const blockers = snapshot.unknowns.filter(u => ['accounting', 'provider_mismatch', 'reorg', 'snapshot_consistency', 'traversal', 'freshness'].includes(u.category));
  const paths = new Set(capital.map(e => e.path.join('|')));
  const total = capital.reduce((sum, e) => sum + (e.fraction ?? 0), 0);
  const accountingUsable = fresh && blockers.length === 0 && capital.length > 0 && paths.size === capital.length
    && capital.every(e => reachable.has(e.marketId) && e.fraction !== null && Number.isFinite(e.fraction) && e.fraction >= 0 && e.fraction <= 1 && verified(e.evidence))
    && total <= 1.00000000001;
  const grouped = new Map<string, { fraction: number; evidence: Evidence[] }>();
  if (accountingUsable) for (const e of capital) {
    const item = grouped.get(e.marketId) ?? { fraction: 0, evidence: [] };
    item.fraction += e.fraction!; item.evidence.push(e.evidence); grouped.set(e.marketId, item);
  }
  const concentrations = [...grouped].map(([entityId, item]) => ({
    entityId, label: snapshot.nodes.find(n => n.id === entityId)?.label ?? entityId,
    fraction: item.fraction, exposureUsd: positionUsd === null ? null : positionUsd * item.fraction, evidence: item.evidence
  })).filter(e => e.fraction > 0).sort((a, b) => b.fraction - a.fraction);
  const oracleChecks = dependencies.filter(n => n.kind === 'oracle').map(n => {
    const rounds = snapshot.observations.filter(o => o.entityId === n.id && o.metric === 'oracleRoundComplete');
    const round = rounds.length === 1 ? rounds[0] : undefined;
    const age = snapshot.observations.find(o => o.entityId === n.id && o.metric === 'oracleAgeSeconds');
    const usable = fresh && !blockers.some(b => ['reorg', 'provider_mismatch', 'snapshot_consistency'].includes(b.category))
      && round && verified(round.evidence) && round.evidence.blockNumber === snapshot.blockNumber && typeof round.value === 'boolean';
    return {
      entityId: n.id, label: n.label,
      status: usable ? round.value === false ? 'ROUND_CHECK_FAILED' : 'ROUND_CHECK_PASSED' : 'UNKNOWN',
      ageSecondsAtSnapshot: age && verified(age.evidence) && age.evidence.blockNumber === snapshot.blockNumber && typeof age.value === 'number' && Number.isFinite(age.value) && age.value >= 0 ? age.value : null,
      evidence: usable ? round.evidence : null,
      explanation: usable && round.value === false ? 'The observed pricing round fails the adapter’s basic positive-answer/completion checks. Financial impact needs the oracle and borrower mechanics.' : 'A completed round and its age do not establish freshness or price accuracy. Feed-specific heartbeat/deviation policies are required.'
    };
  });
  const unknowns = [
    ...(!fresh ? ['Snapshot or anchor is stale, missing or historical; refresh live inspection for current checks.'] : []),
    ...(!accountingUsable ? ['Consistent, fresh deployed-capital accounting is unavailable; concentration dollar amounts are withheld.'] : []),
    ...blockers.map(b => b.reason),
    'No calibrated event-probability or prospective lender-loss forecast is installed.',
    'Destination risk, migration costs and an executable reallocation have not been evaluated.'
  ];
  return {
    schemaVersion: '1.0', assessmentKind: 'OBSERVATIONAL_DEPENDENCY_CHECKS', snapshotId: snapshot.snapshotId,
    assessedAt: new Date(now).toISOString(), observedAt: snapshot.observedAt, chainId: snapshot.chainId, blockNumber: snapshot.blockNumber,
    positionUsd, positionValueSource: 'user_supplied_usd', horizonHours: 24, horizonSource: 'prototype_default',
    fresh, accountingUsable, dependencyCount: dependencies.length, concentrations, oracleChecks,
    failedRoundChecks: oracleChecks.filter(o => o.status === 'ROUND_CHECK_FAILED').length,
    unknownOracleChecks: oracleChecks.filter(o => o.status === 'UNKNOWN').length,
    forecast: { probabilityWithinHorizon: null, prospectiveLossUsd: null, expectedLossUsd: null, status: 'MODEL_NOT_AVAILABLE' },
    allocation: { action: 'INSUFFICIENT_EVIDENCE', destination: null, executionEnabled: false }, unknowns,
    explanation: 'Automatically extracted measurements from this snapshot. Concentration is capital exposure, not loss or a probability. Checks passing is not a safety rating. Refresh inspection to collect new provider data.'
  };
}
