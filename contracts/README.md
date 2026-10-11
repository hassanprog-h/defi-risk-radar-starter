# Fork-only atomic migration demonstrator

`ForkPolicyMigrator.sol` is an independently written hackathon contract, compiled from source with the npm Solidity compiler. It **requires chain ID 31337 in its constructor**, so this artifact cannot deploy on Ethereum mainnet. No real wallet setup is implemented by this demonstration.

The owner deploys the policy with a fixed executor, source vault, compatible destination vault, per-move and cumulative share limits, expiry, cooldown and minimum-output basis points. A source-share allowance is granted once on the fork. The executor later calls `execute(shares,minAssets,minDestinationShares)` without needing another owner action. One atomic transaction redeems the owner's approved shares to the migrator, deposits all received underlying for the fixed owner, clears underlying allowances and verifies outputs/balance invariants. Failure rolls back all legs. Owner policy revocation and revoked source-token allowance both stop execution.

For a Morpho V2 vault with no default liquidity adapter and insufficient idle funds, the runner can construct up to four fixed permissionless `forceDeallocate` legs. It verifies the direct adapter's parent, asset and canonical Morpho core, hashes market parameters, and checks supplied assets against unborrowed market liquidity at the anchor. Each leg has a fixed maximum amount and a fee cap of at most one basis point. The contract rechecks registration and the fee, pulls only the shortfall and then redeems. All owner shares burned, including fee shares, count toward the per-move and cumulative bounds. Reports separate this withdrawal fee from gas and rounding. Unknown adapters or insufficient liquidity abstain. See [Morpho V2 semantics](https://docs.morpho.org/developers/contracts/morpho-vaults-v2/).

The dashboard converts the entered USD position and proposed fraction to source shares using a fresh reference price and `previewWithdraw`; it reserves an additional bounded fee allowance. The public holder must own enough real shares. A successful forced-liquidity route does not change an earlier unavailable **direct** redemption quote, and does not establish post-migration concentration compliance: moving funds also changes the source vault's internal allocation.

No caller-selected recipient, arbitrary calldata, upgrade, swap, sweep or destination change exists. Reentrancy is rejected. Current previews are used with an enforced minimum fraction and caller-provided stricter floors; those previews themselves are not independent guarantees of fair value or investment quality. Accounting token identities are rechecked on execution.

`scripts/fork-migration.mjs` creates and owns an Anvil process on an ephemeral loopback port, forks a recent Ethereum anchor through the existing RPC and fixes local chain ID 31337. The only signing substitute is Anvil's local public-owner/executor impersonation. Local ETH is supplied solely for test gas; underlying/source share balances are read from actual fork state, not fabricated through token storage overrides. Mainnet clients have no transaction-sending code. Raw provider errors, fork metadata and credential URLs are never returned.

The report separates setup deployment/approval gas from executor migration gas, verifies recipient/source-share/underlying/output/allowance invariants, rechecks the remote anchor hash, and returns local transaction receipts. Fresh reference USD prices are used where available; missing prices leave dollar costs unknown. State is reverted and the owned node terminated in `finally`. These are fork receipts, not mainnet explorer transactions.

On-chain rejection checks: unauthorized caller, per-move overflow, impossible output floor, owner revocation, expired permission, revoked source allowance and cumulative/duplicate execution. Off-chain tests also cover wrong destination/receiver/asset/network, cooldown, expiry and live-mode denial. This is not a security audit; malicious vault/token behaviour and production account integration require broader review.

Artifacts record compiler version, settings and source SHA-256. The runner rejects stale source/artifact pairs. Build with `npm run build:contracts`; the official Anvil binary is an npm development dependency. A patched `tmp` override addresses the compiler's transitive dependency audit finding.

```bash
npm run test:fork -- SOURCE_VAULT DESTINATION_VAULT PUBLIC_EOA_OWNER [RAW_SHARES]
```

The dashboard can automatically rehearse one concentration-policy-selected migration per setup when enabled. A same-token migration cannot hedge an underlying depeg; that condition blocks the automatic rehearsal. The permission demo is independent of the experimental price model, which remains ineligible to authorize live execution.

Remaining production work: supported real-wallet authorization, appropriate policy/fee/gas protections, vetted vault/token allowlists, external security review, reviewed deployment/activation, robust persisted delegation state, resimulation and post-migration exposure measurement. Current provider keys authorize data reads only; no private key is requested.
