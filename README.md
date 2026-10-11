# DeFi Risk Radar

A working, read-only hackathon prototype for the Belem Capital DeFi Risk Dependency Challenge. Select a real vault, inspect its dependency graph and evidence, inject a hypothetical failure, and assess conditional impact and a public owner's redemption route.

The expanded target is **automatic risk assessment and reallocation**. Implemented: live stablecoin price checks, an experimental historical probability model, partial destination proposals, background monitoring and atomic permission-bound execution **on local Ethereum forks only**. Calibrated live loss forecasts and real wallet delegation remain unfinished. See [measured benchmark results](docs/BENCHMARK_RESULTS.md) and the [delivery sequence](docs/AUTOMATION_AND_REALLOCATION.md).

For a step-by-step explanation of the controls, pipeline, actual fork withdrawal route and historical results, use the [demo walkthrough](docs/DEMO_WALKTHROUGH.md).

**Implemented:** live Morpho V1 and V2 discovery, V2 adapter traversal and pinned direct-market accounting, generic ERC-4626 accounting detection, contract/source enrichment, upstream oracle reads, Pendle PT/SY and venue association, documented USDC issuer identity, graph dashboard, conditional market/vault-capital stress models, read-only redemption assessment, verified public demo-holder lookup, JSON export and historical recording stress tests. The original illustrative fixture remains separate.

**Coverage is reported explicitly.** Entering any address starts a discovery attempt; unsupported strategies and incomplete layers stay unknown. Mainnet is read-only. Local fork transactions are isolated simulations; no real wallet permissions or transfers are created.

## Start the graph dashboard

```bash
npm install
npm run dev
```

Open **http://localhost:3000**. Keep the terminal running; Ctrl+C stops it. If occupied, use `PORT=3001 npm run dev`. The server binds to loopback only.

The dashboard initially inspects Steakhouse USDC using live providers. Choose a real example or load Morpho's paginated V1/V2 catalogue, enter an address, then click **Inspect live vault**. Choose **Keyrock USDC · V2 + Pendle** to demonstrate the five dependency categories. Example addresses are starting points; graph edges are discovered from data on each inspection.

**Automatic flow:** select the source address, enter your USD amount and click **Start automatic analysis + monitoring**. This refreshes the graph and accounting, fetches price assessments, compares destinations and starts five-minute checks. Optional automatic local-fork testing finds a public holder with enough real shares without owner copying. The page shows the current stage and configured source/amount. Restarting this flow applies edited inputs; reloading the page reconnects to the still-running server monitor and restores the stop control. Mainnet remains read-only.

Click nodes or relationships for evidence, find a node with the dropdown, zoom or scroll through the graph, and toggle affected paths. Scenario probability, severity and hypothetical USD position size are labelled assumptions. A guessed exit cost provides a sensitivity threshold, never a verified live exit decision.

**Where your vault invests your money** takes only a position value. **Show my exposure** refreshes the selected vault, displays verified market allocations and fetches live USD prices for supported USDC/USDT/DAI dependencies. An experimental model reports historical-regime probabilities of a **further 2% price drop over 24 hours**. Its 2022 training is disclosed; these references are not calibrated live forecasts or exploit probabilities. Root-underlying USD mark downside assumes constant underlying units and excludes bad debt. Collateral price risk never becomes lender loss without a liquidation/recovery model. **Inspect live vault** refreshes the graph. Manual inputs remain under **Advanced: hypothetical stress tests**.

**Find a reallocation** refreshes the source and up to three entered Ethereum destinations. It finds the smallest partial move meeting market/collateral concentration limits, accounting for shared capital exposures. Default limits are 35% per market and 50% per collateral; adjust them under the policy details. This is a risk-policy proposal, not an expected-profit recommendation. Unknown loss/yield/cost inputs remain unknown. Same-token moves retain issuer/depeg risk.

**Start monitoring every 5 minutes** runs fresh inspection, forecasts and proposals in the server, recording dependency changes and alerts. Keep the server running. **Stop monitoring** prevents subsequent cycles and rehearsals; an in-flight read may finish. Reports and a journal are saved under ignored `.radar/`; monitoring is not automatically resumed after restart.

**Demonstrate permission-bound execution on a local fork** uses a public EOA holder's actual shares. It deploys a fork-only contract, grants a bounded share allowance once, then lets a separate executor atomically redeem and deposit. It checks rejection cases and resulting balances/output floors. The visible automatic-fork checkbox enables at most one rehearsal per setup and finds a public holder sized for the entered position. No wallet signature is taken. The contract refuses deployment outside local chain 31337. The dashboard sizes the rehearsal from the entered USD position, using fresh reference prices and actual public-holder shares; it refuses amounts exceeding the holder’s balance. The CLI defaults to the holder’s full balance unless raw shares are supplied.

