import { concat, encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseAbi, stringToHex, toHex, type Hex } from 'viem';
import { ETHEREUM_BUNDLER3, ETHEREUM_GENERAL_ADAPTER1, buildBatchFile, type SafeCall } from './safe-batch.js';
import { ExecutionOptions, SELECTORS, approveConditions, flattenCondition, multicallConditions } from './roles-conditions.js';

// Verified 2026-10-11: on-chain code and Etherscan-verified source (Roles v2 mastercopy, ModuleProxyFactory 1.2.0).
export const ROLES_MASTERCOPY = '0x9646fDAD06d3e24444381f44362a3B0eB343D337';
export const MODULE_PROXY_FACTORY = '0x000000000000aDdB49795b0f9bA5BC298cDda236';

// Signatures from the deployed verified sources (Roles.sol, PermissionBuilder.sol, ModuleProxyFactory, Safe ModuleManager).
export const rolesAbi = parseAbi([
  'function setUp(bytes initParams)',
  'function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
  'function scopeTarget(bytes32 roleKey, address targetAddress)',
  'function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)',
  'function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)',
  'function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)',
  'function allowances(bytes32) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)',
  'function avatar() view returns (address)', 'function owner() view returns (address)', 'function target() view returns (address)'
]);
export const factoryAbi = parseAbi(['function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)']);
export const safeModuleAbi = parseAbi(['function enableModule(address module)', 'function isModuleEnabled(address module) view returns (bool)']);

export const ROLE_KEY = stringToHex('radar-reallocator', { size: 32 });
export const QUOTA_KEY = stringToHex('radar-share-quota', { size: 32 });
const isAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);
const lower = (value: string) => value.toLowerCase();

export function rolesInitializer(safe: string) {
  return encodeFunctionData({ abi: rolesAbi, functionName: 'setUp', args: [encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [safe as Hex, safe as Hex, safe as Hex])] });
}
/** Reproduces ModuleProxyFactory.deployModule's CREATE2 address so the setup batch can reference the module before it exists. */
export function predictRolesModule(safe: string, saltNonce: bigint) {
  const initializer = rolesInitializer(safe);
  const salt = keccak256(concat([keccak256(initializer), toHex(saltNonce, { size: 32 })]));
  const bytecode = concat(['0x602d8060093d393df3363d3d373d3d3d363d73', ROLES_MASTERCOPY as Hex, '0x5af43d82803e903d91602b57fd5bf3']);
  return getContractAddress({ opcode: 'CREATE2', from: MODULE_PROXY_FACTORY as Hex, salt, bytecode });
}

export interface DelegationInput {
  chainId: number; safe: string; bot: string; source: string; destinations: string[];
  quotaShares: bigint; periodSeconds?: number; saltNonce?: bigint; createdAt: number;
}
/** One unsigned Safe batch: deploy + enable the Roles module, scope the reallocation role, set the share quota, assign the bot. */
export function buildDelegationSetup(input: DelegationInput) {
  const { chainId, safe, bot, source, destinations, quotaShares } = input;
  const periodSeconds = input.periodSeconds ?? 86_400;
  const saltNonce = input.saltNonce ?? BigInt(input.createdAt);
  if (chainId !== 1) throw new Error('UNSUPPORTED_CHAIN');
  if (![safe, bot, source, ...destinations].every(isAddress)) throw new Error('INVALID_ADDRESS');
  if (!destinations.length || destinations.some(d => lower(d) === lower(source))) throw new Error('INVALID_ALLOWLIST');
  if ([source, ...destinations].some(a => [safe, bot].map(lower).includes(lower(a)))) throw new Error('INVALID_ALLOWLIST');
  if (lower(bot) === lower(safe)) throw new Error('BOT_EQUALS_SAFE');
  if (quotaShares <= 0n || quotaShares >= 2n ** 128n) throw new Error('INVALID_QUOTA');
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds < 3600 || periodSeconds > 30 * 86_400) throw new Error('INVALID_PERIOD');
  const module = predictRolesModule(safe, saltNonce);
  const roles = (functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi: rolesAbi, functionName: functionName as never, args: args as never });
  const approve = flattenCondition(approveConditions(ETHEREUM_GENERAL_ADAPTER1, QUOTA_KEY));
  const multicall = flattenCondition(multicallConditions(ETHEREUM_GENERAL_ADAPTER1, [source], destinations));
  const calls: SafeCall[] = [
    { to: MODULE_PROXY_FACTORY, value: '0', data: encodeFunctionData({ abi: factoryAbi, functionName: 'deployModule', args: [ROLES_MASTERCOPY, rolesInitializer(safe), saltNonce] }), label: `Deploy a Zodiac Roles module owned by this Safe at ${module}` },
    { to: safe, value: '0', data: encodeFunctionData({ abi: safeModuleAbi, functionName: 'enableModule', args: [module] }), label: 'Enable the Roles module on this Safe' },
    { to: module, value: '0', data: roles('scopeTarget', [ROLE_KEY, source]), label: 'Role may call only scoped functions on the source vault' },
    { to: module, value: '0', data: roles('scopeFunction', [ROLE_KEY, source, SELECTORS.approve, approve, ExecutionOptions.None]), label: 'Source approve: spender = Morpho GeneralAdapter1, amount within the share quota' },
    { to: module, value: '0', data: roles('scopeTarget', [ROLE_KEY, ETHEREUM_BUNDLER3]), label: 'Role may call only scoped functions on Morpho Bundler3' },
    { to: module, value: '0', data: roles('scopeFunction', [ROLE_KEY, ETHEREUM_BUNDLER3, SELECTORS.multicall, multicall, ExecutionOptions.None]), label: 'Bundler3 multicall: exactly [redeem(source → adapter, owner = Safe), deposit(all → allowlisted destination, receiver = Safe)]' },
    { to: module, value: '0', data: roles('setAllowance', [QUOTA_KEY, quotaShares, quotaShares, quotaShares, BigInt(periodSeconds), 0n]), label: `Share quota: ${quotaShares} raw shares per ${periodSeconds} s` },
    { to: module, value: '0', data: roles('assignRoles', [bot, [ROLE_KEY], [true]]), label: `Assign the reallocation role to bot ${bot}` }
  ];
  const description = `DeFi Risk Radar delegation setup: Roles module ${module} for Safe ${safe}. Bot ${bot} may move at most ${quotaShares} raw shares of ${source} per ${periodSeconds} s, only via Morpho Bundler3 into ${destinations.join(', ')}, for this Safe. Revoke with assignRoles(bot, [role], [false]) or by disabling the module.`;
  const batch = buildBatchFile({ chainId, safe, calls, name: 'DeFi Risk Radar delegation setup', description, createdAt: input.createdAt });
  return { kind: 'ROLES_DELEGATION_SETUP', module, roleKey: ROLE_KEY, quotaKey: QUOTA_KEY, saltNonce: saltNonce.toString(), periodSeconds, quotaShares: quotaShares.toString(), safe, bot, source, destinations, conditions: { approve, multicall }, calls, batch };
}

/** The bot wraps each migration call in execTransactionWithRole (plain call, no ETH, revert on failure). */
export function botCalls(module: string, calls: SafeCall[]) {
  return calls.map(call => ({ to: module, label: call.label, data: encodeFunctionData({ abi: rolesAbi, functionName: 'execTransactionWithRole', args: [call.to as Hex, 0n, call.data, 0, ROLE_KEY, true] }) }));
}
