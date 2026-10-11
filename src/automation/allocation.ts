import { assessDependencies } from '../live/assess.js';
import type { LiveSnapshot } from '../live/types.js';

export interface AllocationPolicy {
  maxMarketFraction: number; maxCollateralFraction: number; maxMoveFraction: number;
}
export const defaultAllocationPolicy: AllocationPolicy = { maxMarketFraction: .35, maxCollateralFraction: .5, maxMoveFraction: 1 };
type Profile = { assetId: string; markets: Record<string, number>; collateral: Record<string, number>; shared: string[] };
function capitalProfile(snapshot: LiveSnapshot, now: number): Profile | null {
  const assessment = assessDependencies(snapshot, null, now);
  if (!assessment.accountingUsable) return null;
  const asset = snapshot.edges.filter(e => e.from === snapshot.rootPositionId && e.kind === 'ACCOUNTING_ASSET' && e.evidence.status === 'verified');
  if (asset.length !== 1) return null;
  const markets: Record<string, number> = {}, collateral: Record<string, number> = {};
  for (const c of assessment.concentrations) {
    const edges = snapshot.edges.filter(e => e.from === c.entityId && e.kind === 'ACCEPTS_COLLATERAL' && e.evidence.status === 'verified');
    if (edges.length !== 1) return null; // unclassified collateral cannot be treated as cash/diversification
    markets[c.entityId] = c.fraction;
    collateral[edges[0]!.to] = (collateral[edges[0]!.to] ?? 0) + c.fraction;
  }
  const shared = [...new Set(snapshot.edges.filter(e => e.evidence.status === 'verified' && ['USES_ORACLE', 'BACKED_BY', 'USES_CONTRACT', 'SETTLES_ON', 'CONTROLLED_BY', 'UPGRADEABLE_BY'].includes(e.kind)).map(e => e.to))];
  return { assetId: asset[0]!.to, markets, collateral, shared };
}
function blended(a: Record<string, number>, b: Record<string, number>, move: number) {
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(id => [id, (a[id] ?? 0) * (1 - move) + (b[id] ?? 0) * move]));
}
const largest = (map: Record<string, number>) => Math.max(0, ...Object.values(map));
export function planReallocation(source: LiveSnapshot, destinations: LiveSnapshot[], positionUsd: number, policy: AllocationPolicy = defaultAllocationPolicy, now = Date.now()) {
  if (!Number.isFinite(positionUsd) || positionUsd <= 0 || positionUsd > 1e12) throw new Error('INVALID_POSITION_VALUE');
  for (const v of Object.values(policy)) if (!Number.isFinite(v) || v <= 0 || v > 1) throw new Error('INVALID_ALLOCATION_POLICY');
  const profile = capitalProfile(source, now);
  const baseline = profile ? { largestMarket: largest(profile.markets), largestCollateral: largest(profile.collateral) } : null;
  const candidates = destinations.slice(0, 5).map(destination => {
    const base = { destinationId: destination.rootPositionId, snapshotId: destination.snapshotId, label: destination.nodes.find(n => n.id === destination.rootPositionId)?.label ?? destination.rootPositionId };
    const other = capitalProfile(destination, now);
    if (!profile || !other) return { ...base, status: 'INCOMPLETE_ACCOUNTING', moveFraction: null };
    if (source.rootPositionId === destination.rootPositionId || source.chainId !== destination.chainId || other.assetId !== profile.assetId) return { ...base, status: 'INCOMPATIBLE_DESTINATION', moveFraction: null };
    if (Math.abs(Date.parse(source.blockTimestamp!) - Date.parse(destination.blockTimestamp!)) > 300_000) return { ...base, status: 'SNAPSHOT_TIME_MISMATCH', moveFraction: null };
    const retained = [...new Set([profile.assetId, ...profile.shared.filter(id => other.shared.includes(id))])];
    let lower = 0, upper = policy.maxMoveFraction;
    for (const [a, b, limit] of [[profile.markets, other.markets, policy.maxMarketFraction], [profile.collateral, other.collateral, policy.maxCollateralFraction]] as const) {
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const current = a[id] ?? 0, delta = (b[id] ?? 0) - current;
        if (Math.abs(delta) < 1e-12) { if (current > limit + 1e-12) lower = 2; }
        else if (delta < 0) lower = Math.max(lower, (limit - current) / delta);
        else upper = Math.min(upper, (limit - current) / delta);
      }
    }
    const feasible = lower <= upper + 1e-12 && upper >= 0 && lower <= policy.maxMoveFraction;
    const moveFraction = feasible ? Math.max(0, lower) : null;
    return { ...base, status: feasible ? moveFraction! > 1e-10 ? 'POLICY_CANDIDATE' : 'NO_MOVE_REQUIRED' : 'LIMITS_UNACHIEVABLE', moveFraction,
      moveUsd: moveFraction === null ? null : positionUsd * moveFraction,
      after: moveFraction === null ? null : { largestMarket: largest(blended(profile.markets, other.markets, moveFraction)), largestCollateral: largest(blended(profile.collateral, other.collateral, moveFraction)) },
      retainedDependencies: retained,
      sharedMarkets: Object.keys(profile.markets).filter(id => (other.markets[id] ?? 0) > 0),
      migrationCostUsd: null, expectedLossReductionUsd: null, executionVerified: false,
      reasons: ['Minimum partial migration satisfying the configured concentration limits.', 'Both vaults retain the same accounting token: issuer/depeg exposure is not removed.', 'Destination accounting is measured; other risks remain unknown. Yield, complete migration costs and a transaction simulation are required for an economic recommendation.'] };
  });
  const eligible = candidates.filter(c => c.status === 'POLICY_CANDIDATE').sort((a, b) => a.moveFraction! - b.moveFraction!);
  return {
    kind: 'CONCENTRATION_POLICY_PROPOSAL', sourceId: source.rootPositionId, sourceSnapshotId: source.snapshotId,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), policy, positionUsd, baseline,
    status: !profile ? 'INSUFFICIENT_EVIDENCE' : baseline!.largestMarket <= policy.maxMarketFraction && baseline!.largestCollateral <= policy.maxCollateralFraction ? 'WITHIN_CONCENTRATION_LIMITS' : eligible.length ? 'MIGRATION_PROPOSED' : 'NO_VERIFIED_DESTINATION',
    selected: eligible[0] ?? null, candidates, executionEnabled: false,
    objective: 'Reduce verified market/collateral concentration under policy constraints; this is not an expected-profit optimizer or a probability of failure.',
    assumptions: ['Static proportional source/destination allocations during migration; large deposits may alter them.', 'Snapshot data are checked independently; no atomic cross-vault snapshot is claimed.', 'No mainnet transaction or permission is created.']
  };
}
