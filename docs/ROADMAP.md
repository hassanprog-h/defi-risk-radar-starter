# Delivery roadmap: vertical slices first, universal vision throughout

**Rule:** Build a working proof at every step. Do not declare a feature complete because a schema contains its node type. "Any vault" means the engine accepts any vault address and reports what it can verify, not complete universal semantic understanding.

## Delivery status — 2026-10-11

The user subsequently authorized building the broader application. M1 is implemented and checked with two real V1 vaults. Working portions of M2–M6 are now integrated into the local dashboard; the milestones below remain the target acceptance criteria, not blanket completion claims.

| Milestone | Current state |
| --- | --- |
| M0 | Fixture core and visual explorer functional |
| M1 | Live V1 adapter, RPC corroboration, actual JSON CLI, network/provenance metadata, captured-response tests and two real vault checks implemented |
| M2 | V2 adapter/nested traversal, paginated vault directory and adapter/position lists, GraphQL unlisted fallback, generic ERC-4626 accounting and bounded source/proxy enrichment implemented; one-block direct-market accounting implemented; nested accounting and discovery beyond configured pagination budgets remain incomplete |
| M3 | Live address selector, graph interaction, evidence, coverage, scenarios and export implemented with native SVG/JavaScript and a local Node API; no React Flow dependency required for this slice |
| M4 | Snapshot measurements, feed round data, conditional V1/reconciled V2 market-loss and explicit vault-capital stress implemented; assumptions-only comparison and actionable missing-data requirements implemented; borrower bad-debt/liquidation models remain pending |
| M5 | Public-owner direct redemption preview, verified example-holder finder, correct V2 zero-max semantics, refreshed pricing, read-only gas estimate, quote freshness and qualified decisions implemented; swap execution quotes, queues and advanced route models remain pending |
| M6 | Pendle PT/SY links and associated venues corroborated inside real Morpho graphs; documented USDC issuer identity and selected wrappers/proxies implemented; complete protocol position adapters and backing discovery remain pending |
| M7–M8 | Research and platform goals remain pending |

Saved real-provider graphs can be imported for explicitly labelled hypothetical historical stress testing. This is not a calibrated real-incident replay benchmark. See [implementation details](IMPLEMENTATION.md) and the README for measured graphs, commands and limitations.

## Updated priority — automatic assessment and reallocation

The user's 2026-10-11 conversation with Belem expands the target to automatic forecasts, destination comparison and potentially bounded delegated execution. This sequence supersedes the original suggested sequence without declaring unfinished models complete. See [AUTOMATION_AND_REALLOCATION.md](AUTOMATION_AND_REALLOCATION.md) for acceptance criteria.

- **Implemented:** amount-only observations plus live stablecoin price checks and an experimental historical regime model; 15,098 real hourly candles, chronological scoring, quiet periods and honest recovery/false-alarm evaluation. See [benchmark results](BENCHMARK_RESULTS.md). This does not establish calibrated live probabilities.
- **Implemented:** fresh real destination comparison and minimum partial reallocation under concentration limits, including shared capital factors and retained issuer/core-protocol risks. Full expected-loss/yield optimization remains pending.
- **Implemented:** five-minute server monitoring, persisted reports/change alerts and optional one automatic local-fork rehearsal per setup. An atomic fork-only policy contract and real source/destination tests validate migration permissions, outputs and balance invariants; gas/reference-price costs are measured. No mainnet execution is activated.
- **Verified:** the full live dashboard path and Hyperithm-to-Keyrock forced-liquidity migration passed, with fee shares included in permission bounds. Timestamped proofs are included in `datasets/`. Offline tests: 58 passed, one optional live smoke test skipped; typechecking and browser checks passed. Post-execution concentration reconstruction remains pending.
- **Next:** borrower health/liquidation/recovery models, wider independent event coverage and model uncertainty/drift validation; executable cross-asset swap routes and comparable destination loss/yield forecasts; production wallet delegation and audit.
- **Activation:** mainnet remains read-only until concrete execution, policy and simulation are reviewed and real execution explicitly enabled.

## Milestone 0 — Executable domain seed (included)

- Typed node/edge model with structural + financial relationship types.
- Reverse BFS from a failed node to an impacted position.
- Hypothetical market loss on verified vault allocation; no automatic oracle/chain monetary estimate.
- Decision engine with explicit probability assumption and infeasible/unknown exit states.
- CLI fixture demo; unit tests.
- **Check:** `npm run demo && npm test` runs without external API access after dependency install.
- **State:** demo fixture only, not live blockchain.
- **Local visual explorer:** `npm run dev` serves live inspection at http://localhost:3000. Load the separate fixture explicitly using **Load fixture demo**.

## Milestone 1 — FIRST CODEX TASK: single real Morpho Vault V1 end-to-end discovery

- Input any supported Ethereum Morpho V1 vault address (chainId+address).
- Use the official Morpho API to fetch identity, asset, governance roles, and actual market allocations; retrieve market info and configured collateral/oracles using documented API fields.
- Verify key relationships on-chain where reasonably possible; preserve source, time, API index lag/block and unknowns.
- Normalize to `GraphSnapshot`, validate and output JSON in CLI.
- Add mocked connector tests, wrong-address and missing-info cases; optionally run live smoke test.
- Demonstrate **a second vault address** without writing another parser or manually editing graph edges.
- **Acceptance:** no static graph in live path; every claim has provider evidence; `mode=live`; no upstream schema guesses; tests/typecheck pass.

