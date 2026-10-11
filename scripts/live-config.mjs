import { MorphoClient } from '../dist/connectors/morpho.js';
import { ReadOnlyRpc } from '../dist/connectors/rpc.js';
import { SourceClient } from '../dist/connectors/source.js';
import { JsonClient } from '../dist/connectors/http.js';
import { parseSelector } from '../dist/connectors/morpho.js';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}
const publicHttp = new JsonClient();
export const api = new MorphoClient(publicHttp, process.env.MORPHO_API_BASE || 'https://api.morpho.org');
export function liveOptions(selector, enrichment = true) {
  const { chainId } = parseSelector(selector);
  const url = chainId === 1 ? process.env.ETHEREUM_RPC_URL : process.env[`RPC_URL_${chainId}`];
  return { api, ...(url ? { rpc: new ReadOnlyRpc(url, chainId, 600) } : {}), ...(process.env.ETHERSCAN_API_KEY ? { source: new SourceClient(process.env.ETHERSCAN_API_KEY, publicHttp) } : {}), enrichment };
}
