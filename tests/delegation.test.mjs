import test from 'node:test';
import assert from 'node:assert/strict';
import { concat, decodeFunctionData, getAddress, keccak256, maxUint256, slice, toHex } from 'viem';
import { ParameterType, Operator, SELECTORS, flattenCondition, multicallConditions, approveConditions, selectorBitmask } from '../dist/automation/roles-conditions.js';
import { MODULE_PROXY_FACTORY, ROLES_MASTERCOPY, QUOTA_KEY, ROLE_KEY, buildDelegationSetup, botCalls, factoryAbi, predictRolesModule, rolesAbi, rolesInitializer, safeModuleAbi } from '../dist/automation/delegation.js';
import { ETHEREUM_BUNDLER3, ETHEREUM_GENERAL_ADAPTER1, batchChecksum, buildMigrationCalls } from '../dist/automation/safe-batch.js';

const safe = '0x' + '5'.repeat(40), bot = '0x' + '7'.repeat(40), source = '0x' + 'a'.repeat(40), dest = '0x' + 'b'.repeat(40), dest2 = '0x' + 'c'.repeat(40);
const base = { chainId: 1, safe, bot, source, destinations: [dest, dest2], quotaShares: 10n ** 18n, createdAt: 1791700000000, saltNonce: 42n };

test('conditions flatten breadth-first with a Calldata root, as the deployed Integrity check requires', () => {
  for (const root of [approveConditions(ETHEREUM_GENERAL_ADAPTER1, QUOTA_KEY), multicallConditions(ETHEREUM_GENERAL_ADAPTER1, [source], [dest, dest2])]) {
    const flat = flattenCondition(root);
    assert.equal(flat[0].parent, 0); assert.equal(flat[0].paramType, ParameterType.Calldata);
    for (let i = 1; i < flat.length; i++) { assert.ok(flat[i].parent < i); assert.ok(flat[i].parent >= flat[i - 1].parent); }
  }
});

test('multicall scope: exactly [redeem, deposit], selectors pinned, deposit takes everything for the Safe', () => {
  const root = multicallConditions(ETHEREUM_GENERAL_ADAPTER1, [source], [dest]);
  const array = root.children[0];
  assert.equal(array.paramType, ParameterType.Array); assert.equal(array.operator, Operator.Matches); assert.equal(array.children.length, 2);
  const [redeem, deposit] = array.children.map(tuple => tuple.children[1]);
  for (const [node, selector] of [[redeem, SELECTORS.erc4626Redeem], [deposit, SELECTORS.erc4626Deposit]]) {
    assert.equal(node.operator, Operator.And);
    assert.deepEqual(node.children[1], selectorBitmask(selector));
    assert.equal(node.children[0].children.length, 5); // deposit padded to the redeem type tree
  }
  assert.equal(redeem.children[0].children[4].operator, Operator.EqualToAvatar); // owner = Safe
  assert.equal(deposit.children[0].children[3].operator, Operator.EqualToAvatar); // receiver = Safe
  assert.equal(BigInt(deposit.children[0].children[1].compValue), maxUint256); // whole adapter balance
  assert.equal(deposit.children[0].children[4].operator, Operator.Pass);
});

test('bitmask layout: 2-byte shift, 15-byte mask, 15-byte expected value', () => {
  const { compValue } = selectorBitmask('0x12345678');
  assert.equal(compValue, '0x0000' + 'ffffffff' + '0'.repeat(22) + '12345678' + '0'.repeat(22));
  assert.throws(() => selectorBitmask('0x1234'), /INVALID_SELECTOR/);
});

test('module address follows the factory CREATE2 formula', () => {
  const salt = keccak256(concat([keccak256(rolesInitializer(safe)), toHex(42n, { size: 32 })]));
  const code = concat(['0x602d8060093d393df3363d3d373d3d3d363d73', ROLES_MASTERCOPY, '0x5af43d82803e903d91602b57fd5bf3']);
  const expected = getAddress(slice(keccak256(concat(['0xff', MODULE_PROXY_FACTORY, salt, keccak256(code)])), 12));
  assert.equal(predictRolesModule(safe, 42n), expected);
  assert.notEqual(predictRolesModule(safe, 43n), expected);
});

