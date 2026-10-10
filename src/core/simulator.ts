import { affectedPaths } from "./graph.js";
import type { GraphSnapshot, IncidentResult, Scenario } from "./types.js";

/**
 * Deliberately narrow baseline: only direct, verified vault->market allocations
 * have a numeric market-loss model. Other events show affected paths and UNKNOWN loss.
 * Do not convert structural dependencies into invented dollar losses.
 */
export function simulate(snapshot: GraphSnapshot, scenario: Scenario): IncidentResult {
  const paths = affectedPaths(snapshot, scenario.targetNodeId);
  const affectedNodeIds = [...new Set(paths.flat())];
  const caveats: string[] = ["Fixture/demo assumptions are not real incident forecasts."];
  let incrementalLossIfStayingUsd: number | null = null;
  let estimatedWithdrawalUnavailable = false;
  let estimationMethod = "No defensible numeric impact model implemented for this incident category";

  if (scenario.kind === "CHAIN_OUTAGE" && paths.length > 0) {
    estimatedWithdrawalUnavailable = true;
    estimationMethod = "Network operations unavailable in this hypothetical outage; monetary loss unknown";
  }

  if (scenario.kind === "MARKET_LOSS" && paths.length > 0) {
    const rate = scenario.severityFraction;
    if (rate === undefined || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      caveats.push("Missing or invalid market-loss severity assumption.");
    } else {
      const rootVaults = new Set(snapshot.edges
        .filter((e) => e.from === snapshot.rootPositionId && e.kind === "HOLDS_SHARES_IN" && e.evidence.status === "verified")
        .map((e) => e.to));
      const relevant = snapshot.edges.filter((e) => e.kind === "ALLOCATES_TO" && e.to === scenario.targetNodeId && rootVaults.has(e.from));
      const valid = relevant.length === 1 && relevant[0]?.evidence.status === "verified" && relevant[0].allocationBps !== undefined;
      if (valid) {
        const bps = relevant[0]!.allocationBps!;
        incrementalLossIfStayingUsd = snapshot.rootPositionUsd * (bps / 10000) * rate;
        estimationMethod = "Position USD * verified vault allocation * hypothetical incremental market loss fraction";
        caveats.push("Assumes position exposure is proportional to the vault allocation and losses reach depositors.");
        caveats.push("No loss-netting, recoveries, seniority effects, borrow mechanics, or overlapping paths are modelled.");
      } else {
        caveats.push("No unique verified direct vault-to-market allocation; refusing numerical estimate.");
      }
    }
  }

  if (scenario.kind === "ORACLE_STALE") caveats.push("Stale oracle alone does not imply lenders have lost money.");
  if (scenario.kind === "ASSET_DEPEG") caveats.push("Depeg exposure requires token-specific backing and redemption analysis.");
  if (scenario.kind === "CONTRACT_EXPLOIT") caveats.push("Contract exploit impact requires capital-at-risk and recovery assumptions.");
  if (scenario.kind === "LIQUIDITY_SHOCK") caveats.push("Liquidity impact requires executable withdrawal/swap quotes for position size.");

  return { scenarioId: scenario.id, affectedNodeIds, pathsToPosition: paths, incrementalLossIfStayingUsd,
    estimatedWithdrawalUnavailable, estimationMethod, caveats };
}
