import { encodeAbiParameters, maxUint256, toFunctionSelector, type Hex } from 'viem';

// Enum values from the deployed Roles v2 mastercopy 0x9646fDAD06d3e24444381f44362a3B0eB343D337 (Types.sol).
export enum ParameterType { None = 0, Static = 1, Dynamic = 2, Tuple = 3, Array = 4, Calldata = 5, AbiEncoded = 6 }
export enum Operator { Pass = 0, And = 1, Or = 2, Nor = 3, Matches = 5, ArraySome = 6, ArrayEvery = 7, ArraySubset = 8, EqualToAvatar = 15, EqualTo = 16, GreaterThan = 17, LessThan = 18, Bitmask = 21, WithinAllowance = 28 }
export enum ExecutionOptions { None = 0, Send = 1, DelegateCall = 2, Both = 3 }

export interface Condition { paramType: ParameterType; operator: Operator; compValue?: Hex; children?: Condition[]; }
export interface ConditionFlat { parent: number; paramType: number; operator: number; compValue: Hex; }

/** Breadth-first flattening required by Integrity.enforce: the root is its own parent and parents never decrease. */
export function flattenCondition(root: Condition): ConditionFlat[] {
  const out: ConditionFlat[] = [];
  const queue: [Condition, number][] = [[root, 0]];
  for (let head = 0; head < queue.length; head++) {
    const [node, parent] = queue[head]!;
    const index = out.length;
    out.push({ parent, paramType: node.paramType, operator: node.operator, compValue: node.compValue ?? '0x' });
    for (const child of node.children ?? []) queue.push([child, index]);
  }
  return out;
}

const isAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);
export const pass = (paramType: ParameterType = ParameterType.Static): Condition => ({ paramType, operator: Operator.Pass });
export const avatar = (): Condition => ({ paramType: ParameterType.Static, operator: Operator.EqualToAvatar });
export const eqAddress = (address: string): Condition => {
  if (!isAddress(address)) throw new Error('INVALID_ADDRESS');
  return { paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: encodeAbiParameters([{ type: 'address' }], [address as Hex]) };
};
export const eqUint = (value: bigint): Condition => ({ paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: encodeAbiParameters([{ type: 'uint256' }], [value]) });
export const eqBytes32 = (value: Hex): Condition => ({ paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: encodeAbiParameters([{ type: 'bytes32' }], [value]) });
export const withinAllowance = (key: Hex): Condition => ({ paramType: ParameterType.Static, operator: Operator.WithinAllowance, compValue: key });
export const oneOfAddresses = (addresses: string[]): Condition => {
  const unique = [...new Set(addresses.map(a => a.toLowerCase()))];
  if (!unique.length || unique.length > 16) throw new Error('INVALID_ALLOWLIST');
  return unique.length === 1 ? eqAddress(unique[0]!) : { paramType: ParameterType.None, operator: Operator.Or, children: unique.map(eqAddress) };
};
/** Bitmask compValue = shift (2 bytes) ‖ mask (15 bytes) ‖ expected (15 bytes); checks the nested call's 4-byte selector. */
export function selectorBitmask(selector: Hex): Condition {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) throw new Error('INVALID_SELECTOR');
  const compValue = `0x0000${'ffffffff'.padEnd(30, '0')}${selector.slice(2).toLowerCase().padEnd(30, '0')}` as Hex;
  return { paramType: ParameterType.Dynamic, operator: Operator.Bitmask, compValue };
}
/** Nested calldata with a pinned selector, the deployed-contract pattern also used by the official SDK. */
export const nestedCall = (selector: Hex, params: Condition[]): Condition => ({
  paramType: ParameterType.None, operator: Operator.And,
  children: [{ paramType: ParameterType.Calldata, operator: Operator.Matches, children: params }, selectorBitmask(selector)]
});

export const SELECTORS = {
  approve: toFunctionSelector('approve(address,uint256)'),
  multicall: toFunctionSelector('multicall((address,bytes,uint256,bool,bytes32)[])'),
  erc4626Redeem: toFunctionSelector('erc4626Redeem(address,uint256,uint256,address,address)'),
  erc4626Deposit: toFunctionSelector('erc4626Deposit(address,uint256,uint256,address)')
};

/** source.approve(spender = adapter, amount within the share quota). */
export function approveConditions(adapter: string, allowanceKey: Hex): Condition {
  return { paramType: ParameterType.Calldata, operator: Operator.Matches, children: [eqAddress(adapter), withinAllowance(allowanceKey)] };
}

/**
 * Bundler3.multicall([redeem, deposit]) — exactly two calls in this order. The deposit must take the adapter's whole
 * balance (assets = max) for the Safe; otherwise tokens could be left in the shared adapter for anyone to take.
 */
export function multicallConditions(adapter: string, sources: string[], destinations: string[]): Condition {
  const callTuple = (data: Condition): Condition => ({
    paramType: ParameterType.Tuple, operator: Operator.Matches,
    children: [eqAddress(adapter), data, eqUint(0n), eqUint(0n), eqBytes32(`0x${'0'.repeat(64)}`)]
  });
  const redeem = nestedCall(SELECTORS.erc4626Redeem, [oneOfAddresses(sources), pass(), pass(), eqAddress(adapter), avatar()]);
  // Padded with a trailing Pass so both branches share one type tree (the deployed Integrity rule); Pass is never read.
  const deposit = nestedCall(SELECTORS.erc4626Deposit, [oneOfAddresses(destinations), eqUint(maxUint256), pass(), avatar(), pass()]);
  return {
    paramType: ParameterType.Calldata, operator: Operator.Matches,
    children: [{ paramType: ParameterType.Array, operator: Operator.Matches, children: [callTuple(redeem), callTuple(deposit)] }]
  };
}
