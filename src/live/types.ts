import type { Evidence, GraphEdge, GraphNode } from '../core/types.js';

export interface Observation {
  entityId: string; metric: string; value: string | number | boolean | null; units?: string;
  evidence: Evidence; derived?: boolean;
}
export interface Unknown { entityId: string; category: string; reason: string; }
export interface ProviderStatus {
  provider: string; status: 'ok' | 'degraded' | 'unavailable' | 'not_configured';
  observedAt: string; blockNumber?: string; message?: string;
}
export interface Exposure {
  marketId: string; vaultId: string; assets: string; fraction: number | null;
  evidence: Evidence; path: string[];
}
export interface LiveSnapshot {
  schemaVersion: '1.0'; snapshotId: string; mode: 'live' | 'historical_replay'; observedAt: string;
  chainId: number; blockNumber: string | null; blockTimestamp: string | null; blockHash: string | null;
  rootPositionId: string; rootPositionUsd: null; protocol: string; nodes: GraphNode[]; edges: GraphEdge[];
  observations: Observation[]; exposures: Exposure[]; unknowns: Unknown[]; providerStatus: ProviderStatus[];
  coverage: Record<string, 'verified' | 'partial' | 'unresolved' | 'not_applicable'>;
  sourceHierarchy: string[]; assumptions: string[];
}
export interface RpcReader {
  anchor(blockNumber?: string): Promise<{ number: string; hash: string; timestamp: string }>;
  sameBlock(number: string, hash: string): Promise<boolean>;
  read(address: string, signature: string, args?: readonly unknown[], blockNumber?: string): Promise<unknown>;
  code(address: string, blockNumber?: string): Promise<string | undefined>;
  storage(address: string, slot: `0x${string}`, blockNumber?: string): Promise<string | undefined>;
}
export interface AdapterContext {
  rpc?: RpcReader;
  maxDepth?: number;
}
