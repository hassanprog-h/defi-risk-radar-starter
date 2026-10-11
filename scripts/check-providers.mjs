import { ReadOnlyRpc } from '../dist/connectors/rpc.js';
try { process.loadEnvFile('.env'); } catch {}
const status = {};
if (process.env.ETHEREUM_RPC_URL) {
  try { const block = await new ReadOnlyRpc(process.env.ETHEREUM_RPC_URL, 1).anchor(); status.ethereum = { status: 'ok', blockNumber: block.number, timestamp: block.timestamp }; }
  catch { status.ethereum = { status: 'unavailable', message: 'RPC connectivity or chain validation failed; credentials were not printed.' }; }
} else status.ethereum = { status: 'not_configured' };
if (process.env.ETHERSCAN_API_KEY) {
  try {
    const url = new URL('https://api.etherscan.io/v2/api');
    for (const [key, value] of Object.entries({ chainid: '1', module: 'contract', action: 'getsourcecode', address: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB', apikey: process.env.ETHERSCAN_API_KEY })) url.searchParams.set(key, value);
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    status.etherscan = { status: body.status === '1' ? 'ok' : 'unavailable' };
  } catch { status.etherscan = { status: 'unavailable' }; }
} else status.etherscan = { status: 'not_configured' };
console.log(JSON.stringify(status, null, 2));