**Prepare an unsigned transaction for your Safe** turns a proposed reallocation into one atomic Safe batch (exact share approval → Morpho Bundler3 redeem + deposit with on-chain share-price floors → approval reset). It checks the owner is a Safe, simulates the batch as that Safe on a private local fork, and only then offers a Safe{Wallet} Transaction Builder file plus an evidence report. Nothing is signed or sent; the Safe's own signers review and execute. CLI: `npm run propose -- <source> <destination> <safe> --fraction 0.1`. Safe accounts only in this version; no on-chain deadline. Details and measured runs: [Safe proposals](docs/SAFE_PROPOSALS.md).

**Show historical evaluation** plots actual March 2023 prices and reports chronological forecast scores, false alarms, cost sensitivity and terminal recovery. It preserves failures: switching out of USDC/DAI during the depeg reduced simulated final wealth after recovery. Historical vault exits/order-book fills are not verified. The UST example is explicitly in-sample.

Advanced tests show **Scenario calculated** and the assumptions-only cost comparison first. **Actual withdrawal** is separate: without a public-owner redemption assessment it says **Not checked**, even when the hypothetical calculation succeeded. Unavailable calculations display their data blockers before the numbers. **Refresh vault data and retry** preserves the selected target and inputs, collects new data and reruns the test; a disappeared target requires a new selection.

For supported direct-market V2 vaults, the server reads the complete active adapter/market lists and balances at one fresh Ethereum block and reconciles idle funds plus adapter holdings to `totalAssets()`. This unlocks conditional loss estimates when all checks succeed; failures remain explicit. The result shows an **assumptions-only comparison** separately from the checked redemption decision, plus the exact inputs still missing. For example, Keyrock's USDC/wstETH market held about 0.6831% of capital during validation: a hypothetical $10,000 position and 20% lender haircut implied $13.66 conditional loss, not $2,000 across the entire vault.

For an owner-specific assessment, enter a **public owner address**. Shares are optional raw units; blank requests the owner's full balance. The server reads balances, `maxWithdraw`, conversion and redemption previews, and estimates gas. It never sends a transaction. Quotes expire after 60 seconds and must match the checked owner/amount. Direct redemption returns the underlying token; it is not a dollar cash-out quote.

**Find a public demo holder** selects an indexed candidate whose nonzero balance and non-contract account are verified with fresh RPC reads. It is explicitly someone else's public position; search is bounded to 20 candidates. Then click **Check withdrawal and estimate gas**. Morpho V2's max functions deliberately return zero, so V2 feasibility uses the actual read-only redemption simulation rather than treating `maxWithdraw == 0` as a withdrawal ban. USD reference prices are refreshed for each quote. A checked full-balance valuation replaces the hypothetical size; the result label distinguishes them.

## Provider configuration

Put these in the local `.env` file:

```dotenv
ETHEREUM_RPC_URL=your-ethereum-mainnet-https-endpoint
ETHERSCAN_API_KEY=your-etherscan-v2-key
MORPHO_API_BASE=https://api.morpho.org
```

Keys stay server-side and `.env` is ignored by Git. Public Morpho and Pendle API reads require no key. Without RPC, indexed Morpho discovery can still run with verification gaps. Generic vault discovery and redemption checks require RPC. An optional `RPC_URL_<chainId>` enables reads on another EVM chain, but Ethereum is the tested network; L2 settlement infrastructure and gas accounting are incomplete.

```bash
npm run check:providers
npm run inspect -- 1:0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB
npm run inspect -- 1:0x04422053aDDbc9bB2759b248B574e3FCA76Bc145
```

Inspection prints actual normalized graph JSON with `schemaVersion`, network/block metadata, provider status, observations, exposure ledger, evidence and unknowns. `--shallow` skips deeper source/Pendle enrichment. For clean redirected JSON, build first and use:

```bash
npm run build
node scripts/inspect.mjs 1:0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB > graph.json
```

## Reproducible stress testing

The historical price benchmark is reproducible offline from the included attributed data (15,098 hourly candles):

```bash
npm run backtest
```

To retrieve provider data again: `npm run data:history`. Hashes and URL/time provenance are retained; no candles are fabricated or forward filled. [Dataset protocol](datasets/PROTOCOL.json), [full results](datasets/backtest-report.json) and [plain-language interpretation](docs/BENCHMARK_RESULTS.md) distinguish price counterfactuals from executable historical vault migrations.

Run a complete live automatic comparison:

