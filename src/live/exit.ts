import { z } from 'zod';
import { formatUnits } from 'viem';
import { addressSchema, rawInteger, MorphoClient } from '../connectors/morpho.js';
import type { ReadOnlyRpc } from '../connectors/rpc.js';
import type { LiveSnapshot } from './types.js';
import type { ExitAssessment } from './analyze.js';

/** Read-only redemption assessment: contract previews plus eth_estimateGas; never sends a transaction. */
export async function quoteRedemption(snapshot: LiveSnapshot, rpc: ReadOnlyRpc, api: MorphoClient, ownerInput: string, sharesInput?: string): Promise<ExitAssessment> {
  const owner = addressSchema.parse(ownerInput);
  const root = snapshot.nodes.find(node => node.id === snapshot.rootPositionId);
  if (!root?.address || root.kind !== 'vault') throw new Error('EXIT_REQUIRES_VAULT');
  const result: ExitAssessment = { feasible: null, fullExit: null, costUsd: null, sourceBlock: null, quotedAt: null, owner, reasons: [], evidence: [] };
  let anchor: { number: string; hash: string } | undefined;
  try {
    const block = await rpc.anchor();
    anchor = block;
    result.sourceBlock = block.number;
    result.quotedAt = new Date().toISOString();
    const observe = (call: string) => { result.evidence.push({ sourceType: 'onchain_call', reference: `eip155:${snapshot.chainId}:${root.address}#${call}`, blockNumber: block.number, blockTimestamp: block.timestamp, observedAt: result.quotedAt }); };
    const read = (signature: string, args: readonly unknown[] = []) => rpc.read(root.address!, signature, args, block.number);
    const balance = BigInt(rawInteger.parse(String(await read('function balanceOf(address) view returns (uint256)', [owner]))));
    observe('balanceOf(owner)');
    const shares = sharesInput ? BigInt(rawInteger.parse(sharesInput)) : balance;
    if (shares <= 0n || shares > balance) {
      result.feasible = false;
      result.reasons.push(shares <= 0n ? 'Owner has no requested vault shares to redeem.' : 'Requested shares exceed the owner balance.');
      return result;
    }
    result.shares = shares.toString();
    result.fullExit = shares === balance;
    const [maxRaw, previewRaw, referenceRaw, assetRaw] = await Promise.all([
      read('function maxWithdraw(address) view returns (uint256)', [owner]),
      read('function previewRedeem(uint256) view returns (uint256)', [shares]),
      read('function convertToAssets(uint256) view returns (uint256)', [shares]),
      read('function asset() view returns (address)')
    ]);
    for (const call of ['balanceOf(owner)', 'maxWithdraw(owner)', 'previewRedeem(shares)', 'convertToAssets(shares)', 'asset()']) observe(call);
    const max = BigInt(rawInteger.parse(String(maxRaw))), preview = BigInt(rawInteger.parse(String(previewRaw))), reference = BigInt(rawInteger.parse(String(referenceRaw)));
    result.maxWithdrawAssets = max.toString();
    result.previewAssets = preview.toString();
    const fee = reference > preview ? reference - preview : 0n;
    result.feeAssets = fee.toString();
    const v2 = snapshot.protocol === 'Morpho Vault V2';
    if (!v2 && (max === 0n || preview > max)) {
      result.feasible = false;
      result.reasons.push(max === 0n ? 'The current maxWithdraw limit is zero.' : 'The requested full redemption exceeds current maxWithdraw; a smaller withdrawal may be available.');
      return result;
    }
    if (v2) result.reasons.push('Morpho V2 deliberately reports zero from ERC-4626 max functions. Direct redemption feasibility is checked with the actual redeem call simulation, not inferred from maxWithdraw.');
    if (preview <= 0n) { result.reasons.push('Preview returns no assets; redeemability remains unresolved.'); return result; }
    const ownerCode = await rpc.code(owner, block.number);
    if (ownerCode && ownerCode !== '0x') {
      result.reasons.push('Owner is a contract or delegated account. Wallet authorization and outer execution/gas require a separate model; impersonating that account is not a verified exit route.');
      return result;
    }
    const [gas, gasPrice] = await Promise.all([rpc.estimateRedeem(root.address, owner, shares.toString(), block.number), rpc.gasPrice()]);
    result.gasUnits = gas.toString(); result.gasPriceWei = gasPrice.toString();
    result.gasCostEth = formatUnits(gas * gasPrice, 18);
    result.feasible = true;
    observe('eth_estimateGas redeem(shares,owner,owner)');
    const asset = addressSchema.parse(assetRaw);
    const decimals = Number(await rpc.read(asset, 'function decimals() view returns (uint8)', [], block.number));
    const freshPrice = async (address: string) => {
      const raw = await api.http.request(api.base + '/graphql', { query: 'query ExitPrice($address:String!,$chainId:Int!) { assetByAddress(address:$address,chainId:$chainId) { price { usd timestamp } } }', variables: { address, chainId: snapshot.chainId } });
      const value = z.object({ data: z.object({ assetByAddress: z.object({ price: z.object({ usd: z.number().finite().positive(), timestamp: rawInteger }).nullable() }).nullable() }) }).parse(raw).data.assetByAddress?.price;
      const age = value ? Date.now() / 1000 - Number(value.timestamp) : NaN;
      if (!value || !Number.isFinite(age) || age < 0 || age >= 15 * 60) return null;
      result.evidence.push({ sourceType: 'protocol_api', reference: api.base + '/graphql', sourcePath: `assetByAddress(${address}).price`, observedAt: result.quotedAt, timestamp: value.timestamp });
      return value.usd;
    };
    // Reference prices are refreshed for the quote, independently of indexed discovery timestamps.
    const [price, ethPrice] = await Promise.all([
      freshPrice(asset).catch(() => null),
      snapshot.chainId === 1 ? freshPrice('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2').catch(() => null) : Promise.resolve(null)
    ]);
    if (price !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
      result.assetPriceUsd = price;
      result.positionValueUsd = Number(formatUnits(reference, decimals)) * price;
      if (ethPrice !== null) result.costUsd = Number(formatUnits(fee, decimals)) * price + Number(result.gasCostEth) * ethPrice;
    }
    if ((result.costUsd !== null && !Number.isFinite(result.costUsd)) || (result.positionValueUsd !== undefined && !Number.isFinite(result.positionValueUsd))) {
      result.costUsd = null; delete result.positionValueUsd;
      result.reasons.push('Dollar valuation exceeds numeric limits.');
    }
    if (result.costUsd === null) result.reasons.push('Fresh underlying/native USD reference prices are unavailable; no dollar exit-cost comparison is produced.');
    result.reasons.push('This is a read-only estimate for direct redemption to the underlying asset, not a guaranteed fill or a swap into dollars. Gas price, state and withdrawal availability may change.');
    result.reasons.push('Gas uses the current network gas price; costs on other chains and nonstandard token transfer fees require separate models.');
    return result;
  } catch {
    result.feasible = null;
    result.costUsd = null;
    result.reasons.push('Preview, gas estimation, or provider read failed; execution feasibility is unknown.');
    return result;
  } finally {
    // Early outcomes (including zero balance and withdrawal limits) also need a reorg check.
    if (anchor) {
      try {
        if (!await rpc.sameBlock(anchor.number, anchor.hash)) {
          result.feasible = null; result.costUsd = null; delete result.positionValueUsd;
          result.reasons.push('Anchor changed during quote; reorg invalidates the assessment.');
        }
      } catch {
        result.feasible = null; result.costUsd = null; delete result.positionValueUsd;
        result.reasons.push('Quote block could not be rechecked; execution feasibility remains unknown.');
      }
    }
  }
}