## Milestone 2 — Coverage, V2 and generalized identification

- Support Morpho V2 **with adapter traversal** and correct role/gate semantics. Avoid representing V2 like V1.
- Enumerable listing + pagination for listed vaults; GraphQL for unlisted if supported and required. Handle indexer delays and rate limits.
- Add generic ERC-4626 `asset`, `totalAssets`, and withdrawal/read-only metadata detection; unknown allocations visibly marked incomplete.
- Proxy/admin/ownership discovery and contract dedup; multiple networks keyed separately.
- **Acceptance:** scan many addresses automatically; publish count analysed, verified edges, missing categories and failures; manual gold inspection of >=3 diverse examples.

## Milestone 3 — Interactive live dependency dashboard

- Next.js/React Flow UI with position search and preselected example vault; no hardcoded graph.
- Color nodes by type; clicking a node displays source/evidence, last-seen and live observations.
- Right-click/click "simulate failure" on any node; dependency reverse traversal highlights affected vaults.
- Show `verified`, `inferred`, `unresolved` + unknowns. Live/fixture labels unmissable.
- **Acceptance:** choose two real vaults and render different auto-discovered graphs; show shared node dedup.

## Milestone 4 — Live measurements + trustworthy scenarios

- Oracle freshness, price feed status, market/asset prices, current allocations, position sizes, current withdrawal limits.
- Scenario A: verified market capital loss with rigorous accounting assumptions.
- Scenario B: collateral shock -> borrower health and liquidation exposure *if borrower data and market mechanics are available*; if not, return qualitative paths and unresolved loss.
- Scenario C: oracle outage/manipulated price -> trace affected markets and possible mechanisms; numeric loss only if implement defensible bad-debt model.
- Scenario D: chain outage/withdrawal unavailable: operational consequence, no fabricated permanent loss.
- Include smart-contract exploit as parameterized "x% loss of funds at risk" stress case with assumptions.
- **Acceptance:** change severity, rerun, see paths and correct cost changes; no contradictory outputs.

## Milestone 5 — Live exit costs and decision

- Position-specific direct redemption `maxWithdraw` / preview or queue/gating semantics; fallback swap quote only for actual tradable routes.
- Capture exit amount, fee, network gas, slippage, source and quote staleness.
- Compare *avoidable future loss* with exit cost, return STAY, EXIT, EXIT_UNAVAILABLE or INSUFFICIENT_EVIDENCE.
- Output break-even probability when event chance unknown; show horizon.
- **Acceptance:** no exit recommendation for unavailable route, missing quote, or stale network. Never execute transactions.

## Milestone 6 — Additional protocol families and security

- Pendle PT adapter following Belem five layers: chain, underlying yield/issuer, oracle, PT market/AMM, and optional lending collateral.
- Aave and nested vault adapters; asset wrappers, issuer backing and bridges.
- Source/ABI/trace scanning and isolated Slither analysis. Treat contract calls as unclassified until semantically validated.
- **Acceptance:** consistent ontology across distinct protocol families, category coverage reporting.

## Milestone 7 — Research frontier: AI and universal discovery

- Build gold-labelled dependency dataset from known adapters and manually checked contracts.
- Baselines: standard read, rule-based extraction, static source, traces. Compare optional LLM structured extraction and fine-tuning on *unseen protocols*, not just unseen vault instances of same protocol.
- Measure precision/recall, materiality-weighted missing edges, coverage, false-positive finance consequences, latency/cost per graph.
- AI candidate dependency edges require evidence and validation before upgrading to `verified`.
- **Acceptance:** quantifiable lift over deterministic baselines; don't include AI just for a demo gimmick.

## Milestone 8 — Long-term platform scale (beyond hackathon)

- Multi-chain EVM graph, bridges, L2 infrastructure, issuer data and off-chain monitoring.
- Millions of entities, graph updates by events, incident feed ingestion, portfolio/watchlists, historical timelines.
- Cascading liquidation and AMM market impact, uncertainty calibration, risk limits, multi-event portfolio scenarios.
- Solana, Canton, Tempo through explicit chain-specific integrations (not implied by EVM contract analysis).
- Alerting, audit logs, resilience against chain reorgs/indexer lags, enterprise security review.

## Suggested hackathon sequence (adapt to team/time)

**Start first:** M1. Get actual data, parse it, and print a verified graph. Then M3 minimal UI plus M4 one complete scenario and M5 exit-feasibility/break-even comparison. Expand M2 or M6 if time. Large-scale enrichment/AI is a stretch goal, not allowed to block usable live-demo results.

## Ownership areas for a small team

- Developer A: live data adapters, RPC, evidence and discovery accuracy.
- Developer B: graph ontology, traversal, storage and visualization.
- Developer C: incident propagation, financial models, exit-cost/decision logic.
- Developer D (if available): source/static research, evaluation/historical replay, AI-extraction experiments and demo polish.

## Priority when time runs short

1. Correct live dependency graph for one repeatable real vault.
2. Evidence-backed propagation of one important failure with money-at-risk calculation.
3. Exit feasibility/cost and honest decision result.
4. Additional types, portfolios, AI and chain coverage.
