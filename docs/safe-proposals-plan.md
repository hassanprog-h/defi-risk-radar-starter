# Plan — signable Safe migration proposals (v1)

Status: **approved** (2026-10-11). Branch: `test/executable-domain-seed` (no separate branch, by decision).

## Goal

Turn a concentration-policy proposal from `planReallocation` into an **unsigned, simulated Safe Transaction Builder batch** that the Safe's own signers import, review and sign. The system never signs, never sends, never holds a key and never posts to the Safe Transaction Service. Execution is atomic (Safe MultiSend): everything succeeds or nothing moves.

## Decisions

1. **Safe only in v1.** EOAs cannot batch atomically; a partial sequence could leave an open allowance or a half-done migration. An EOA or unknown contract owner is refused with an explicit message. EOA support (EIP-5792 / EIP-7702) is later work.
2. **Morpho Bundler3 with on-chain price floors.** Plain ERC-4626 calls have no slippage protection; `GeneralAdapter1.erc4626Redeem/erc4626Deposit` enforce min/max share prices (1e27 scale) and only let the multicall initiator redeem its own shares.
3. `npm ci` with install scripts approved (Anvil 1.7.1 available for fork simulation). `ETHEREUM_RPC_URL` configured and checked.

## Verified facts (2026-10-11)

| Fact | Source |
| --- | --- |
| Transaction Builder batch format (`version`, `chainId`, `createdAt`, `meta`, `transactions[{to,value,data}]`) and checksum = keccak256 of a sorted-key serialization with `meta.name = null` and no `checksum` key | `safe-global/safe-react-apps` `apps/tx-builder/src/lib/checksum.ts`, `typings/models.ts` |
| Bundler3 Ethereum `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245`, EthereumGeneralAdapter1 `0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0` | docs.morpho.org/developers/contracts/addresses; on-chain: code present, `GA1.BUNDLER3()` = Bundler3, `GA1.MORPHO()` = Morpho Blue (finalized block 26167508) |
| `multicall(Call[])`, `Call = {to, data, value, skipRevert, callbackHash}`; `initiator = msg.sender` | `morpho-org/bundler3` `src/interfaces/IBundler3.sol`, `src/Bundler3.sol` |
| `erc4626Redeem(vault, shares, minSharePriceE27, receiver, owner)` requires `owner == initiator` (or adapter) and `assets.rDivDown(shares) >= min`; `erc4626Deposit(vault, assets, maxSharePriceE27, receiver)` accepts `type(uint256).max` = adapter balance and requires `assets.rDivUp(shares) <= max` | `src/adapters/GeneralAdapter1.sol` (GPL-2.0-or-later; called, not copied) |

## Batch (3 transactions, atomic)

1. `source.approve(GeneralAdapter1, N)` — exact share amount.
2. `Bundler3.multicall([ erc4626Redeem(source, N, minSharePriceE27, GeneralAdapter1, safe), erc4626Deposit(destination, max, maxSharePriceE27, safe) ])`.
3. `source.approve(GeneralAdapter1, 0)`.

## Pipeline

1. Inputs: source, destination, Safe address, optional raw shares (default: `floor(balance × selected moveFraction)` from `planReallocation`), tolerance (default 50 bps).
2. On-chain checks at one pinned block: owner has code and answers `getThreshold/getOwners/VERSION/nonce`; same `asset()` on both vaults; destination is a `POLICY_CANDIDATE` when a plan is supplied; `0 < N <= balanceOf(safe)`; adapter linked to Bundler3; chain 1. Refuse on any doubt.
3. Bounds: `previewRedeem(N)` and `previewDeposit(assets)` → min/max share prices with tolerance; exact raw integers.
4. Fork simulation (Anvil, chain 31337, impersonated Safe as sender of the three calls): check owner source shares −N, destination shares ≥ floor, adapter allowance 0, no asset left in the adapter, nothing sent elsewhere. **No simulation pass → no batch file.**
5. Output: `safe-batch.json` (importable, checksum) + `proposal-report.json` (block, reads, amounts, bounds, Safe signers/threshold, simulation result, caveats, advisory expiry).

## Steps (commit after each passing step)

1. Pure batch builder + checksum + encoders, offline tests.
2. Proposal builder with on-chain checks (injected RPC), refusal tests.
3. Fork simulation of the batch.
4. CLI `npm run propose` + live run on a real Safe holder.
5. Server route `POST /api/safe-proposal`, dashboard button, docs/README.

## Out of scope (stated in every report)

No on-chain deadline (a late signature executes at then-current prices; only price floors protect). No EOA support. No swap (same underlying, depeg risk kept). No forced-liquidity legs for V2 sources in v1 (simulation failure refuses). No posting to Safe services. Not a security audit.

## Later, separate approval

Bounded automatic delegation through an audited module (Zodiac Roles) scoped to these calls, rehearsed on fork only.
