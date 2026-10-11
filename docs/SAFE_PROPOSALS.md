# Signable Safe migration proposals

The concentration solver says *how much* to move and *where*. This feature turns that answer into a transaction the owner's own Safe signers can review and execute. The tool never signs, never sends, never holds a key and never posts to Safe services. See the approved [plan](safe-proposals-plan.md).

## What is produced

One atomic Safe batch (executed through Safe MultiSend: all calls succeed or nothing moves):

1. `source.approve(GeneralAdapter1, N)` — exactly the shares to move.
2. `Bundler3.multicall([erc4626Redeem(source, N, minSharePriceE27, GeneralAdapter1, safe), erc4626Deposit(destination, max, maxSharePriceE27, safe)])` — redeem to Morpho's adapter, deposit everything received for the Safe. The adapter only redeems shares of the multicall initiator (the Safe) and enforces both share-price bounds on-chain.
3. `source.approve(GeneralAdapter1, 0)`.

Bundler3 `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` and EthereumGeneralAdapter1 `0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0` come from Morpho's official address page and are re-checked on-chain for every proposal (code present, `BUNDLER3()` link).

Files: `safe-batch-<block>.json` (Safe{Wallet} Transaction Builder import format, with the builder's keccak256 checksum) and `proposal-report-<block>.json` (anchor block, Safe owners/threshold/version/nonce, sizing, previews, price bounds, simulation receipts and checks, caveats, advisory expiry).

## Checks before a file exists

- All reads at one anchor block, re-checked for a reorg.
- The owner is a Safe: contract code plus a consistent `getThreshold/getOwners/VERSION/nonce`. EOAs and other contracts are refused (v1).
- Same `asset()` on both vaults; `0 < N <= balanceOf(safe)`; when sized from the solver, the destination must be one of its `POLICY_CANDIDATE`s (plan read server-side, at most 15 minutes old).
- Private Anvil fork (chain 31337) at the anchor block, Safe impersonated: a negative control (floor 5% too strict) must revert; then the batch must debit exactly N source shares, mint at least the floored destination shares, leave the Safe's underlying balance unchanged, leave nothing in the adapter and reset the allowance to zero.

No simulation pass, no batch file.

## Use it

Dashboard: run **Find a reallocation**, open **Prepare an unsigned transaction for your Safe**, enter the Safe address, keep or override the proposed percentage, then download the batch. In Safe{Wallet}: Apps → Transaction Builder → drag the file → check the three decoded calls → Create batch → sign; other signers confirm and execute.

CLI:

```bash
npm run propose -- <source-vault> <destination-vault> <safe> --fraction 0.1
npm run propose -- <source-vault> <destination-vault> <safe> --shares <raw> --tolerance-bps 30
```

Files go to `.radar/proposals/` (git-ignored). Exit code 2 means the simulation did not pass and only the report was written.

## Measured on 2026-10-11 (read-only mainnet, local fork writes only)

| Case | Result |
| --- | --- |
| Safe `0xADb2…89d5` (v1.4.1, 2/3), Steakhouse USDC → Gauntlet USDC Prime, 10% | `READY_TO_SIGN` at block 26167602: 144,365.52 USDC, 6/6 checks; ~978k gas for the inner calls |
| Same Safe, solver plan Steakhouse → Smokehouse USDC (19.10%) | `READY_TO_SIGN`: 275,704.10 USDC, 6/6 checks |
| Steakhouse → Spark Blue Chip (`LIMITS_UNACHIEVABLE`) | refused `DESTINATION_NOT_PROPOSED` |
| Owner `0x…0001` | refused `OWNER_IS_NOT_A_CONTRACT` |
| Steakhouse → Gauntlet via solver | solver returned `SNAPSHOT_TIME_MISMATCH` (indexer blocks > 5 min apart); no proposal possible, by design |

## Limits

- No on-chain deadline: a later signature executes at then-current prices; only the price floors protect. The report's expiry is advisory.
- Safe only. EOAs (EIP-5792 / EIP-7702 batching) are later work.
- Same underlying on both sides: issuer/depeg risk is kept. No swaps.
- No forced-liquidity legs for illiquid V2 sources: such a batch fails simulation and is refused.
- Fork gas covers the inner calls only; execution via Safe `execTransaction` + MultiSend costs more.
- Impersonation on the fork proves executability at the anchor block, not who may sign on mainnet. Not a security audit.

## Next (separate approval)

Bounded automatic delegation through an audited module (Zodiac Roles) scoped to these calls, rehearsed on fork only.
