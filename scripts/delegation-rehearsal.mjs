import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { decodeErrorResult, encodeFunctionData, maxUint256, parseAbi, zeroHash } from 'viem';
import { prepareSafeProposal } from '../dist/automation/proposal.js';
import { ETHEREUM_BUNDLER3, ETHEREUM_GENERAL_ADAPTER1, adapterAbi, bundlerAbi, erc20Abi } from '../dist/automation/safe-batch.js';
import { QUOTA_KEY, ROLE_KEY, buildDelegationSetup, botCalls, rolesAbi, safeModuleAbi } from '../dist/automation/delegation.js';
import { ReadOnlyRpc } from '../dist/connectors/rpc.js';
import { startFork } from './anvil-fork.mjs';
import './live-config.mjs'; // loads .env

// Local-only actors on the private fork. Neither has a key; Anvil impersonation stands in for signatures.
const BOT = '0x000000000000000000000000000000000000b07b';
const OUTSIDER = '0x0000000000000000000000000000000000bad001';
// Errors and Status enum from the deployed Roles v2 source (PermissionChecker.sol, Roles.sol).
const rolesErrors = parseAbi(['error NoMembership()', 'error ConditionViolation(uint8 status, bytes32 info)', 'error ModuleTransactionFailed()', 'error FunctionSignatureTooShort()', 'error NotAuthorized(address sender)']);
const STATUS = ['Ok', 'DelegateCallNotAllowed', 'TargetAddressNotAllowed', 'FunctionNotAllowed', 'SendNotAllowed', 'OrViolation', 'NorViolation', 'ParameterNotAllowed', 'ParameterLessThanAllowed', 'ParameterGreaterThanAllowed', 'ParameterNotAMatch', 'NotEveryArrayElementPasses', 'NoArrayElementPasses', 'ParameterNotSubsetOfAllowed', 'BitmaskOverflow', 'BitmaskNotAllowed', 'CustomConditionViolation', 'AllowanceExceeded', 'CallAllowanceExceeded', 'EtherAllowanceExceeded'];
// Same argument types as erc4626Redeem: only the pinned selector distinguishes them.
const withdrawAbi = parseAbi(['function erc4626Withdraw(address vault, uint256 assets, uint256 minSharePriceE27, address receiver, address owner)']);
const readAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);

