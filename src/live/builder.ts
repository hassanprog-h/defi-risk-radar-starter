import type { Evidence, EdgeKind, GraphEdge, GraphNode, NodeKind } from '../core/types.js';
import type { Exposure, LiveSnapshot } from './types.js';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const evmId = (chainId: number, address: string) => `eip155:${chainId}:${address.toLowerCase()}`;
export function fraction(numerator: string, denominator: string) {
  const n = BigInt(numerator), d = BigInt(denominator);
  if (d === 0n || n > d || n < 0n) return null;
  return Number(n * 1_000_000_000_000n / d) / 1_000_000_000_000;
}
export class GraphBuilder {
  readonly snapshot: LiveSnapshot;
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  constructor(chainId: number, address: string) {
    const observedAt = new Date().toISOString();
    this.snapshot = {
      schemaVersion: '1.0', snapshotId: `live:${chainId}:${address}:${observedAt}`, mode: 'live', observedAt,
      chainId, blockNumber: null, blockTimestamp: null, blockHash: null, rootPositionId: evmId(chainId, address), rootPositionUsd: null,
      protocol: 'unclassified', nodes: [], edges: [], observations: [], exposures: [], unknowns: [], providerStatus: [],
      coverage: { settlement: 'unresolved', underlying: 'unresolved', issuer: 'unresolved', oracle: 'unresolved', amm: 'unresolved', lending: 'unresolved', governance: 'unresolved', exit: 'unresolved' },
      sourceHierarchy: ['pinned_onchain_contract_read', 'protocol_indexed_configuration', 'verified_contract_source', 'official_documentation', 'unverified_candidate'],
      assumptions: ['Graph connectivity alone does not establish financial loss.', 'No investor balance or USD position size is assumed.', 'Provider observations can have different block heights; mismatches are reported.', 'Discovery is bounded and cannot establish universal completeness.']
    };
  }
  node(id: string, kind: NodeKind, label: string, address?: string, metadata?: GraphNode['metadata']) {
    const previous = this.nodes.get(id);
    const upgraded = previous?.kind === 'contract' || previous?.kind === 'asset' && kind === 'vault';
    this.nodes.set(id, { ...previous, id, kind: !previous || upgraded ? kind : previous.kind, label: !previous || upgraded || previous.label.startsWith('0x') ? label : previous.label, chainId: this.snapshot.chainId, ...(address ? { address: address.toLowerCase() } : {}), metadata: { ...previous?.metadata, ...metadata } });
    if (kind === 'issuer') delete this.nodes.get(id)!.chainId;
    return id;
  }
  address(address: string, kind: NodeKind, label: string, metadata?: GraphNode['metadata']) {
    return this.node(evmId(this.snapshot.chainId, address), kind, label, address, metadata);
  }
  edge(from: string, to: string, kind: EdgeKind, evidence: Evidence, role?: string) {
    const id = `${from}|${kind}|${to}${role ? `|${role}` : ''}`;
    const previous = this.edges.get(id);
    if (!previous) this.edges.set(id, { id, from, to, kind, evidence, ...(role ? { role } : {}) });
    return this.edges.get(id)!;
  }
  api(sourcePath: string, blockNumber?: string, timestamp?: string): Evidence {
    return { status: 'verified', sourceType: 'protocol_api', verification: 'api_indexed', reference: 'https://api.morpho.org/graphql', sourcePath,
      observedAt: this.snapshot.observedAt, chainId: this.snapshot.chainId, ...(blockNumber ? { blockNumber } : {}), ...(timestamp ? { blockTimestamp: timestamp } : {}), notes: 'Indexed protocol configuration; on-chain corroboration is recorded separately.' };
  }
  onchain(address: string, signature: string): Evidence {
    return { status: 'verified', sourceType: 'onchain_call', verification: 'onchain_verified', reference: `eip155:${this.snapshot.chainId}:${address.toLowerCase()}#${signature}`,
      observedAt: this.snapshot.observedAt, chainId: this.snapshot.chainId, ...(this.snapshot.blockNumber ? { blockNumber: this.snapshot.blockNumber } : {}), ...(this.snapshot.blockTimestamp ? { blockTimestamp: this.snapshot.blockTimestamp } : {}) };
  }
  observe(entityId: string, metric: string, value: string | number | boolean | null, evidence: Evidence, units?: string, derived = false) {
    this.snapshot.observations.push({ entityId, metric, value, evidence, ...(units ? { units } : {}), ...(derived ? { derived } : {}) });
  }
  unknown(entityId: string, category: string, reason: string) {
    if (!this.snapshot.unknowns.some(item => item.entityId === entityId && item.category === category && item.reason === reason)) this.snapshot.unknowns.push({ entityId, category, reason });
  }
  expose(exposure: Exposure) { this.snapshot.exposures.push(exposure); }
  corroborate(from: string, to: string, kind: EdgeKind, evidence: Evidence, matches: boolean, role?: string) {
    const edge = this.edges.get(`${from}|${kind}|${to}${role ? `|${role}` : ''}`);
    if (!edge) return;
    if (matches) { edge.corroboration = [...(edge.corroboration ?? [edge.evidence]), evidence]; edge.evidence = evidence; }
    else { edge.evidence.status = 'unresolved'; this.unknown(from, 'provider_mismatch', `On-chain ${evidence.sourcePath ?? evidence.reference.split('#')[1]} disagrees with indexed ${kind}.`); }
  }
  finish() {
    this.snapshot.nodes = [...this.nodes.values()];
    this.snapshot.edges = [...this.edges.values()];
    for (const edge of this.snapshot.edges) if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to) || !edge.evidence.reference) throw new Error('INVALID_GRAPH');
    if (this.nodes.size > 1000 || this.edges.size > 3000) throw new Error('GRAPH_BUDGET_EXCEEDED');
    return this.snapshot;
  }
}