test('setup batch: deploy, enable, scope two targets, quota, assign — all owned by the Safe, checksum bound', () => {
  const setup = buildDelegationSetup(base);
  assert.equal(setup.calls.length, 8);
  const [deploy, enable, ...rest] = setup.calls;
  assert.equal(deploy.to, MODULE_PROXY_FACTORY);
  assert.deepEqual(decodeFunctionData({ abi: factoryAbi, data: deploy.data }).args, [ROLES_MASTERCOPY, rolesInitializer(safe), 42n]);
  assert.equal(enable.to, safe);
  assert.equal(decodeFunctionData({ abi: safeModuleAbi, data: enable.data }).args[0], setup.module);
  assert.ok(rest.every(call => call.to === setup.module));
  assert.deepEqual(rest.map(call => decodeFunctionData({ abi: rolesAbi, data: call.data }).functionName), ['scopeTarget', 'scopeFunction', 'scopeTarget', 'scopeFunction', 'setAllowance', 'assignRoles']);
  const scopes = rest.filter(call => decodeFunctionData({ abi: rolesAbi, data: call.data }).functionName === 'scopeFunction').map(call => decodeFunctionData({ abi: rolesAbi, data: call.data }).args);
  assert.deepEqual(scopes.map(args => [args[0], args[1].toLowerCase(), args[2], args[4]]), [[ROLE_KEY, source, SELECTORS.approve, 0], [ROLE_KEY, ETHEREUM_BUNDLER3.toLowerCase(), SELECTORS.multicall, 0]]);
  assert.deepEqual(decodeFunctionData({ abi: rolesAbi, data: rest[5].data }).args, [getAddress(bot), [ROLE_KEY], [true]]);
  assert.equal(setup.batch.meta.checksum, batchChecksum(setup.batch));
});

test('setup refuses unsafe configurations', () => {
  for (const [patch, error] of [
    [{ bot: safe }, /INVALID_ALLOWLIST|BOT_EQUALS_SAFE/], [{ destinations: [source] }, /INVALID_ALLOWLIST/], [{ destinations: [] }, /INVALID_ALLOWLIST/],
    [{ destinations: [bot] }, /INVALID_ALLOWLIST/], [{ quotaShares: 0n }, /INVALID_QUOTA/], [{ quotaShares: 2n ** 128n }, /INVALID_QUOTA/],
    [{ periodSeconds: 60 }, /INVALID_PERIOD/], [{ chainId: 10 }, /UNSUPPORTED_CHAIN/], [{ bot: '0x12' }, /INVALID_ADDRESS/]
  ]) assert.throws(() => buildDelegationSetup({ ...base, ...patch }), error);
});

test('bot calls wrap each migration call in execTransactionWithRole: plain call, no ETH, revert on failure', () => {
  const inner = buildMigrationCalls({ chainId: 1, safe, source, destination: dest, shares: 1n, minRedeemPriceE27: 1n, maxDepositPriceE27: 1n });
  const wrapped = botCalls('0x' + '9'.repeat(40), inner);
  assert.equal(wrapped.length, 3);
  for (const [i, call] of wrapped.entries()) {
    const { functionName, args } = decodeFunctionData({ abi: rolesAbi, data: call.data });
    assert.equal(functionName, 'execTransactionWithRole');
    assert.deepEqual([args[0].toLowerCase(), args[1], args[2], args[3], args[4], args[5]], [inner[i].to.toLowerCase(), 0n, inner[i].data, 0, ROLE_KEY, true]);
  }
});

// Opt-in: real Safe on a private Anvil fork; every attack must be refused by the Roles permission check itself.
test('live: fork rehearsal — bounded bot migration succeeds, every attack is blocked by Roles, revocation works', { skip: process.env.LIVE !== '1' && process.env.RUN_LIVE !== '1' }, async () => {
  const { rehearseDelegation } = await import('../scripts/delegation-rehearsal.mjs');
  const report = await rehearseDelegation({ source: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB', safe: '0xADb2E162935B10A2580bC88C2622e7632B2789d5', destinations: ['0xBEeFFF209270748ddd194831b3fa287a5386f5bC', '0x04422053aDDbc9bB2759b248B574e3FCA76Bc145'], outsiderDestination: '0x56A76b428244a50513ec81e225a293d128fd581D', moveFraction: 0.01 });
  assert.equal(report.status, 'REHEARSAL_PASSED', JSON.stringify({ checks: report.checks, attacks: report.attackResults, failedAt: report.failedAt }));
  assert.ok(Object.values(report.attackResults).every(v => v.startsWith('BLOCKED_BY_ROLE')));
  assert.equal(Object.keys(report.attackResults).length, 10);
});