/** Setup as the Safe, one bounded bot migration, then an attack suite that must all revert. Fork only. */
export async function rehearseDelegation({ source, destinations, safe, shares, moveFraction, toleranceBps, outsiderDestination = source }) {
  // Default outsider: the source vault itself, which is never on the destination allowlist.
  if (destinations.some(d => d.toLowerCase() === outsiderDestination.toLowerCase())) throw new Error('INVALID_OUTSIDER');
  if (!process.env.ETHEREUM_RPC_URL) throw new Error('ETHEREUM_RPC_NOT_CONFIGURED');
  const rpc = new ReadOnlyRpc(process.env.ETHEREUM_RPC_URL, 1, 200);
  const proposal = await prepareSafeProposal({ rpc, chainId: 1, source, destination: destinations[0], safe, shares, moveFraction, toleranceBps });
  const amount = BigInt(proposal.sizing.shares);
  const setup = buildDelegationSetup({ chainId: 1, safe, bot: BOT, source, destinations, quotaShares: amount, createdAt: Date.now() });
  const fork = await startFork(proposal.anchor.number);
  const { client, send, impersonate, snapshot, revert } = fork;
  const asset = proposal.asset.address, destination = destinations[0];
  const read = (address, fn, args = []) => client.readContract({ address, abi: readAbi, functionName: fn, args });
  const exec = (from, call) => send(from, setup.module, encodeFunctionData({ abi: rolesAbi, functionName: 'execTransactionWithRole', args: [call.to, 0n, call.data, 0, ROLE_KEY, true] }));
  const approveCall = (spender, value) => ({ to: source, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, value] }) });
  const step = (to, data) => ({ to: ETHEREUM_GENERAL_ADAPTER1, data, value: 0n, skipRevert: false, callbackHash: zeroHash });
  const redeemData = (receiver = ETHEREUM_GENERAL_ADAPTER1) => encodeFunctionData({ abi: adapterAbi, functionName: 'erc4626Redeem', args: [source, amount, BigInt(proposal.bounds.minRedeemPriceE27), receiver, safe] });
  const depositData = (vault = destination, assets = maxUint256, receiver = safe) => encodeFunctionData({ abi: adapterAbi, functionName: 'erc4626Deposit', args: [vault, assets, BigInt(proposal.bounds.maxDepositPriceE27), receiver] });
  const multicall = steps => ({ to: ETHEREUM_BUNDLER3, data: encodeFunctionData({ abi: bundlerAbi, functionName: 'multicall', args: [steps] }) });
  try {
    // 1. One-time setup, executed as the Safe (on mainnet: one MultiSend batch signed by the Safe owners).
    await impersonate(safe);
    const setupReceipts = [];
    for (const call of setup.calls) {
      const receipt = await send(safe, call.to, call.data);
      setupReceipts.push({ label: call.label, ...receipt });
      if (receipt.status !== 'success') return { status: 'SETUP_FAILED', failedAt: call.label, setupReceipts, mode: 'LOCAL_FORK_ONLY' };
    }
    const moduleEnabled = await client.readContract({ address: safe, abi: safeModuleAbi, functionName: 'isModuleEnabled', args: [setup.module] });
    const [moduleAvatar, moduleOwner] = await Promise.all([
      client.readContract({ address: setup.module, abi: rolesAbi, functionName: 'avatar' }), client.readContract({ address: setup.module, abi: rolesAbi, functionName: 'owner' })
    ]);
    if (!moduleEnabled || moduleAvatar.toLowerCase() !== safe.toLowerCase() || moduleOwner.toLowerCase() !== safe.toLowerCase()) return { status: 'SETUP_NOT_VERIFIED', setupReceipts, mode: 'LOCAL_FORK_ONLY' };
    await impersonate(BOT); await impersonate(OUTSIDER);

    // 2. Attacks that must revert. Each runs from a clean snapshot; multicall attacks first make a valid approval.
    const approveFirst = async () => { await exec(BOT, approveCall(ETHEREUM_GENERAL_ADAPTER1, amount)); };
    const attacks = {
      outsiderWithoutRole: async () => [OUTSIDER, approveCall(ETHEREUM_GENERAL_ADAPTER1, amount)],
      approveToBot: async () => [BOT, approveCall(BOT, amount)],
      approveAboveQuota: async () => [BOT, approveCall(ETHEREUM_GENERAL_ADAPTER1, amount + 1n)],
      redeemWithoutDeposit: async () => { await approveFirst(); return [BOT, multicall([step(0, redeemData())])]; },
      redeemToBot: async () => { await approveFirst(); return [BOT, multicall([step(0, redeemData(BOT)), step(0, depositData())])]; },
      depositForBot: async () => { await approveFirst(); return [BOT, multicall([step(0, redeemData()), step(0, depositData(destination, maxUint256, BOT))])]; },
      partialDeposit: async () => { await approveFirst(); return [BOT, multicall([step(0, redeemData()), step(0, depositData(destination, 1n))])]; },
      destinationNotAllowlisted: async () => { await approveFirst(); return [BOT, multicall([step(0, redeemData()), step(0, depositData(outsiderDestination))])]; },
      sameShapeOtherFunction: async () => { await approveFirst(); return [BOT, multicall([step(0, encodeFunctionData({ abi: withdrawAbi, functionName: 'erc4626Withdraw', args: [source, 1n, 0n, ETHEREUM_GENERAL_ADAPTER1, safe] })), step(0, depositData())])]; },
      extraThirdCall: async () => { await approveFirst(); return [BOT, multicall([step(0, redeemData()), step(0, depositData()), step(0, depositData())])]; }
    };
    // A "block" only counts when the Roles permission check itself refuses (not an inner protocol revert).
    const reason = async (from, call) => {
      const data = encodeFunctionData({ abi: rolesAbi, functionName: 'execTransactionWithRole', args: [call.to, 0n, call.data, 0, ROLE_KEY, true] });
      try { await client.call({ account: from, to: setup.module, data }); return 'NOT_BLOCKED'; }
      catch (error) {
        let raw = error; while (raw && !raw.data && raw.cause) raw = raw.cause;
        try {
          const decoded = decodeErrorResult({ abi: rolesErrors, data: raw?.data });
          if (decoded.errorName === 'NoMembership') return 'BLOCKED_BY_ROLE: NoMembership';
          if (decoded.errorName === 'NotAuthorized') return 'BLOCKED_BY_ROLE: NotAuthorized (not an enabled member)';
          if (decoded.errorName === 'ConditionViolation') return `BLOCKED_BY_ROLE: ${STATUS[Number(decoded.args[0])] ?? decoded.args[0]}`;
          return `INNER_REVERT: ${decoded.errorName}`;
        } catch { return 'UNKNOWN_REVERT'; }
      }
    };
    const attackResults = {};
    for (const [name, attack] of Object.entries(attacks)) {
      const id = await snapshot();
      const [from, call] = await attack();
      attackResults[name] = await reason(from, call);
      const receipt = await exec(from, call);
      if (receipt.status !== 'reverted') attackResults[name] = 'NOT_BLOCKED';
      await revert(id);
    }

    // 3. The legitimate migration, executed by the bot within its role.
    const before = await Promise.all([read(source, 'balanceOf', [safe]), read(destination, 'balanceOf', [safe]), read(asset, 'balanceOf', [safe]), read(asset, 'balanceOf', [ETHEREUM_GENERAL_ADAPTER1])]);
    const migrationReceipts = [];
    for (const call of botCalls(setup.module, proposal.calls)) {
      const receipt = await send(BOT, call.to, call.data);
      migrationReceipts.push({ label: call.label, ...receipt });
      if (receipt.status !== 'success') return { status: 'BOT_MIGRATION_FAILED', failedAt: call.label, attackResults, setupReceipts, migrationReceipts, mode: 'LOCAL_FORK_ONLY' };
    }
    const after = await Promise.all([read(source, 'balanceOf', [safe]), read(destination, 'balanceOf', [safe]), read(asset, 'balanceOf', [safe]), read(asset, 'balanceOf', [ETHEREUM_GENERAL_ADAPTER1]), read(source, 'allowance', [safe, ETHEREUM_GENERAL_ADAPTER1])]);
    const minted = after[1] - before[1];
    const quota = await client.readContract({ address: setup.module, abi: rolesAbi, functionName: 'allowances', args: [QUOTA_KEY] });

    // 4. After the move: quota exhausted, then revocation by the Safe.
    const quotaExhausted = (await exec(BOT, approveCall(ETHEREUM_GENERAL_ADAPTER1, 1n))).status === 'reverted';
    const revoke = await send(safe, setup.module, encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [BOT, [ROLE_KEY], [false]] }));
    const blockedAfterRevoke = (await exec(BOT, approveCall(ETHEREUM_GENERAL_ADAPTER1, 0n))).status === 'reverted';

    const checks = {
      moduleEnabledAndOwnedBySafe: true,
      everyAttackBlockedByRole: Object.values(attackResults).every(v => v.startsWith('BLOCKED_BY_ROLE')),
      botMovedExactShares: before[0] - after[0] === amount,
      destinationSharesAtLeastFloor: minted >= BigInt(proposal.previews.destinationShares) * BigInt(10000 - proposal.bounds.toleranceBps) / 10000n,
      safeUnderlyingUnchanged: after[2] === before[2],
      adapterLeftEmpty: after[3] === before[3],
      allowanceResetToZero: after[4] === 0n,
      quotaConsumed: quota[3] === 0n,
      quotaExhaustedBlocksMore: quotaExhausted,
      revocationByOwnerWorks: revoke.status === 'success' && blockedAfterRevoke
    };
    return {
      status: Object.values(checks).every(Boolean) ? 'REHEARSAL_PASSED' : 'REHEARSAL_FAILED', mode: 'LOCAL_FORK_ONLY', executionChainId: 31337, forkBlock: proposal.anchor.number,
      safe: proposal.safe, bot: BOT, module: setup.module, quotaShares: setup.quotaShares, periodSeconds: setup.periodSeconds, destinations,
      checks, attackResults, setupReceipts, migrationReceipts,
      result: { sharesMoved: amount.toString(), destinationSharesMinted: minted.toString(), previewAssets: proposal.previews.assets },
      setupBatch: setup.batch,
      caveats: [
        'Fork rehearsal only. The bot address is a local placeholder without a key; no mainnet transaction, permission or module is created.',
        'The setup batch is unsigned. On mainnet the Safe owners would review and sign it once; the bot would then need its own key and operator, which this project does not run.',
        'The three bot calls are separate transactions; a dangling adapter approval is harmless because Bundler3 only redeems the initiator\'s own shares.',
        'Price floors are chosen by the bot and are not constrained by the role; the quota bounds what it can move.'
      ]
    };
  } finally { fork.stop(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  try {
    const [source, safe, ...destinations] = positional;
    if (!source || !safe || !destinations.length) throw new Error('Usage: npm run rehearse:delegation -- <source-vault> <safe> <allowed-destination...> (--fraction 0..1 | --shares RAW) [--outsider <non-allowlisted-vault>]');
    const fraction = flag('--fraction');
    const report = await rehearseDelegation({ source, safe, destinations, shares: flag('--shares'), moveFraction: fraction === undefined ? undefined : Number(fraction), ...(flag('--outsider') ? { outsiderDestination: flag('--outsider') } : {}) });
    const out = resolve('.radar/delegation');
    await mkdir(out, { recursive: true });
    const reportPath = resolve(out, `rehearsal-${report.forkBlock ?? 'failed'}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    if (report.setupBatch) await writeFile(resolve(out, `delegation-setup-${report.forkBlock}.json`), JSON.stringify(report.setupBatch, null, 2));
    console.log(JSON.stringify({ status: report.status, forkBlock: report.forkBlock, module: report.module, checks: report.checks, attacks: report.attackResults, failedAt: report.failedAt, report: reportPath }, null, 2));
    if (report.status !== 'REHEARSAL_PASSED') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ error: error.message?.startsWith('Usage:') ? error.message : /^[A-Z_]+(:.*)?$/.test(error.message ?? '') ? error.message : 'REHEARSAL_UNAVAILABLE' }));
    process.exitCode = 1;
  }
}
