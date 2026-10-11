import { z } from 'zod';
import { addressSchema, rawInteger } from '../connectors/morpho.js';
import type { LiveSnapshot } from './types.js';

const text = z.string().max(4000);
const id = z.string().min(1).max(800);
const date = z.string().datetime();
const chain = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const evidence = z.object({
  status: z.enum(['verified', 'inferred', 'unresolved']),
  sourceType: z.enum(['onchain_call', 'protocol_api', 'verified_source', 'documentation']),
  reference: text.min(1), observedAt: date, chainId: chain.optional(), blockNumber: rawInteger.optional(),
  notes: text.optional(), sourcePath: text.optional(), blockTimestamp: date.optional(),
  verification: z.enum(['api_indexed', 'onchain_verified', 'documentation_only']).optional()
});
const schema = z.object({
  schemaVersion: z.literal('1.0'), snapshotId: id, mode: z.enum(['live', 'historical_replay']), observedAt: date,
  chainId: chain, blockNumber: rawInteger.nullable(), blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(), blockTimestamp: date.nullable(),
  rootPositionId: id, rootPositionUsd: z.null(), protocol: text,
  nodes: z.array(z.object({ id, label: text, kind: z.enum(['position', 'vault', 'lending_market', 'asset', 'oracle', 'yield_source', 'issuer', 'amm', 'chain', 'bridge', 'administrator', 'contract', 'exit_route', 'protocol']), chainId: chain.optional(), address: addressSchema.optional(), metadata: z.record(z.string().max(100), z.union([text, z.number().finite(), z.boolean(), z.null()])).optional() })).min(1).max(1000),
  edges: z.array(z.object({ id, from: id, to: id, kind: z.enum(['HOLDS_SHARES_IN', 'ALLOCATES_TO', 'USES_ORACLE', 'ACCEPTS_COLLATERAL', 'ACCOUNTING_ASSET', 'BACKED_BY', 'EARNS_YIELD_FROM', 'SETTLES_ON', 'CONTROLLED_BY', 'UPGRADEABLE_BY', 'BRIDGED_BY', 'EXITS_THROUGH', 'USES_CONTRACT', 'CLAIM_ON', 'WRAPS', 'PRICED_IN', 'USES_PRICE_FEED', 'USES_AMM', 'TRADED_ON']), evidence, corroboration: z.array(evidence).max(50).optional(), role: text.optional() })).max(3000),
  observations: z.array(z.object({ entityId: id, metric: text, value: z.union([text, z.number().finite(), z.boolean(), z.null()]), units: text.optional(), evidence, derived: z.boolean().optional() })).max(10000),
  exposures: z.array(z.object({ marketId: id, vaultId: id, assets: rawInteger, fraction: z.number().finite().min(0).max(1).nullable(), evidence, path: z.array(id).min(2).max(30) })).max(1000),
  unknowns: z.array(z.object({ entityId: id, category: text, reason: text })).max(5000),
  providerStatus: z.array(z.object({ provider: text, status: z.enum(['ok', 'degraded', 'unavailable', 'not_configured']), observedAt: date, blockNumber: rawInteger.optional(), message: text.optional() })).max(20),
  coverage: z.record(z.string().max(100), z.enum(['verified', 'partial', 'unresolved', 'not_applicable'])),
  sourceHierarchy: z.array(text).max(20), assumptions: z.array(text).max(100)
});

/** Importing preserves acquisition times. Validation checks consistency, not source authenticity. */
export function loadReplay(input: unknown): LiveSnapshot {
  const parsed = schema.parse(input);
  const nodes = new Map(parsed.nodes.map(node => [node.id, node]));
  const edges = new Set(parsed.edges.map(edge => edge.id));
  if (nodes.size !== parsed.nodes.length || edges.size !== parsed.edges.length || !nodes.has(parsed.rootPositionId)) throw new Error('INVALID_REPLAY_IDENTITIES');
  for (const node of parsed.nodes) {
    if (node.address && (node.chainId !== parsed.chainId || node.id !== `eip155:${parsed.chainId}:${node.address}`)) throw new Error('INVALID_REPLAY_NETWORK');
  }
  for (const edge of parsed.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error('INVALID_REPLAY_EDGE');
    if (edge.evidence.chainId !== undefined && edge.evidence.chainId !== parsed.chainId) throw new Error('INVALID_REPLAY_NETWORK');
  }
  for (const observation of parsed.observations) if (!nodes.has(observation.entityId) && !edges.has(observation.entityId)) throw new Error('INVALID_REPLAY_OBSERVATION');
  for (const entry of parsed.exposures) {
    if (nodes.get(entry.marketId)?.kind !== 'lending_market' || nodes.get(entry.vaultId)?.kind !== 'vault' || entry.path[0] !== entry.vaultId || entry.path.at(-1) !== entry.marketId) throw new Error('INVALID_REPLAY_EXPOSURE');
    for (let i = 1; i < entry.path.length; i++) if (!parsed.edges.some(edge => edge.from === entry.path[i - 1] && edge.to === entry.path[i] && edge.kind === 'ALLOCATES_TO')) throw new Error('INVALID_REPLAY_EXPOSURE_PATH');
  }
  return { ...parsed, snapshotId: `replay:${parsed.snapshotId}`.slice(0, 800), mode: 'historical_replay',
    assumptions: [...parsed.assumptions, 'Imported recording; schema checks do not independently authenticate provider evidence. Historical stress testing is not an observed incident outcome.'] };
}
