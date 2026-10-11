export interface MigrationIntent {
  chainId: number; source: string; destination: string; asset: string; owner: string; receiver: string;
  shares: string; minAssets: string; minDestinationShares: string; createdAt: string; expiresAt: string;
}
export interface PermissionPolicy {
  mode: 'local_fork_only'; chainId: number; owner: string; source: string; destinations: string[]; asset: string;
  maxSharesPerMove: string; maxCumulativeShares: string; usedShares: string; validUntil: string;
  revoked: boolean; cooldownSeconds: number; lastExecutionAt: string | null;
}
const validAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
const raw = (s: string) => typeof s === 'string' && /^\d{1,78}$/.test(s);
export function authorizeMigration(intent: MigrationIntent, policy: PermissionPolicy, now = Date.now()) {
  const deny = (reason: string) => ({ allowed: false, reason });
  if (policy.mode !== 'local_fork_only') return deny('LIVE_EXECUTION_DISABLED');
  if (policy.revoked) return deny('PERMISSION_REVOKED');
  const created = Date.parse(intent.createdAt), expires = Date.parse(intent.expiresAt), validUntil = Date.parse(policy.validUntil);
  if (![created, expires, validUntil].every(Number.isFinite) || created > now || now >= expires || expires - created > 60_000 || now >= validUntil) return deny('EXPIRED_OR_INVALID_PERMISSION');
  if (!Number.isSafeInteger(intent.chainId) || intent.chainId !== policy.chainId) return deny('CHAIN_MISMATCH');
  if (![intent.source, intent.destination, intent.asset, intent.owner, intent.receiver, policy.source, policy.asset, policy.owner, ...policy.destinations].every(validAddress)) return deny('INVALID_ADDRESS');
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(intent.owner, policy.owner) || !same(intent.receiver, policy.owner)) return deny('OWNER_OR_RECEIVER_MISMATCH');
  if (!same(intent.source, policy.source) || !same(intent.asset, policy.asset) || !policy.destinations.some(d => same(d, intent.destination)) || same(intent.source, intent.destination)) return deny('DESTINATION_OR_ASSET_NOT_ALLOWED');
  if (![intent.shares, intent.minAssets, intent.minDestinationShares, policy.maxSharesPerMove, policy.maxCumulativeShares, policy.usedShares].every(raw)) return deny('INVALID_AMOUNT');
  if (BigInt(intent.shares) <= 0n || BigInt(intent.minAssets) <= 0n || BigInt(intent.minDestinationShares) <= 0n || BigInt(intent.shares) > BigInt(policy.maxSharesPerMove) || BigInt(intent.shares) + BigInt(policy.usedShares) > BigInt(policy.maxCumulativeShares)) return deny('AMOUNT_LIMIT');
  if (!Number.isFinite(policy.cooldownSeconds) || policy.cooldownSeconds < 0) return deny('INVALID_COOLDOWN');
  if (policy.lastExecutionAt !== null && (!Number.isFinite(Date.parse(policy.lastExecutionAt)) || now - Date.parse(policy.lastExecutionAt) < policy.cooldownSeconds * 1000)) return deny('COOLDOWN');
  return { allowed: true, reason: 'LOCAL_FORK_POLICY_ACCEPTED' };
}
