import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';

export class ReadOnlyRpc {
  private client;
  private calls = new Map<string, Promise<unknown>>();
  private count = 0;
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(url: string, public readonly chainId: number, private readonly budget = 350) {
    if (!/^https?:\/\//.test(url)) throw new Error('INVALID_RPC_URL');
    this.client = createPublicClient({ transport: http(url, { timeout: 12000, retryCount: 0 }) });
  }
  async anchor(blockNumber?: string) {
    if (await this.client.getChainId() !== this.chainId) throw new Error('RPC_CHAIN_MISMATCH');
    const block = await this.client.getBlock(blockNumber ? { blockNumber: BigInt(blockNumber) } : { blockTag: 'latest' });
    return { number: block.number.toString(), hash: block.hash, timestamp: new Date(Number(block.timestamp) * 1000).toISOString() };
  }
  async sameBlock(number: string, hash: string) {
    const block = await this.client.getBlock({ blockNumber: BigInt(number) });
    return block.hash === hash;
  }
  async read(address: string, signature: string, args: readonly unknown[] = [], blockNumber?: string): Promise<unknown> {
    const key = JSON.stringify([address.toLowerCase(), signature, args, blockNumber], (_, value) => typeof value === 'bigint' ? value.toString() : value);
    const existing = this.calls.get(key);
    if (existing) return existing;
    const promise = this.perform(async () => this.client.readContract({ address: address as Address, abi: parseAbi([signature]), functionName: signature.split('(')[0]!.replace('function ', '').trim(), args, ...(blockNumber ? { blockNumber: BigInt(blockNumber) } : {}) }));
    this.calls.set(key, promise);
    return promise;
  }
  async code(address: string, blockNumber?: string) { return this.perform(() => this.client.getCode({ address: address as Address, ...(blockNumber ? { blockNumber: BigInt(blockNumber) } : {}) })); }
  async storage(address: string, slot: Hex, blockNumber?: string) { return this.perform(() => this.client.getStorageAt({ address: address as Address, slot, ...(blockNumber ? { blockNumber: BigInt(blockNumber) } : {}) })); }
  async gasPrice() { return this.perform(() => this.client.getGasPrice()); }
  async estimateRedeem(address: string, owner: string, shares: string, blockNumber: string) {
    return this.perform(() => this.client.estimateContractGas({ address: address as Address, account: owner as Address,
      abi: parseAbi(['function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)']), functionName: 'redeem',
      args: [BigInt(shares), owner as Address, owner as Address], blockNumber: BigInt(blockNumber) }));
  }
  private async perform<T>(operation: () => Promise<T>): Promise<T> {
    if (++this.count > this.budget) throw new Error('RPC_BUDGET_EXCEEDED');
    if (this.active >= 4) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await operation(); } catch { throw new Error('RPC_READ_FAILED'); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}
