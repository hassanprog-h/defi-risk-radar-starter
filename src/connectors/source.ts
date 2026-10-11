import { z } from 'zod';
import { JsonClient, ProviderError } from './http.js';

const abiEntry = z.object({ type: z.string(), name: z.string().optional(), stateMutability: z.string().optional(), inputs: z.array(z.object({ type: z.string() })).optional(), outputs: z.array(z.object({ type: z.string() })).optional() });
export class SourceClient {
  private previous = 0;
  private count = 0;
  constructor(private readonly key: string, private readonly http = new JsonClient(), private readonly budget = 40) {}
  async contract(chainId: number, address: string) {
    if (++this.count > this.budget) throw new ProviderError('SOURCE_BUDGET_EXCEEDED');
    // Sequential enrichment callers keep requests below public explorer rate limits.
    const wait = 600 - (Date.now() - this.previous);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.previous = Date.now();
    const url = new URL('https://api.etherscan.io/v2/api');
    for (const [name, value] of Object.entries({ chainid: String(chainId), module: 'contract', action: 'getsourcecode', address, apikey: this.key })) url.searchParams.set(name, value);
    const raw = await this.http.request(url.toString());
    const body = z.object({ status: z.string(), result: z.unknown() }).parse(raw);
    if (body.status !== '1') throw new ProviderError('SOURCE_UNAVAILABLE');
    const rows = z.array(z.object({ ABI: z.string().max(1_000_000), ContractName: z.string().max(256), Proxy: z.string(), Implementation: z.string(), SourceCode: z.string().max(2_000_000), LicenseType: z.string().optional() })).parse(body.result);
    const row = rows[0];
    if (!row || !row.SourceCode || !row.ABI.startsWith('[')) throw new ProviderError('UNVERIFIED_SOURCE');
    let abi;
    try { abi = z.array(abiEntry).max(1000).parse(JSON.parse(row.ABI)); } catch { throw new ProviderError('UNKNOWN_ABI'); }
    return { name: row.ContractName, proxy: row.Proxy === '1', implementation: row.Implementation, abi, license: row.LicenseType ?? 'unknown', source: `https://etherscan.io/address/${address}#code` };
  }
}