```bash
npm run automation -- 1:0x093272c07700d3ca5301c3bf9b3a392624179e2f 10000 1:0x04422053aDDbc9bB2759b248B574e3FCA76Bc145
```

Run the atomic fork demonstration with a public Keyrock holder (balances may change):

```bash
npm run test:fork -- 0x04422053aDDbc9bB2759b248B574e3FCA76Bc145 0x093272c07700d3ca5301c3bf9b3a392624179e2f 0x41f16eb553daed56c50bfc07c1c69b0465caa3b1
```

Anvil uses your RPC's read-only fork data, while all writes go to a newly spawned loopback node on chain 31337. No private key is requested. Setup and execution gas are separated and converted only with fresh USD references. [Contract semantics and remaining limits](contracts/README.md).

Supported Morpho V2 sources with insufficient idle funds and no default liquidity adapter can use a verified, bounded permissionless market withdrawal before redemption. The atomic policy includes its share penalty in spending limits. Unknown routes or insufficient market liquidity are rejected. A [real Hyperithm-to-Keyrock fork proof](datasets/fork-migration-recording.json) is included as a historical recording; it does not establish current feasibility or post-move concentration compliance.

Download a live graph JSON and load it through **Stress-test a saved graph**. Original timestamps remain unchanged; imported records become `historical_replay`. Structural validation does not authenticate imported evidence. This tests a hypothetical failure against recorded exposures; it does not reconstruct a real incident or establish a calibrated incident probability.

Two actual provider recordings are included in [fixtures/recordings](fixtures/recordings/README.md). They permit an offline graph demonstration when providers are unavailable or stale:

```bash
npm run replay -- fixtures/recordings/steakhouse-usdc.json 10000 0.2
```

Replay can estimate a conditional market loss from recorded allocation fractions. Current STAY/EXIT recommendations and fresh withdrawal checks are disabled in replay mode.

The original fabricated example is still available:

```bash
npm run demo
npm run demo -- --graph
```

Use **Load fixture demo** in the dashboard for its 9 nodes and 8 edges. The illustrative $10,000 position, 60% allocation and 20% lender loss yield $1,200 conditional loss. Fixture probability and exit cost are fabricated test inputs, not live estimates.

## What the engine establishes

Edges point **dependent → dependency** and have typed relationships. On-chain reads, API-indexed relationships and documented issuer identities have distinct evidence labels. Dynamic allocations, prices, balances and freshness measurements live in observations and exposures, not permanent financial edge weights.

Market-loss stress uses `position USD × deployed market fraction × assumed additional lender loss`. Vault-capital stress uses an explicit assumed unrecovered shareholder haircut. Both are conditional models with accounting caveats. Oracle, asset, administrator, chain and AMM failures trace affected paths and explain mechanisms; graph connectivity alone never creates a dollar loss. Chain outage can block exit without implying permanent capital loss.

Live STAY/EXIT requires a supported prospective-loss model, an explicit probability assumption, sufficiently consistent/fresh observations and a current, priced, feasible full redemption assessment. Otherwise the result is `INSUFFICIENT_EVIDENCE` or a qualified `EXIT_UNAVAILABLE`. Already-incurred losses are not compared with current execution costs.

## Measured validation and remaining gaps

Read-only Ethereum checks on 2026-10-11 produced the following; counts change with allocations and provider state:

| Example | Mode | Nodes / edges | Edges supported by contract reads |
| --- | --- | --- | --- |
| Steakhouse USDC V1 | Enriched live | 68 / 147 | 86 |
| Gauntlet WETH Prime V1 | Shallow live | 22 / 44 | 19 |
| Keyrock USDC V2 with Pendle | Enriched live | 90 / 193 | 130 |

The V2 example includes settlement, yield-source/principal, oracle, AMM venue and lending-market categories. This establishes their observed relationships, **not complete coverage** of every hidden dependency. `TRADED_ON` is a corroborated venue association; it does not imply the lending oracle uses that AMM or that a position-sized sale is executable.

Material limitations:

