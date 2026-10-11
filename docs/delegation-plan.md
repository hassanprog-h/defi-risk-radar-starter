# Plan — bounded automatic delegation with Zodiac Roles (v1)

Status: requested by the user on 2026-10-11 ("propose a detailed plan, then start coding"). Branch `test/executable-domain-seed`.

## Goal

The Safe signers sign **once** a role that lets a bot key move at most a quota of source-vault shares, only through the Morpho Bundler3 route, only into allowlisted destinations, and only for the Safe. After that, the bot can execute the solver's proposals alone; the Safe can revoke at any time. In this project the bot runs **only on a private Anvil fork**. Mainnet output is an unsigned setup batch for the Safe signers.

## Verified facts (2026-10-11)

| Fact | Source |
| --- | --- |
| Roles v2 mastercopy `0x9646fDAD06d3e24444381f44362a3B0eB343D337` (verified `Roles`, solc 0.8.21), ModuleProxyFactory `0x000000000000aDdB49795b0f9bA5BC298cDda236` (verified) | On-chain code + Etherscan V2 `getsourcecode` |
| `setUp(abi.encode(owner, avatar, target))`; `assignRoles(module, roleKeys, memberOf)` enables the member; `scopeTarget`, `scopeFunction(roleKey, target, selector, ConditionFlat[], ExecutionOptions)`, `setAllowance(key, balance, maxRefill, refill, period, timestamp)`; `execTransactionWithRole(to, value, data, operation, roleKey, shouldRevert)` | Deployed verified source (Roles.sol, PermissionBuilder.sol) |
| Enums: ParameterType None..AbiEncoded = 0..6; Operator Pass 0, And 1, Or 2, Matches 5, ArrayEvery 7, EqualToAvatar 15, EqualTo 16, Bitmask 21, WithinAllowance 28 | Deployed Types.sol |
| Conditions are BFS-flattened; root must be Calldata; `Matches` on Calldata takes no compValue (selector **not** checked); `And/Or` children must share a type tree, Calldata ≡ Dynamic | Deployed Integrity.sol, Topology.sol |
| Nested selector check = `And(Calldata Matches, Dynamic Bitmask(mask 0xffffffff))`; shorter function shapes are padded with `Pass` nodes; Static `Pass` children are not bounds-checked | Official SDK `calldataMatches`, `padToMatchTypeTree`; deployed Decoder.sol |
| Array `Matches` requires exact element count | Deployed PermissionChecker `_matches` |
| Proxy address = CREATE2(factory, keccak256(keccak256(initializer) ‖ saltNonce), EIP-1167-style code) | Deployed ModuleProxyFactory source |

Licences: Roles is LGPL-3.0 and is only **called**; no source copied. The SDK is not used; condition encoding is written from the deployed source.

## Security design (why each rule exists)

- **Approve on the source vault:** spender = GeneralAdapter1, amount `WithinAllowance(quota key)`. The quota caps the shares the bot can move per period.
- **Bundler3.multicall:** exactly two calls (array length enforced), in order:
  1. `erc4626Redeem(source ∈ allowlist, shares, any floor, receiver = GeneralAdapter1, owner = Safe)`
  2. `erc4626Deposit(destination ∈ allowlist, assets = type(uint256).max, any ceiling, receiver = Safe)`
  each with `to = GeneralAdapter1`, `value = 0`, `skipRevert = false`, `callbackHash = 0`, selector pinned by bitmask.
  Without the length and `assets = max` rules, a redeem-only bundle (or a partial deposit) would leave tokens in the shared adapter, where anyone could take them in a later bundle.
- **No ETH, no delegatecall** (`ExecutionOptions.None`). Nothing else is callable.
- **Revocation:** Safe calls `assignRoles(bot, [role], [false])` or `disableModule`.
- Accepted residual risks (documented): price floors chosen by the bot are not constrained (redeem/deposit prices are vault accounting, not bot-manipulable); the three bot calls are separate transactions (a dangling adapter approval is harmless because Bundler3 only redeems the initiator's own shares).

## Deliverables

1. `src/automation/roles-conditions.ts` — enums, BFS flattener, bitmask/equality encoders, approve and multicall condition trees.
2. `src/automation/delegation.ts` — predicted module address, unsigned setup batch (deployModule, enableModule, scopeTarget/scopeFunction ×2, setAllowance, assignRoles), bot call wrappers.
3. `scripts/delegation-rehearsal.mjs` + `npm run rehearse:delegation` — Anvil fork: setup as the Safe, one bot migration, then rejection suite: wrong receiver, redeem-only, partial deposit, non-allowlisted destination, wrong spender, quota exceeded, revoked bot, non-member.
4. Tests: offline encoding tests; opt-in live fork rehearsal (`LIVE=1`).
5. Docs: `docs/DELEGATION.md`, README.

Defaults: allowlist = the solver's `POLICY_CANDIDATE` destinations (or explicit list); quota = the proposed share amount per 24 h; no on-chain expiry (Roles has none) — revocation is manual and stated.

## Out of scope

No bot on mainnet, no key management, no MultiSend unwrapper (non-atomic bot calls accepted, see above), EOA owners, swaps.
