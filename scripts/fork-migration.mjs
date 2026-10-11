import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPublicClient, http, parseAbi, encodeFunctionData, encodeDeployData, parseEventLogs, formatUnits, parseUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { authorizeMigration } from '../dist/automation/policy.js';
import { JsonClient } from '../dist/connectors/http.js';
import { ReadOnlyRpc } from '../dist/connectors/rpc.js';
import { planForceLiquidity } from '../dist/automation/force-route.js';

const abi = parseAbi([
  'function asset() view returns (address)', 'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)', 'function previewDeposit(uint256) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function redeem(uint256,address,address) returns (uint256)', 'function deposit(uint256,address) returns (uint256)',
  'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)',
  'function previewWithdraw(uint256) view returns (uint256)'
]);
const address = s => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {
  const server = createServer();
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  await new Promise(r => server.close(r)); return port;
}
/** All writes are confined to a newly spawned local Anvil. No caller-selected execution RPC. */
export async function simulateMigration({ source, destination, owner, shares, positionUsd, moveFraction = 1, policy: suppliedPolicy, minOutputBps = 9950, forkBlockNumber }) {
  if (![source, destination, owner].every(address) || source.toLowerCase() === destination.toLowerCase() || !Number.isFinite(moveFraction) || moveFraction <= 0 || moveFraction > 1 || !Number.isInteger(minOutputBps) || minOutputBps < 9900 || minOutputBps > 10000) throw new Error('INVALID_MIGRATION_INPUT');
  if (shares !== undefined && (typeof shares !== 'string' || !/^\d{1,78}$/.test(shares))) throw new Error('INVALID_SHARES');
  if (forkBlockNumber !== undefined && !/^\d{1,20}$/.test(String(forkBlockNumber))) throw new Error('INVALID_FORK_BLOCK');
  if (positionUsd !== undefined && (!Number.isFinite(positionUsd) || positionUsd <= 0 || positionUsd > 1e12 || shares !== undefined)) throw new Error('INVALID_POSITION_SIZING');
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) throw new Error('ETHEREUM_RPC_NOT_CONFIGURED');
  const upstream = createPublicClient({ chain: mainnet, transport: http(rpcUrl, { retryCount: 0, timeout: 12000 }) });
  let child;
  let stopTimer;
  let stage = 'START';
  try {
    if (await upstream.getChainId() !== 1) throw new Error('RPC_CHAIN_MISMATCH');
    const anchor = await upstream.getBlock(forkBlockNumber ? { blockNumber: BigInt(forkBlockNumber) } : { blockTag: 'latest' });
    if (Number(anchor.timestamp) * 1000 < Date.now() - 900_000) throw new Error('FORK_ANCHOR_STALE');
    const port = await freePort();
    const require = createRequire(import.meta.url);
    const platform = process.platform === 'win32' ? 'win32-amd64' : `${process.platform}-${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
    const binary = require.resolve(`@foundry-rs/anvil-${platform}/bin/anvil${process.platform === 'win32' ? '.exe' : ''}`);
    // Secret URL is passed directly to the child, never shell-interpolated or logged.
    child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--fork-url', rpcUrl, '--fork-block-number', anchor.number.toString(), '--chain-id', '31337', '--no-storage-caching', '--no-cors', '--quiet', '--accounts', '0', '--threads', '2', '--timeout', '12000', '--retries', '1'], { stdio: 'ignore' });
    let spawnError = false; child.once('error', () => { spawnError = true; });
    stopTimer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    const localUrl = `http://127.0.0.1:${port}`;
    const client = createPublicClient({ transport: http(localUrl, { timeout: 45000, retryCount: 0 }) });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (spawnError || child.exitCode !== null) throw new Error('ANVIL_START_FAILED');
      try { ready = await client.getChainId() === 31337; if (ready) break; } catch {}
      await sleep(200);
    }
    if (!ready) throw new Error('ANVIL_START_TIMEOUT');
    const info = await client.request({ method: 'anvil_nodeInfo' });
    if (!info || typeof info !== 'object') throw new Error('LOCAL_FORK_NOT_VERIFIED');
    const read = (contract, fn, args = []) => client.readContract({ address: contract, abi, functionName: fn, args });
    stage = 'IDENTITY_READS';
    const [asset, destinationAsset, balance, code] = await Promise.all([read(source, 'asset'), read(destination, 'asset'), read(source, 'balanceOf', [owner]), client.getCode({ address: owner })]);
    if (asset.toLowerCase() !== destinationAsset.toLowerCase()) throw new Error('UNDERLYING_ASSET_MISMATCH');
    if (code && code !== '0x') throw new Error('CONTRACT_OWNER_NOT_SUPPORTED');
    const publicHttp = new JsonClient();
    const priceReference = async address => {
      try {
        const source = (process.env.MORPHO_API_BASE || 'https://api.morpho.org') + '/graphql';
        const body = await publicHttp.request(source, { query: 'query ForkPrice($address:String!){assetByAddress(address:$address,chainId:1){price{usd timestamp}}}', variables: { address } });
        const price = body?.data?.assetByAddress?.price;
        const age = Date.now() / 1000 - Number(price?.timestamp);
        if (!price || !Number.isFinite(price.usd) || price.usd <= 0 || !Number.isFinite(age) || age < 0 || age >= 900) return null;
        return { usd: price.usd, timestamp: String(price.timestamp), source, retrievedAt: new Date().toISOString() };
      } catch { return null; }
    };
    const decimals = Number(await read(asset, 'decimals'));
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('INVALID_ASSET_DECIMALS');
    const assetPrice = await priceReference(asset);
    let count;
    if (positionUsd !== undefined) {
      if (!assetPrice) throw new Error('SIZING_REQUIRES_FRESH_USD_PRICE');
      const desired = positionUsd * moveFraction / assetPrice.usd;
      if (!Number.isFinite(desired) || desired >= 1e21) throw new Error('POSITION_SIZING_LIMIT');
      const requestedAssets = parseUnits(desired.toFixed(Math.min(decimals, 18)), decimals);
      count = await read(source, 'previewWithdraw', [requestedAssets]);
    } else count = shares === undefined ? balance * BigInt(Math.ceil(moveFraction * 1_000_000_000)) / 1_000_000_000n : BigInt(shares);
    if (count <= 0n || count > balance) throw new Error('INSUFFICIENT_SHARES');
    stage = 'PREVIEW_READS';
    const assets = await read(source, 'previewRedeem', [count]);
    const preview = await read(destination, 'previewDeposit', [assets]);
    stage = 'LIQUIDITY_ROUTE';
    const route = await planForceLiquidity(new ReadOnlyRpc(localUrl, 31337, 600), source, asset, assets, anchor.number.toString());
    const penaltyShareBudget = route.maximumPenaltyAssets > 0n ? await read(source, 'previewWithdraw', [route.maximumPenaltyAssets + 10n]) : 0n;
    const totalShareBudget = count + penaltyShareBudget;
    if (totalShareBudget > balance) throw new Error('SHARE_BALANCE_CANNOT_COVER_ROUTE_PENALTY');
    const now = Date.now();
    const intent = { chainId: 1, source, destination, asset, owner, receiver: owner, shares: totalShareBudget.toString(), minAssets: (assets * BigInt(minOutputBps) / 10000n).toString(), minDestinationShares: (preview * BigInt(minOutputBps) / 10000n).toString(), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
    const policy = suppliedPolicy ?? { mode: 'local_fork_only', chainId: 1, source, asset, owner, destinations: [destination], maxSharesPerMove: totalShareBudget.toString(), maxCumulativeShares: totalShareBudget.toString(), usedShares: '0', validUntil: new Date(now + 60_000).toISOString(), revoked: false, cooldownSeconds: 300, lastExecutionAt: null };
    const check = () => { const auth = authorizeMigration(intent, policy); if (!auth.allowed) throw new Error(auth.reason); };
    check();
    if (assets <= 0n || preview <= 0n) throw new Error('ZERO_PREVIEW');
    const [assetBefore, destBefore, originalAllowance] = await Promise.all([read(asset, 'balanceOf', [owner]), read(destination, 'balanceOf', [owner]), read(asset, 'allowance', [owner, destination])]);
    if (originalAllowance !== 0n) throw new Error('EXISTING_ALLOWANCE_REQUIRES_SEPARATE_POLICY');
    await client.request({ method: 'anvil_impersonateAccount', params: [owner] });
    await client.request({ method: 'anvil_setBalance', params: [owner, '0x56bc75e2d63100000'] }); // local gas funds only
    const checkpoint = await client.request({ method: 'evm_snapshot' });
    const receipts = [];
    const currentMainnetGasPrice = await upstream.getGasPrice();
    const forkBaseFee = (await client.getBlock()).baseFeePerGas ?? 0n;
    // Remote fees may fall while a cold fork loads state. A legacy transaction must
    // still cover the pinned fork's base fee; report this conservative floor.
    const gasPrice = currentMainnetGasPrice > forkBaseFee ? currentMainnetGasPrice : forkBaseFee;
    const sendData = async (contract, data, operation, account = owner) => {
      stage = operation.toUpperCase();
      check();
      if (await client.getChainId() !== 31337) throw new Error('LOCAL_CHAIN_CHANGED');
      const gas = await client.estimateGas({ account, ...(contract ? { to: contract } : {}), data });
      const hash = await client.request({ method: 'eth_sendTransaction', params: [{ from: account, ...(contract ? { to: contract } : {}), data, gas: `0x${(gas * 120n / 100n).toString(16)}`, gasPrice: `0x${gasPrice.toString(16)}` }] });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 45000, pollingInterval: 100 });
      if (receipt.status !== 'success') throw new Error('LOCAL_TRANSACTION_REVERTED');
      receipts.push({ operation, hash, gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(), gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() });
      return receipt;
    };
    try {
      const artifact = JSON.parse(await readFile(new URL('../contracts/artifacts/ForkPolicyMigrator.json', import.meta.url), 'utf8'));
      const content = await readFile(new URL('../contracts/ForkPolicyMigrator.sol', import.meta.url), 'utf8');
      if (createHash('sha256').update(content).digest('hex') !== artifact.sourceSha256) throw new Error('CONTRACT_ARTIFACT_STALE');
      const executor = '0x000000000000000000000000000000000000cafe';
      await client.request({ method: 'anvil_impersonateAccount', params: [executor] });
      await client.request({ method: 'anvil_setBalance', params: [executor, '0x56bc75e2d63100000'] });
      const constructorArgs = [executor, source, destination, BigInt(policy.maxSharesPerMove), BigInt(policy.maxCumulativeShares) - BigInt(policy.usedShares), BigInt(Math.floor(Date.parse(policy.validUntil) / 1000)), BigInt(policy.cooldownSeconds), BigInt(minOutputBps), route.legs.map(({ adapter, data, maxAssets, maxPenaltyWad }) => ({ adapter, data, maxAssets, maxPenaltyWad }))];
      const deployment = await sendData(null, encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: constructorArgs }), 'deploy_fork_policy');
      const migrator = deployment.contractAddress;
      if (!migrator) throw new Error('MIGRATOR_DEPLOYMENT_FAILED');
      await sendData(source, encodeFunctionData({ abi, functionName: 'approve', args: [migrator, totalShareBudget] }), 'one_time_share_permission');
      const executeData = encodeFunctionData({ abi: artifact.abi, functionName: 'execute', args: [count, BigInt(intent.minAssets), BigInt(intent.minDestinationShares)] });
      const boundaryTests = [];
      const reject = async (name, data, account = executor) => {
        let blocked = false;
        try { await client.call({ to: migrator, account, data }); } catch { blocked = true; }
        if (!blocked) throw new Error('ONCHAIN_PERMISSION_TEST_FAILED');
        boundaryTests.push({ name, passed: true });
      };
      await reject('Unauthorized caller', executeData, owner);
      await reject('Per-move amount bound', encodeFunctionData({ abi: artifact.abi, functionName: 'execute', args: [BigInt(policy.maxSharesPerMove) + 1n, 1n, 1n] }));
      await reject('Output floor and atomic rollback', encodeFunctionData({ abi: artifact.abi, functionName: 'execute', args: [count, assets + 1_000_000_000_000_000n, 1n] }));
      const permissionCheckpoint = await client.request({ method: 'evm_snapshot' });
      await sendData(migrator, encodeFunctionData({ abi: artifact.abi, functionName: 'revoke' }), 'test_revoke');
      await reject('Revoked permission', executeData);
      await client.request({ method: 'evm_revert', params: [permissionCheckpoint] });
      receipts.pop(); // revoked branch was rolled back, excluded from successful migration gas
      const expiryCheckpoint = await client.request({ method: 'evm_snapshot' });
      await client.request({ method: 'evm_increaseTime', params: [120] });
      await client.request({ method: 'evm_mine' });
      await reject('Expired permission', executeData);
      await client.request({ method: 'evm_revert', params: [expiryCheckpoint] });
      const permissionBranch = await client.request({ method: 'evm_snapshot' });
      await sendData(source, encodeFunctionData({ abi, functionName: 'approve', args: [migrator, 0n] }), 'test_revoke_allowance');
      await reject('Revoked token allowance', executeData);
      await client.request({ method: 'evm_revert', params: [permissionBranch] });
      receipts.pop();
      const migrationReceipt = await sendData(migrator, executeData, 'atomic_redeem_and_deposit', executor);
      const [sourceAfter, destAfter, assetAfter, allowanceAfter] = await Promise.all([read(source, 'balanceOf', [owner]), read(destination, 'balanceOf', [owner]), read(asset, 'balanceOf', [owner]), read(asset, 'allowance', [owner, destination])]);
      const issued = destAfter - destBefore;
      const totalDebit = balance - sourceAfter;
      if (totalDebit < count || totalDebit > totalShareBudget || issued < BigInt(intent.minDestinationShares) || assetAfter !== assetBefore || allowanceAfter !== 0n) throw new Error('POST_MIGRATION_INVARIANT_FAILED');
      const destinationValue = await read(destination, 'convertToAssets', [issued]);
      const events = parseEventLogs({ abi: artifact.abi, logs: migrationReceipt.logs.filter(log => log.address.toLowerCase() === migrator.toLowerCase()), eventName: 'Migrated' });
      if (events.length !== 1 || events[0].args.shares !== count || events[0].args.destinationShares !== issued || events[0].args.totalSharesDebited !== totalDebit) throw new Error('MIGRATION_EVENT_MISMATCH');
      const received = events[0].args.assets;
      if (destinationValue < BigInt(intent.minAssets)) throw new Error('DESTINATION_VALUE_FLOOR_VIOLATED');
      const migratorAssetBalance = await read(asset, 'balanceOf', [migrator]);
      const migratorAllowance = await read(asset, 'allowance', [migrator, destination]);
      if (migratorAssetBalance !== 0n || migratorAllowance !== 0n) throw new Error('MIGRATOR_RESIDUAL_BALANCE');
      await reject('Cumulative limit / duplicate execution', executeData);
      if ((await upstream.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) throw new Error('UPSTREAM_REORG');
      const totalGasWei = receipts.reduce((sum, r) => sum + BigInt(r.gasWei), 0n);
      const executionGasWei = receipts.filter(r => r.operation === 'atomic_redeem_and_deposit').reduce((sum, r) => sum + BigInt(r.gasWei), 0n);
      const nativePrice = await priceReference('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
      const totalGasUsd = nativePrice ? Number(formatUnits(totalGasWei, 18)) * nativePrice.usd : null;
      const executionGasUsd = nativePrice ? Number(formatUnits(executionGasWei, 18)) * nativePrice.usd : null;
      const roundingFrictionUsd = assetPrice ? Number(formatUnits(received > destinationValue ? received - destinationValue : 0n, decimals)) * assetPrice.usd : null;
      const penaltyAssets = totalDebit > count ? await read(source, 'convertToAssets', [totalDebit - count]) : 0n;
      const forcePenaltyUsd = assetPrice ? Number(formatUnits(penaltyAssets, decimals)) * assetPrice.usd : null;
      return { status: 'FORK_SIMULATION_PASSED', mode: 'LOCAL_FORK_ONLY', sourceChainId: 1, executionChainId: 31337, source, destination, owner,
        sourceBlock: anchor.number.toString(), sourceBlockHash: anchor.hash, simulatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        sharesRedeemed: count.toString(), assetsReceived: received.toString(), destinationSharesIssued: issued.toString(), destinationAssets: destinationValue.toString(),
        totalSharesDebited: totalDebit.toString(), routePenaltyShares: (totalDebit - count).toString(),
        liquidityRoute: { kind: route.legs.length ? 'MORPHO_V2_PERMISSIONLESS_FORCE_DEALLOCATE_THEN_REDEEM' : 'DIRECT_REDEMPTION',
          idleAssets: route.idleAssets.toString(), deficitAssets: route.deficitAssets.toString(), maximumPenaltyAssets: route.maximumPenaltyAssets.toString(),
          legs: route.legs.map(l => ({ ...l, maxAssets: l.maxAssets.toString(), maxPenaltyWad: l.maxPenaltyWad.toString() })) },
        permission: { mode: policy.mode, destinations: policy.destinations, maxSharesPerMove: policy.maxSharesPerMove, authorization: 'LOCAL_FORK_POLICY_ONLY_NO_WALLET_SIGNATURE' },
        intent, migrator, executor, contractSourceSha256: artifact.sourceSha256, atomicMigration: true, boundaryTests,
        receipts, totalGasWei: totalGasWei.toString(), executionGasWei: executionGasWei.toString(),
        gasPriceReference: { currentMainnetGasPriceWei: currentMainnetGasPrice.toString(), forkBaseFeeWei: forkBaseFee.toString(), appliedGasPriceWei: gasPrice.toString(), source: 'Fresh eth_gasPrice with a pinned-fork base-fee floor' },
        asset, assetDecimals: decimals, underlyingAmount: formatUnits(received, decimals), nativePrice, assetPrice,
        sizing: { source: positionUsd !== undefined ? 'USER_USD_SIZE_CONVERTED_WITH_FRESH_REFERENCE_PRICE' : shares !== undefined ? 'RAW_SHARE_AMOUNT' : 'PUBLIC_HOLDER_BALANCE_FRACTION', positionUsd: positionUsd ?? null, moveFraction },
        costs: { kind: 'FORK_STATE_MEASUREMENT_WITH_REFERENCE_PRICES', totalGasUsd, executionGasUsd,
          setupGasUsd: totalGasUsd === null || executionGasUsd === null ? null : totalGasUsd - executionGasUsd, roundingFrictionUsd, forcePenaltyUsd },
        costUsd: totalGasUsd === null || roundingFrictionUsd === null || forcePenaltyUsd === null ? null : totalGasUsd + roundingFrictionUsd + forcePenaltyUsd,
        invariants: { sharesDebitedExactly: true, outputsAboveFloor: true, underlyingBalancePreserved: true, allowanceCleared: true, recipientMatched: true, anchorUnchanged: true },
        mainnetTransactionsSent: 0,
        caveats: ['Fork-only contract enforces sender, fixed source/destination/receiver, amounts, output floors, expiry, cooldown and revocation. It refuses deployment outside chain 31337.', 'Owner impersonation and local ETH gas funding do not establish real signing authority.', 'Gas is measured on the fork at a freshly read mainnet gas price; setup costs are separate from subsequent execution. No dollar quote without a fresh native USD reference.', 'No swap: both vaults retain the same underlying and its issuer/depeg risk.'] };
    } finally { await client.request({ method: 'evm_revert', params: [checkpoint] }).catch(() => {}); }
  } catch (error) {
    const safe = typeof error?.message === 'string' && /^[A-Z][A-Z_]+$/.test(error.message);
    const names = []; let cause = error;
    let knownReason = '';
    for (let i = 0; cause && i < 6; i++, cause = cause.cause) if (/^[A-Za-z]+Error$/.test(cause.name ?? '')) names.push(cause.name);
    cause = error;
    for (let i = 0; cause && i < 6; i++, cause = cause.cause) {
      const message = String(cause.message ?? '');
      for (const [pattern, reason] of [[/fee cap.*(?:base fee|basefee)|gas price.*(?:base fee|basefee)|max fee per gas.*base fee/i, 'BASE_FEE_REJECTED'], [/insufficient funds/i, 'GAS_FUNDS_REJECTED'], [/nonce too (low|high)|nonce has already/i, 'NONCE_REJECTED'], [/exceeds block gas|gas limit.*block|intrinsic gas too low/i, 'GAS_LIMIT_REJECTED']]) if (pattern.test(message)) knownReason = reason;
      for (const reason of ['FORK_ONLY','IDENTITY','OUTPUT_FLOOR','PERMISSION','COOLDOWN','ASSET_CHANGED','MIN_ASSETS','MIN_SHARES','TOKEN_CALL','RESIDUAL_BALANCE','TOTAL_SHARE_LIMIT','ROUTE_CHANGED','ROUTE_POLICY']) if (message.includes(reason)) knownReason = reason;
    }
    throw new Error(safe ? error.message : `FORK_${stage}_UNAVAILABLE${knownReason ? ':' + knownReason : names.length ? ':' + [...new Set(names)].join('/') : ''}`);
  } finally {
    clearTimeout(stopTimer);
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(r => child.once('exit', r)), sleep(1500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}
  try {
    const [source, destination, owner, shares] = process.argv.slice(2);
    console.log(JSON.stringify(await simulateMigration({ source, destination, owner, shares }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
