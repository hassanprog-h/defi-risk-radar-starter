import type { Decision, IncidentResult, Scenario } from "./types.js";

/** Pure risk comparison, not financial advice and not a transaction executor. */
export function decide(result: IncidentResult, scenario: Scenario, exitCostUsd: number | null): Decision {
  if (result.estimatedWithdrawalUnavailable) {
    return { action: "EXIT_UNAVAILABLE", estimatedExpectedLossUsd: null, exitCostUsd, breakEvenProbability: null,
      explanation: "The simulated outage prevents immediate exit. Do not recommend an infeasible trade." };
  }
  const loss = result.incrementalLossIfStayingUsd;
  const validCost = exitCostUsd !== null && Number.isFinite(exitCostUsd) && exitCostUsd >= 0;
  const threshold = loss !== null && loss > 0 && validCost ? exitCostUsd! / loss : null;
  const p = scenario.probabilityWithinHorizon;
  const validProbability = p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1;
  if (loss === null || !validCost || !validProbability) {
    return { action: "INSUFFICIENT_EVIDENCE", estimatedExpectedLossUsd: null,
      exitCostUsd: validCost ? exitCostUsd : null, breakEvenProbability: threshold,
      explanation: "Missing numeric prospective-loss estimate, feasible exit quote, or explicitly chosen probability. Show break-even threshold instead of inventing one." };
  }
  const expectedLoss = loss * p!;
  return {
    action: expectedLoss > exitCostUsd! ? "EXIT" : "STAY",
    estimatedExpectedLossUsd: expectedLoss,
    exitCostUsd,
    breakEvenProbability: threshold,
    explanation: `Under an assumed ${(p! * 100).toFixed(1)}% event probability over ${scenario.horizonHours} hours, expected incremental stay loss is $${expectedLoss.toFixed(2)} versus exit cost $${exitCostUsd!.toFixed(2)}. This is a simplified scenario comparison, not a forecast.`
  };
}
