import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createPublicClient, http } from 'viem';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {
  const server = createServer();
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  await new Promise(r => server.close(r)); return port;
}

/**
 * Private Anvil fork on loopback, chain 31337, pinned to `blockNumber`. All writes stay on this node.
 * The credential-bearing RPC URL goes straight to the child process and is never logged or returned.
 */
export async function startFork(blockNumber) {
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) throw new Error('ETHEREUM_RPC_NOT_CONFIGURED');
  if (!/^\d{1,20}$/.test(String(blockNumber))) throw new Error('INVALID_FORK_BLOCK');
  const port = await freePort();
  const require = createRequire(import.meta.url);
  const platform = process.platform === 'win32' ? 'win32-amd64' : `${process.platform}-${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
  const binary = require.resolve(`@foundry-rs/anvil-${platform}/bin/anvil${process.platform === 'win32' ? '.exe' : ''}`);
  const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--fork-url', rpcUrl, '--fork-block-number', String(blockNumber), '--chain-id', '31337', '--no-storage-caching', '--no-cors', '--quiet', '--accounts', '0', '--timeout', '12000', '--retries', '1'], { stdio: 'ignore' });
  let spawnError = false; child.once('error', () => { spawnError = true; });
  const stopTimer = setTimeout(() => child.kill('SIGKILL'), 240_000);
  const stop = () => { clearTimeout(stopTimer); if (child.exitCode === null) child.kill('SIGKILL'); };
  try {
    const client = createPublicClient({ transport: http(`http://127.0.0.1:${port}`, { timeout: 45000, retryCount: 0 }) });
    let ready = false;
    for (let i = 0; i < 75 && !ready; i++) {
      if (spawnError || child.exitCode !== null) throw new Error('ANVIL_START_FAILED');
      try { ready = await client.getChainId() === 31337; } catch { await sleep(200); }
    }
    if (!ready) throw new Error('ANVIL_START_TIMEOUT');
    /** Impersonated send with explicit gas so a revert yields a receipt instead of an estimation error. */
    const send = async (from, to, data) => {
      const hash = await client.request({ method: 'eth_sendTransaction', params: [{ from, to, data, gas: '0x3d0900' }] });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 45000, pollingInterval: 100 });
      return { status: receipt.status, gasUsed: receipt.gasUsed.toString() };
    };
    const impersonate = async address => {
      await client.request({ method: 'anvil_impersonateAccount', params: [address] });
      await client.request({ method: 'anvil_setBalance', params: [address, '0x56bc75e2d63100000'] }); // local gas funds only
    };
    const snapshot = () => client.request({ method: 'evm_snapshot' });
    const revert = id => client.request({ method: 'evm_revert', params: [id] });
    return { client, send, impersonate, snapshot, revert, stop };
  } catch (error) { stop(); throw error; }
}
