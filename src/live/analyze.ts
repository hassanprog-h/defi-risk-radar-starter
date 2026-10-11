import { traceAffectedPaths } from '../core/graph.js';
import type { Decision, IncidentResult, Scenario } from '../core/types.js';
import type { LiveSnapshot } from './types.js';

export interface ExitAssessment {
  feasible: boolean | null; fullExit: boolean | null; quotedAt: string | null; sourceBlock: string | null;
  costUsd: number | null; owner?: string; shares?: string; maxWithdrawAssets?: string; previewAssets?: string;
  gasUnits?: string; gasPriceWei?: string; gasCostEth?: string; feeAssets?: string; assetPriceUsd?: number;
  positionValueUsd?: number;
  reasons: string[]; evidence: unknown[];
}
export interface AnalysisContext { positionUsd: number | null; exit?: ExitAssessment; assumedExitCostUsd?: number | null; }
export function analyzeLive(snapshot: LiveSnapshot, scenario: Scenario, context: AnalysisContext) {
  if (!snapshot.nodes.some(node => node.id === scenario.targetNodeId)) throw new Error('UNKNOWN_SCENARIO_TARGET');
  if (!Number.isFinite(scenario.horizonHours) || scenario.horizonHours < 1) throw new Error('INVALID_SCENARIO_HORIZON');
  const p = scenario.probabilityWithinHorizon;
  if (p !== undefined && (!Number.isFinite(p) || p < 0 || p > 1)) throw new Error('INVALID_PROBABILITY');
  const size = context.positionUsd;
  if (size !== null && (!Number.isFinite(size) || size < 0)) throw new Error('INVALID_POSITION_VALUE');
  const traversal = traceAffectedPaths(snapshot, scenario.targetNodeId);
  const paths = traversal.paths;
  const caveats = [...snapshot.assumptions];
  let loss: number | null = null;
  let exposureUsd: number | null = null;
  let method = 'No validated monetary propagation model for this failure category';
  const replay = snapshot.mode === 'historical_replay';
  const blockers = snapshot.unknowns.filter(item => ['accounting', 'provider_mismatch', 'reorg', 'snapshot_consistency', 'traversal', ...(replay ? [] : ['freshness'])].includes(item.category));
  if (traversal.truncated) blockers.push({ entityId: scenario.targetNodeId, category: 'traversal', reason: 'Affected-path traversal budget reached; impact coverage is incomplete.' });
  const age = Date.now() - Date.parse(snapshot.observedAt);
  if (!Number.isFinite(age) || age < -60_000 || !replay && age > 5 * 60_000) blockers.push({ entityId: snapshot.rootPositionId, category: 'freshness', reason: 'Inspection timestamp is invalid, in the future, or older than five minutes.' });
  if (scenario.kind === 'MARKET_LOSS') {
    const severity = scenario.severityFraction;
    if (severity === undefined || !Number.isFinite(severity) || severity < 0 || severity > 1) throw new Error('INVALID_MARKET_LOSS_SEVERITY');
    const entries = snapshot.exposures.filter(entry => entry.marketId === scenario.targetNodeId && entry.vaultId === snapshot.rootPositionId);
    const sum = entries.reduce((total, entry) => total + (entry.fraction ?? 0), 0);
    const uniquePaths = new Set(entries.map(entry => entry.path.join('|')));
    const allRoot = snapshot.exposures.filter(entry => entry.vaultId === snapshot.rootPositionId);
    const total = allRoot.reduce((acc, entry) => acc + (entry.fraction ?? 0), 0);
    const sound = entries.length > 0 && entries.every(entry => entry.fraction !== null && entry.evidence.status === 'verified') && uniquePaths.size === entries.length && sum <= 1 && total <= 1.00000000001 && blockers.length === 0;
    if (size !== null && sound) {
      exposureUsd = size * sum;
      loss = exposureUsd * severity;
      method = 'User-specified USD position × observed deployed market fraction × assumed additional lender-loss fraction';
      caveats.push('Assumes proportional vault-share exposure, unchanged allocations, and losses passed to shareholders. No recoveries, seniority or reallocation model.');
    } else caveats.push('Missing position size, incomplete exposure accounting, stale data, or inconsistent observations prevent a dollar estimate.');
  } else if (scenario.kind === 'CONTRACT_EXPLOIT' && scenario.targetNodeId === snapshot.rootPositionId) {
    const severity = scenario.severityFraction;
    const totalAssets = snapshot.observations.find(item => item.entityId === snapshot.rootPositionId && item.metric === 'totalAssets');
    if (severity === undefined || !Number.isFinite(severity) || severity < 0 || severity > 1) throw new Error('INVALID_EXPLOIT_SEVERITY');
    if (size !== null && typeof totalAssets?.value === 'string' && BigInt(totalAssets.value) > 0n && !blockers.length) {
      exposureUsd = size;
      loss = size * severity;
      method = 'Direct vault-capital stress: assumed additional unrecovered shareholder haircut × specified position USD value';
      caveats.push('Severity is an assumed net loss of vault shareholder capital, not a vulnerability finding or an exploit forecast. Includes no recovery, insurance or mitigation.');
    }
  } else {
    const relevant = snapshot.exposures.filter(entry => paths.some(path => path.includes(entry.marketId)) && entry.vaultId === snapshot.rootPositionId);
    const markets = new Map<string, number>();
    for (const entry of relevant) if (entry.fraction !== null) markets.set(entry.marketId, (markets.get(entry.marketId) ?? 0) + entry.fraction);
    const share = [...markets.values()].reduce((sum, value) => sum + value, 0);
    if (size !== null && share <= 1 && !blockers.length) exposureUsd = size * share;
    caveats.push('Affected exposure is not modelled loss. Oracle, collateral, administrator and chain links do not establish a lender haircut.');
  }
  const blocked = scenario.kind === 'CHAIN_OUTAGE' && paths.length > 0;
  const incident: IncidentResult = {
    scenarioId: scenario.id, affectedNodeIds: [...new Set(paths.flat())], pathsToPosition: paths,
    incrementalLossIfStayingUsd: loss, estimatedWithdrawalUnavailable: blocked,
    estimationMethod: method, caveats
  };
  const exit = context.exit;
  const cost = exit?.costUsd ?? null;
  const quoteAge = exit?.quotedAt ? Date.now() - Date.parse(exit.quotedAt) : NaN;
  const freshQuote = Number.isFinite(quoteAge) && quoteAge >= 0 && quoteAge < 60_000;
  const threshold = cost !== null && loss !== null && loss > 0 ? cost / loss : null;
  let decision: Decision = { action: 'INSUFFICIENT_EVIDENCE', estimatedExpectedLossUsd: loss !== null && p !== undefined ? loss * p : null, exitCostUsd: cost, breakEvenProbability: threshold,
    explanation: 'A current, full feasible exit with priced costs, a supported prospective-loss model and an explicit probability are required for STAY or EXIT.' };
  if (blocked || !replay && freshQuote && exit?.feasible === false) decision = { ...decision, action: 'EXIT_UNAVAILABLE', explanation: blocked ? 'The hypothetical chain outage prevents immediate exit.' : 'The checked redemption amount is unavailable; a smaller or alternative exit has not been established.' };
  else if (!replay && loss !== null && p !== undefined && cost !== null && Number.isFinite(cost) && cost >= 0 && exit?.feasible === true && exit.fullExit === true && freshQuote && !blockers.length) decision = {
    ...decision, action: loss * p > cost ? 'EXIT' : 'STAY', explanation: `Under the user-assumed ${(p * 100).toFixed(2)}% probability over ${scenario.horizonHours} hours, additional expected loss is $${(loss * p).toFixed(2)} versus $${cost.toFixed(2)} estimated friction for the checked redemption route. Quote execution and the scenario remain uncertain.`
  };
  const assumedCost = context.assumedExitCostUsd;
  if (assumedCost !== undefined && assumedCost !== null && (!Number.isFinite(assumedCost) || assumedCost < 0)) throw new Error('INVALID_ASSUMED_EXIT_COST');
  const interpretations: Record<string, string> = {
    ALLOCATES_TO: 'Deployed capital can transmit a supported lender-loss scenario to the allocating vault.',
    USES_ORACLE: 'Pricing availability or accuracy may affect borrowing and liquidation; connectivity alone does not quantify bad debt.',
    ACCEPTS_COLLATERAL: 'Collateral value can change borrower solvency; borrower-level exposure and recovery mechanics are required for lender losses.',
    SETTLES_ON: 'Settlement failure can block contract interactions and withdrawal.',
    ACCOUNTING_ASSET: 'Asset denomination and redemption output; a USD shock needs an explicit asset-value model.',
    BACKED_BY: 'Documented issuer relationship; current solvency and recoveries require independent evidence.',
    CLAIM_ON: 'Principal redemption depends on the configured yield source and protocol redemption mechanics.',
    WRAPS: 'Wrapper conversion depends on the referenced token; conversion terms and backing must be checked.',
    USES_AMM: 'The configured market can influence pricing or execution; a real liquidity model is needed for slippage.',
    TRADED_ON: 'Associated trading venue. Pool disruption may affect liquidation or sale routes; this is not proof that the lending oracle uses the pool or that an exit is feasible.',
    CONTROLLED_BY: 'Configured authority is a control dependency; authority alone does not establish a financial haircut.'
  };
  const mechanisms = paths.map(path => ({ path, steps: path.slice(1).map((dependent, index) => {
    const dependency = path[index]!;
    return { dependent, dependency, relationships: snapshot.edges.filter(edge => edge.from === dependent && edge.to === dependency).map(edge => ({
      kind: edge.kind, evidenceStatus: edge.evidence.status, explanation: interpretations[edge.kind] ?? 'Contract reference observed; economic consequences require protocol-specific interpretation.'
    })) };
  }) }));
  return { snapshot, scenario, incident, mechanisms, decision, exposureUsd, positionUsd: size, exit: exit ?? null, blockers,
    sensitivity: loss !== null && loss > 0 && assumedCost != null ? { label: 'Hypothetical comparison using assumed exit cost; no verified exit decision', assumedExitCostUsd: assumedCost, breakEvenProbability: assumedCost / loss } : null,
    warning: `${replay ? 'HISTORICAL RECORDING' : 'LIVE DEPENDENCIES'} · HYPOTHETICAL FAILURE · Size is user-assumed unless established by a checked balance/reference valuation; event probability is an explicit assumption. No trades are executed.` };
}
