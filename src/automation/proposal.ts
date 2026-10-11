import { ETHEREUM_BUNDLER3, ETHEREUM_GENERAL_ADAPTER1, buildBatchFile, buildMigrationCalls, sharePriceBounds } from './safe-batch.js';
import type { RpcReader } from '../live/types.js';

export interface SafeProposalInput {
  rpc: RpcReader; chainId: number; source: string; destination: string; safe: string;
  shares?: string; moveFraction?: number; toleranceBps?: number;
  /** Optional planReallocation() result; when given, the destination must be one of its policy candidates. */
  plan?: { sourceId: string; candidates: { destinationId: string; status: string; moveFraction: number | null }[] } | null;
  now?: number;
}
const isAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);
const lower = (value: string) => value.toLowerCase();
const raw = (value: unknown, error: string) => { if (!/^\d{1,78}$/.test(String(value))) throw new Error(error); return BigInt(String(value)); };

/** Read-only checks at one anchor block, then an unsigned batch. Never signs, sends or posts anything. */
export async function prepareSafeProposal(input: SafeProposalInput) {
  const { rpc, chainId, source, destination, safe } = input;
  const toleranceBps = input.toleranceBps ?? 50;
  const now = input.now ?? Date.now();
  if (chainId !== 1) throw new Error('UNSUPPORTED_CHAIN');
  if (![source, destination, safe].every(isAddress)) throw new Error('INVALID_ADDRESS');
  if (lower(source) === lower(destination)) throw new Error('SOURCE_EQUALS_DESTINATION');
  if (input.shares !== undefined && input.moveFraction !== undefined) throw new Error('AMBIGUOUS_SIZE');
  if (input.moveFraction !== undefined && (!Number.isFinite(input.moveFraction) || input.moveFraction <= 0 || input.moveFraction > 1)) throw new Error('INVALID_MOVE_FRACTION');

  let planFraction: number | null = null;
  if (input.plan) {
    if (input.plan.sourceId !== `eip155:${chainId}:${lower(source)}`) throw new Error('PLAN_SOURCE_MISMATCH');
    const candidate = input.plan.candidates.find(c => c.destinationId === `eip155:${chainId}:${lower(destination)}`);
    if (!candidate || candidate.status !== 'POLICY_CANDIDATE' || candidate.moveFraction === null) throw new Error('DESTINATION_NOT_PROPOSED');
    planFraction = candidate.moveFraction;
  }
  const fraction = input.moveFraction ?? planFraction;
  if (input.shares === undefined && fraction === null) throw new Error('SIZE_REQUIRED');

  const block = await rpc.anchor();
  const at = block.number;
  const read = (address: string, signature: string, args: readonly unknown[] = []) => rpc.read(address, signature, args, at);

  // The owner must be a Safe: a contract answering the Safe owner/threshold interface.
  const safeCode = await rpc.code(safe, at);
  if (!safeCode || safeCode === '0x') throw new Error('OWNER_IS_NOT_A_CONTRACT: v1 prepares atomic batches for Safe accounts only');
  let threshold: bigint, owners: string[], version: string, nonce: bigint;
  try {
    const [t, o, v, n] = await Promise.all([
      read(safe, 'function getThreshold() view returns (uint256)'), read(safe, 'function getOwners() view returns (address[])'),
      read(safe, 'function VERSION() view returns (string)'), read(safe, 'function nonce() view returns (uint256)')
    ]);
    threshold = raw(t, 'INVALID_SAFE_THRESHOLD'); nonce = raw(n, 'INVALID_SAFE_NONCE');
    if (!Array.isArray(o) || !o.every(a => isAddress(String(a)))) throw new Error();
    owners = o.map(String); version = String(v).slice(0, 32);
  } catch { throw new Error('OWNER_IS_NOT_A_SAFE: the contract does not answer the Safe owner/threshold interface'); }
  if (threshold < 1n || threshold > BigInt(owners.length) || !/^\d+\.\d+\.\d+/.test(version)) throw new Error('OWNER_IS_NOT_A_SAFE: inconsistent owner/threshold configuration');

  // Bundler3 route: adapter code exists and is linked to the published Bundler3.
  const [bundlerCode, adapterCode, linked] = await Promise.all([
    rpc.code(ETHEREUM_BUNDLER3, at), rpc.code(ETHEREUM_GENERAL_ADAPTER1, at), read(ETHEREUM_GENERAL_ADAPTER1, 'function BUNDLER3() view returns (address)')
  ]);
  if (!bundlerCode || bundlerCode === '0x' || !adapterCode || adapterCode === '0x' || lower(String(linked)) !== lower(ETHEREUM_BUNDLER3)) throw new Error('BUNDLER3_ROUTE_NOT_VERIFIED');

  // Vault identities and balances.
  const [sourceCode, destinationCode] = await Promise.all([rpc.code(source, at), rpc.code(destination, at)]);
  if (!sourceCode || sourceCode === '0x' || !destinationCode || destinationCode === '0x') throw new Error('VAULT_HAS_NO_CODE');
  let sourceAsset: string, destinationAsset: string;
  try { [sourceAsset, destinationAsset] = (await Promise.all([read(source, 'function asset() view returns (address)'), read(destination, 'function asset() view returns (address)')])).map(String) as [string, string]; }
  catch { throw new Error('NOT_AN_ERC4626_VAULT'); }
  if (!isAddress(sourceAsset) || lower(sourceAsset) !== lower(destinationAsset)) throw new Error('UNDERLYING_ASSET_MISMATCH');
  const balance = raw(await read(source, 'function balanceOf(address) view returns (uint256)', [safe]), 'INVALID_BALANCE');
  const shares = input.shares !== undefined ? raw(input.shares, 'INVALID_SHARES') : balance * BigInt(Math.floor(fraction! * 1e9)) / 1_000_000_000n;
  if (shares <= 0n) throw new Error('INSUFFICIENT_SHARES: the Safe holds no source shares for this size');
  if (shares > balance) throw new Error('INSUFFICIENT_SHARES: requested shares exceed the Safe balance');
  const existingAllowance = raw(await read(source, 'function allowance(address,address) view returns (uint256)', [safe, ETHEREUM_GENERAL_ADAPTER1]), 'INVALID_ALLOWANCE');

  // Previews define the price floors; the fork simulation is the execution ground truth.
  const previewAssets = raw(await read(source, 'function previewRedeem(uint256) view returns (uint256)', [shares]), 'INVALID_PREVIEW');
  const previewDepositShares = raw(await read(destination, 'function previewDeposit(uint256) view returns (uint256)', [previewAssets]), 'INVALID_PREVIEW');
  const bounds = sharePriceBounds({ shares, previewAssets, previewDepositShares, toleranceBps });
  let decimals: number | null = null, symbol: string | null = null;
  try { decimals = Number(await read(sourceAsset, 'function decimals() view returns (uint8)')); symbol = String(await read(sourceAsset, 'function symbol() view returns (string)')).slice(0, 32); } catch {}
  if (!await rpc.sameBlock(block.number, block.hash)) throw new Error('ANCHOR_REORGED: discard and retry');

  const calls = buildMigrationCalls({ chainId, safe, source, destination, shares, ...bounds });
  const description = `DeFi Risk Radar proposal at block ${block.number}: redeem ${shares} raw shares of ${source} and deposit the proceeds into ${destination} for this Safe. Price floors: ${toleranceBps} bps. Review every call before signing. Prepared ${new Date(now).toISOString()}.`;
  const batch = buildBatchFile({ chainId, safe, calls, name: 'DeFi Risk Radar migration', description, createdAt: now });
  const evidence = (address: string, call: string) => ({ sourceType: 'onchain_call', reference: `eip155:${chainId}:${lower(address)}#${call}`, blockNumber: block.number, blockTimestamp: block.timestamp });
  return {
    kind: 'SAFE_MIGRATION_PROPOSAL', status: 'READY_FOR_SIMULATION' as const, mode: 'unsigned_read_only',
    chainId, anchor: block, preparedAt: new Date(now).toISOString(), advisoryExpiresAt: new Date(now + 15 * 60_000).toISOString(),
    safe: { address: safe, threshold: threshold.toString(), owners, version, nonce: nonce.toString() },
    source, destination, asset: { address: sourceAsset, symbol, decimals },
    sizing: { shares: shares.toString(), safeBalance: balance.toString(), moveFraction: input.shares !== undefined ? null : fraction, linkedToPolicyPlan: planFraction !== null },
    previews: { assets: previewAssets.toString(), destinationShares: previewDepositShares.toString() },
    bounds: { toleranceBps, minRedeemPriceE27: bounds.minRedeemPriceE27.toString(), maxDepositPriceE27: bounds.maxDepositPriceE27.toString() },
    route: { bundler3: ETHEREUM_BUNDLER3, adapter: ETHEREUM_GENERAL_ADAPTER1, existingAdapterAllowance: existingAllowance.toString() },
    calls, batch,
    evidence: [
      evidence(safe, 'getThreshold(),getOwners(),VERSION(),nonce()'), evidence(ETHEREUM_GENERAL_ADAPTER1, 'BUNDLER3()'),
      evidence(source, 'asset(),balanceOf(safe),allowance(safe,adapter),previewRedeem(shares)'), evidence(destination, 'asset(),previewDeposit(assets)')
    ],
    caveats: [
      'Unsigned proposal. The Safe signers must review the decoded calls in Safe{Wallet} and decide; nothing is signed, sent or posted by this tool.',
      'No on-chain deadline: a later execution uses then-current prices; only the share-price floors are enforced on-chain.',
      'Same underlying token on both sides: issuer and depeg exposure are not removed.',
      'Previews are not guarantees. The batch must pass the local fork simulation before any file is produced.'
    ]
  };
}
export type SafeProposal = Awaited<ReturnType<typeof prepareSafeProposal>>;
