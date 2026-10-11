# Traceability to the attached Belem Capital challenge brief

This is a paraphrase of the user's single-page EPFL Hackathon 2026 brief, not a new requirement imposed by organizers.

- **Problem:** a composable on-chain position inherits risk from hidden underlying protocols, assets, oracles, AMMs, liquidity venues and infrastructure.
- **Worked example:** one Pendle Principal Token position can depend on **five** layers: (1) settlement chain, (2) underlying yield source and issuer, (3) oracle, (4) PT market/AMM curve, and (5) lending market holding the PT as collateral.
- **Requested system:** automatically identify the dependencies of a position and estimate the economic impact if one is affected by a security incident, market disruption or technical failure.
- **User decision:** whether expected loss from remaining justifies exiting despite slippage/execution costs. Brief illustrative trade-off: 10 equally weighted pockets, one affected; unwinding that pocket costs 11% slippage. High slippage alone does not dictate an exit.
- **Freedom:** any ecosystem (EVM, Solana, Canton, Tempo), graph/statistical/simulation/agent-based methodology; scope may focus on oracles, external-venue vaults or concentration in TVL.
- **Judging:** dependency discovery 30%, impact 30%, stay/exit usefulness 25%, working real-data demo 15%.
- **Important:** the brief does **not** require a universal adapter for any possible vault, a live incident feed, AI, or execution of trades. These are optional aspirational features for our product, not claimed competition rules.

## Subsequent user-reported feedback — 2026-10-11

The user reports a conversation with Belem preferring reallocation, possibly automatic after initial authorization, and forecasts derived from live dependencies/data. This changes our intended product direction; it is not independently verified as a formal change to the published brief or scoring. See [the updated implementation plan](AUTOMATION_AND_REALLOCATION.md).
