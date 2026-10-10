# Delivery roadmap: vertical slices first, universal vision throughout

**Rule:** Build a working proof at every step. Do not declare a feature complete because a schema contains its node type. "Any vault" means the engine accepts any vault address and reports what it can verify, not complete universal semantic understanding.

## Milestone 0 — Executable domain seed (included)

- Typed node/edge model with structural + financial relationship types.
- Reverse BFS from a failed node to an impacted position.
- Hypothetical market loss on verified vault allocation; no automatic oracle/chain monetary estimate.
- Decision engine with explicit probability assumption and infeasible/unknown exit states.
- CLI fixture demo; unit tests.
- **Check:** `npm run demo && npm test` runs without external API access after dependency install.
- **State:** demo fixture only, not live blockchain.

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
