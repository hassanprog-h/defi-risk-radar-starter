# Bounded automatic delegation (Zodiac Roles)

[Safe proposals](SAFE_PROPOSALS.md) ask the Safe signers to sign every move. Delegation asks them to sign **once**: a Zodiac Roles module lets a bot key move at most a share quota per period, only through Morpho Bundler3, only into allowlisted destinations, only for the Safe. The Safe can revoke it at any time. In this project the bot runs **only on a private Anvil fork**; the mainnet output is an unsigned setup batch. See the [plan](delegation-plan.md) for every verified source.

## What the setup batch does (one Safe signature round)

1. `ModuleProxyFactory.deployModule(RolesV2, setUp(safe, safe, safe), salt)` — a Roles module owned by the Safe, at a precomputed CREATE2 address.
2. `Safe.enableModule(module)`.
3. `scopeTarget` + `scopeFunction` on the **source vault**: `approve(spender = GeneralAdapter1, amount WithinAllowance(quota))`.
4. `scopeTarget` + `scopeFunction` on **Bundler3**: `multicall` with exactly two calls, in order:
   - `erc4626Redeem(source, *, *, receiver = GeneralAdapter1, owner = Safe)`
   - `erc4626Deposit(destination ∈ allowlist, assets = max, *, receiver = Safe)`
   each with `to = GeneralAdapter1`, `value = 0`, `skipRevert = false`, `callbackHash = 0`, and the 4-byte selector pinned by a bitmask. No ETH, no delegatecall.
5. `setAllowance(quota, balance, maxRefill, refill, period)` — default: the proposed share amount per 24 h.
6. `assignRoles(bot, [role], [true])`.

The bot then sends three `execTransactionWithRole` calls (approve, multicall, approve 0). Revocation: `assignRoles(bot, [role], [false])` or `disableModule`.

## Why each rule exists

Morpho's GeneralAdapter1 is shared by everyone. A bundle that redeems without depositing, or deposits only part of the proceeds, leaves tokens in the adapter where **any other caller** can take them in their own bundle. Hence the exact two-call shape, `assets = max` and `receiver = Safe`. The selector pin matters because `erc4626Withdraw` has the same argument types as `erc4626Redeem`.

## Rehearsal (fork only)

```bash
npm run rehearse:delegation -- <source-vault> <safe> <allowed-destination...> --fraction 0.1 [--outsider <non-allowlisted-vault>]
```

The outsider vault used by the non-allowlisted-destination attack defaults to the source vault, which is never allowlisted. In the dashboard, open **Rehearse bounded delegation on a local fork** after a reallocation comparison. Executes the setup as the impersonated Safe, verifies the module (enabled, owner and avatar = Safe), runs ten attacks from clean snapshots, performs the legitimate bot migration, then checks quota exhaustion and revocation. An attack only counts as blocked when the **Roles permission check itself** refuses it (decoded `NotAuthorized`, `NoMembership` or `ConditionViolation(status)`), not when an inner protocol call happens to revert. Reports go to `.radar/delegation/` (git-ignored).

## Measured on 2026-10-11 (block 26167742, Safe `0xADb2…89d5` v1.4.1, 2 of 3)

Source Steakhouse USDC; allowlist Smokehouse USDC and Keyrock USDC; outsider Spark Blue Chip USDC; quota = 10% of the Safe's shares (≈ 144,366 USDC).

| Attack | Refused with |
| --- | --- |
| Caller without the role | `NotAuthorized` |
| Approve shares to the bot | `ParameterNotAllowed` |
| Approve above the quota | `AllowanceExceeded` |
| Redeem without deposit | `ParameterNotAMatch` (array length) |
| Third call appended | `ParameterNotAMatch` |
| Redeem proceeds to the bot | `ParameterNotAllowed` |
| Deposit for the bot | `ParameterNotAllowed` |
| Partial deposit (1 wei) | `ParameterNotAllowed` |
| Non-allowlisted destination | `OrViolation` |
| `erc4626Withdraw` instead of `erc4626Redeem` (same types) | `BitmaskNotAllowed` |

Then: the bot moved exactly the quota (destination value ≈ preview), the Safe's USDC balance and the adapter balance were unchanged, the adapter allowance returned to 0, the quota was consumed, a further approval was refused, and after `assignRoles(bot, false)` the bot was refused. Fork gas: setup ≈ 1.30 M (8 calls, sent directly by the impersonated Safe); bot migration ≈ 1.91 M (3 calls). Real execution through Safe MultiSend costs more.

## Limits

- **Fork only.** No module, permission or transaction is created on mainnet by this project, and no bot key is generated or operated. Running a bot on mainnet would need its own key management, monitoring and an external security review.
- Price floors are chosen by the bot and not constrained by the role. Vault share prices are accounting values the bot cannot move; the quota bounds what it can move.
- The three bot calls are separate transactions. A leftover adapter approval is harmless because Bundler3 only redeems the initiator's own shares.
- Roles has no built-in expiry; revocation is manual.
- One source vault per setup; up to 16 allowlisted destinations. Safe owners only.
- Not a security audit.