- V2 indexed allocations lack a common query block anchor. Supported direct Morpho market adapters now replace financial inputs with one-block contract reads, including complete active-market enumeration, and reconcile them before enabling numbers. Nested/unknown adapters, undiscovered active markets, inconsistent totals/rate-cap effects, read failures and unresolved accounting still suppress estimates.
- V2 adapter and market-position lists paginate in batches of 20, bounded to 32 adapters and 200 indexed positions per adapter. Changed/duplicate lists, missing pages, request failures and exceeded budgets remain incomplete and block estimates. Pinned accounting separately bounds active-market enumeration to 128 per adapter. Listed-vault and Pendle venue catalogues also paginate. Unlisted Morpho addresses try GraphQL.
- Enrichment is bounded: four RPC requests in flight, 600 RPC operations per inspection, 60 enriched entities, 40 source lookups, nested vault depth four. Missing ABIs, provider failures, cycles and budgets produce unknowns.
- Indexer lag was observed during validation. Anchor blocks older than 15 minutes and inspections older than five minutes suppress current numerical estimates. Saved recordings remain available for historical stress testing.
- USDC issuer identity is documented; reserve sufficiency, custodians and redemption eligibility are not independently established. SY reference assets are not assumed to be backing assets.
- Feed age is measured without inventing feed heartbeat policies. Borrower-level liquidation/bad-debt models, AMM stress slippage, swap exit quotes and recovery models remain unimplemented. Contract/delegated-account owners need a wallet-specific execution model; their redemption feasibility remains unknown.
- Source scanning covers selected getters and ERC-1967 patterns, not arbitrary storage, every proxy design, traces or static program analysis. No AI-generated relationships or probabilities are presented as verified.
- Multi-position portfolio accounting, complete Aave/Pendle position adapters, bridges and non-EVM chains remain roadmap work. Monitoring now refreshes supported vaults every configured interval and detects verified dependency changes; it is not a universal incident feed. In-memory jobs/snapshots are lost when the local server stops; automation reports/journals persist locally.
- The price model has one training collapse and fails to beat the constant-probability baseline on held-out USDC. Different mechanisms, overlapping labels, historical revisions and live regime/venue drift prevent a calibrated execution claim. Reallocation currently enforces concentration limits; full expected-loss/yield optimization, cross-asset swaps, historical vault liquidity, production account delegation and reviewed live activation remain missing.

Additional read-only validation on 2026-10-11 reconciled Keyrock's one adapter and nine active markets at block 26166593. The screenshot scenario ($10,000, 20% haircut, 25% probability, $500 assumed exit cost) produced about $13.66 conditional loss and $3.42 expected loss. A public holder's full redemption simulation succeeded despite V2's zero max function, returning underlying USDC with about $0.09 estimated gas cost at that state. These observations and scenario assumptions are not an incident forecast, actual executed trade or guaranteed future quote.

The Hyperithm USDC Apex regression (`0x093272c07700d3ca5301c3bf9b3a392624179e2f`) previously returned only 20 of 37 indexed markets and refused numerical loss. Pagination now retrieves all 37 and permits complete pinned accounting. At block 26166796 the mHYPER market represented about 0.095896% of the vault: a hypothetical $10,000 position, 20% lender loss, 25% probability and $300 assumed exit cost produced $1.92 conditional loss and $0.48 expected loss. These figures describe the supplied stress test; actual withdrawal still requires a separate check.

## Checks

```bash
npm test
npm run typecheck
```

Tests cover real captured API normalization, V2 paths, unlisted fallback, invalid addresses, nullable oracles, changing/duplicate capital exposures, cycles, missing evidence, provider failures, venue mismatches, quote freshness, restricted withdrawals, reorgs and replay validation. Automatic assessment tests also reject fabricated probabilities/loss, unverified rounds, stale/unanchored records and duplicate capital. They run offline; one network smoke test is opt-in with `RUN_LIVE=1`.

Browser verification needs Playwright Chromium and live network access:

```bash
npx playwright install chromium
npm run test:browser
```

An existing Chromium installation can be used with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium npm run test:browser`.

It checks rendered live nodes/edges, amount-only observational assessment, advanced failure scenarios, recording import, fixture switching, evidence keyboard interaction, mobile overflow and credential isolation. Browser QA servers close automatically.

## Design and sources

[Roadmap](docs/ROADMAP.md), [graph semantics](docs/GRAPH_AND_DISCOVERY.md), [risk models](docs/RISK_ENGINE.md), [evaluation](docs/EVALUATION.md), and [challenge traceability](docs/BELEM_BRIEF_TRACEABILITY.md) distinguish implemented slices from research goals. [Implementation notes](docs/IMPLEMENTATION.md) describe the local API and provenance.

The primary integrations follow [Morpho's official API](https://docs.morpho.org/developers/api/morpho-vaults/), [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626), [ERC-1967](https://eips.ethereum.org/EIPS/eip-1967), [Pendle's official API](https://api-v2.pendle.finance/core/docs), [Pendle's contract documentation](https://docs.pendle.finance/pendle-v2-dev/Contracts/YieldTokenization), and [Circle's USDC contract registry](https://developers.circle.com/stablecoins/usdc-contract-addresses). Attributed public response captures are in [fixtures/upstream](fixtures/upstream/README.md). No third-party application implementation was copied.
