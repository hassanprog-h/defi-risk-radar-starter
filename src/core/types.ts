/** Domain interfaces. Addresses and numbers in fixture are illustrative. */
export type NodeKind =
  | "position" | "vault" | "lending_market" | "asset" | "yield_source"
  | "issuer" | "oracle" | "amm" | "chain" | "bridge" | "contract"
  | "administrator" | "protocol" | "exit_route";

export type EdgeKind =
  | "HOLDS_SHARES_IN" | "ALLOCATES_TO" | "USES_ORACLE" | "ACCEPTS_COLLATERAL"
  | "ACCOUNTING_ASSET" | "BACKED_BY" | "EARNS_YIELD_FROM"
  | "SETTLES_ON" | "CONTROLLED_BY" | "UPGRADEABLE_BY"
  | "BRIDGED_BY" | "EXITS_THROUGH" | "USES_CONTRACT";

export type EvidenceStatus = "verified" | "inferred" | "unresolved";

export interface Evidence {
  status: EvidenceStatus;
  sourceType: "onchain_call" | "protocol_api" | "verified_source" | "documentation" | "fixture";
  reference: string;
  observedAt: string;
  chainId?: number;
  blockNumber?: string;
  notes?: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  chainId?: number;
  address?: string;
}

export interface GraphEdge {
  id: string;
  from: string; // The dependent component
  to: string;   // The dependency
  kind: EdgeKind;
  allocationBps?: number; // Only for capital-allocation edges; 10,000 = 100%
  evidence: Evidence;
}

export interface GraphSnapshot {
  snapshotId: string;
  rootPositionId: string;
  rootPositionUsd: number;
  chainId: number;
  observedAt: string;
  mode: "fixture" | "live" | "historical_replay";
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ScenarioKind = "MARKET_LOSS" | "ORACLE_STALE" | "CHAIN_OUTAGE" | "ASSET_DEPEG" | "CONTRACT_EXPLOIT" | "LIQUIDITY_SHOCK";
export interface Scenario {
  id: string;
  kind: ScenarioKind;
  targetNodeId: string;
  severityFraction?: number; // Explicit hypothetical loss severity when appropriate
  horizonHours: number;
  probabilityWithinHorizon?: number; // Explicit human-provided assumption, NOT ML confidence
}

export interface IncidentResult {
  scenarioId: string;
  affectedNodeIds: string[];
  pathsToPosition: string[][]; // Each path is dependency -> ... -> position
  incrementalLossIfStayingUsd: number | null;
  estimatedWithdrawalUnavailable: boolean;
  estimationMethod: string;
  caveats: string[];
}

export type DecisionAction = "STAY" | "EXIT" | "EXIT_UNAVAILABLE" | "INSUFFICIENT_EVIDENCE";
export interface Decision {
  action: DecisionAction;
  estimatedExpectedLossUsd: number | null;
  exitCostUsd: number | null;
  breakEvenProbability: number | null;
  explanation: string;
}
