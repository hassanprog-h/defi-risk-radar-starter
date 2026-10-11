import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { buildMigrationCalls, ETHEREUM_BUNDLER3, ETHEREUM_GENERAL_ADAPTER1 } from '../dist/automation/safe-batch.js';

const abi = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)'
]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {
  const server = createServer();
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  await new Promise(r => server.close(r)); return port;
}

/**
 * Replays the proposal's three calls as the Safe on a private Anvil fork (chain 31337) pinned to the proposal block.
 * All writes stay on the local node, which is killed afterwards. Mainnet is only read through the fork.
 */
export async function simulateSafeProposal(proposal) {
  if (proposal?.kind !== 'SAFE_MIGRATION_PROPOSAL' || proposal.chainId !== 1) throw new Error('INVALID_PROPOSAL');
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) throw new Error('ETHEREUM_RPC_NOT_CONFIGURED');
  const upstream = createPublicClient({ chain: mainnet, transport: http(rpcUrl, { retryCount: 0, timeout: 12000 }) });
  const { safe, source, destination, asset } = { safe: proposal.safe.address, source: proposal.source, destination: proposal.destination, asset: proposal.asset.address };
  let child, stopTimer, stage = 'START';
  try {
    if (await upstream.getChainId() !== 1) throw new Error('RPC_CHAIN_MISMATCH');
    const remote = await upstream.getBlock({ blockNumber: BigInt(proposal.anchor.number) });
    if (remote.hash !== proposal.anchor.hash) throw new Error('ANCHOR_REORGED');
    const port = await freePort();
    const require = createRequire(import.meta.url);
    const platform = process.platform === 'win32' ? 'win32-amd64' : `${process.platform}-${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
    const binary = require.resolve(`@foundry-rs/anvil-${platform}/bin/anvil${process.platform === 'win32' ? '.exe' : ''}`);
    // The credential-bearing URL goes straight to the child process; it is never logged or returned.
    child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--fork-url', rpcUrl, '--fork-block-number', proposal.anchor.number, '--chain-id', '31337', '--no-storage-caching', '--no-cors', '--quiet', '--accounts', '0', '--timeout', '12000', '--retries', '1'], { stdio: 'ignore' });
    let spawnError = false; child.once('error', () => { spawnError = true; });
    stopTimer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    const client = createPublicClient({ transport: http(`http://127.0.0.1:${port}`, { timeout: 45000, retryCount: 0 }) });
    let ready = false;
    for (let i = 0; i < 75 && !ready; i++) {
      if (spawnError || child.exitCode !== null) throw new Error('ANVIL_START_FAILED');
      try { ready = await client.getChainId() === 31337; } catch { await sleep(200); }
    }
    if (!ready) throw new Error('ANVIL_START_TIMEOUT');
    const read = (address, fn, args = []) => client.readContract({ address, abi, functionName: fn, args });
    const snapshot = async () => {
      const [sourceShares, destinationShares, safeAssets, adapterAssets, adapterSourceShares, allowance] = await Promise.all([
        read(source, 'balanceOf', [safe]), read(destination, 'balanceOf', [safe]), read(asset, 'balanceOf', [safe]),
        read(asset, 'balanceOf', [ETHEREUM_GENERAL_ADAPTER1]), read(source, 'balanceOf', [ETHEREUM_GENERAL_ADAPTER1]), read(source, 'allowance', [safe, ETHEREUM_GENERAL_ADAPTER1])
      ]);
      return { sourceShares, destinationShares, safeAssets, adapterAssets, adapterSourceShares, allowance };
    };
    stage = 'IMPERSONATE';
    await client.request({ method: 'anvil_impersonateAccount', params: [safe] });
    await client.request({ method: 'anvil_setBalance', params: [safe, '0x56bc75e2d63100000'] }); // local gas funds only
    const send = async (call, operation) => {
      stage = operation;
      const hash = await client.request({ method: 'eth_sendTransaction', params: [{ from: safe, to: call.to, data: call.data, gas: '0x2dc6c0' }] });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 45000, pollingInterval: 100 });
      return { operation, status: receipt.status, gasUsed: receipt.gasUsed.toString() };
    };

    // Negative control: a floor 5% above the previewed price must make the bundle revert.
    stage = 'NEGATIVE_CONTROL';
    const checkpoint = await client.request({ method: 'evm_snapshot' });
    const strict = buildMigrationCalls({ chainId: 1, safe, source, destination, shares: BigInt(proposal.sizing.shares),
      minRedeemPriceE27: BigInt(proposal.bounds.minRedeemPriceE27) * 10500n / 10000n, maxDepositPriceE27: BigInt(proposal.bounds.maxDepositPriceE27) });
    await send(strict[0], 'NEGATIVE_APPROVE');
    const negative = await send(strict[1], 'NEGATIVE_MULTICALL');
    await client.request({ method: 'evm_revert', params: [checkpoint] });
    if (negative.status !== 'reverted') throw new Error('PRICE_FLOOR_NOT_ENFORCED');

    stage = 'BATCH';
    const before = await snapshot();
    const receipts = [];
    for (const [index, call] of proposal.calls.entries()) {
      const receipt = await send(call, ['APPROVE', 'MULTICALL', 'RESET_ALLOWANCE'][index]);
      receipts.push({ ...receipt, label: call.label });
      if (receipt.status !== 'success') return { status: 'SIMULATION_FAILED', failedAt: receipt.operation, receipts, mode: 'LOCAL_FORK_ONLY', forkBlock: proposal.anchor.number,
        reason: 'A call reverted on the fork. On mainnet the whole Safe batch would revert and nothing would move. Typical causes: insufficient vault liquidity, a moved share price, or a vault gate.' };
    }
    const after = await snapshot();
    const shares = BigInt(proposal.sizing.shares);
    const minted = after.destinationShares - before.destinationShares;
    const minimumMinted = BigInt(proposal.previews.destinationShares) * BigInt(10000 - proposal.bounds.toleranceBps) / 10000n;
    const checks = {
      sourceSharesDebitedExactly: before.sourceShares - after.sourceShares === shares,
      destinationSharesAtLeastFloor: minted >= minimumMinted,
      safeUnderlyingUnchanged: after.safeAssets === before.safeAssets,
      adapterHoldsNothing: after.adapterAssets === before.adapterAssets && after.adapterSourceShares === before.adapterSourceShares,
      allowanceResetToZero: after.allowance === 0n,
      priceFloorRevertsWhenTooStrict: true
    };
    const passed = Object.values(checks).every(Boolean);
    const destinationValue = await read(destination, 'convertToAssets', [minted]);
    return {
      status: passed ? 'SIMULATION_PASSED' : 'INVARIANT_FAILED', mode: 'LOCAL_FORK_ONLY', executionChainId: 31337, forkBlock: proposal.anchor.number, forkBlockHash: remote.hash,
      checks, receipts,
      result: { sourceSharesRedeemed: shares.toString(), destinationSharesMinted: minted.toString(), destinationValueAssets: destinationValue.toString(), previewAssets: proposal.previews.assets },
      gasNote: 'Gas of the three inner calls sent directly by the impersonated Safe. Real execution goes through Safe execTransaction + MultiSend and costs more.',
      caveats: ['Impersonation stands in for the Safe signers on a private fork; it proves nothing about who may sign on mainnet.', 'The fork reflects the anchor block only; later state can differ.']
    };
  } catch (error) {
    const safeMessage = /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'FORK_SIMULATION_UNAVAILABLE';
    return { status: 'SIMULATION_UNAVAILABLE', mode: 'LOCAL_FORK_ONLY', stage, reason: safeMessage };
  } finally {
    clearTimeout(stopTimer);
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }
}
