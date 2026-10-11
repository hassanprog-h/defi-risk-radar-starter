# Copy/paste this instruction into Codex

**Implementation status:** the original M1 request below has been completed. The user later authorized broader development; live dashboard, V2 traversal, Pendle venue enrichment, scenarios, redemption assessment and recording stress tests are now present. Read the current README and [delivery status](docs/ROADMAP.md) before choosing further work. Do not recreate the original fixture-only architecture or assume every roadmap milestone is complete.

You are beginning the **DeFi Risk Radar** implementation for the EPFL/Belem Capital DeFi Risk Dependency Challenge.

First, read `README.md`, `AGENTS.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/GRAPH_AND_DISCOVERY.md`, `docs/RISK_ENGINE.md`, `docs/ROADMAP.md`, `docs/REFERENCES.md`, and `docs/EVALUATION.md`. Inspect the existing fixture-only TypeScript domain core and run `npm test` and `npm run demo`.

## Product vision — ambitious but honest

Build a **read-only, evidence-backed and eventually cross-protocol DeFi risk operating system**. It should accept a vault address (eventually any wallet or DeFi position), **automatically discover and continuously refresh its real dependency graph**, monitor live prices/oracles/market state, let the user inject an incident at any dependency, trace plausible propagation mechanisms, quantify *incremental position loss* or operational blockage, and compare risk against realistic exit feasibility and cost. Its output must be explainable enough for a portfolio manager to act on. We aim at arbitrary ERC-4626 vaults with progressively deeper adapters for Morpho V1/V2, Pendle, Aave and more, and ultimately thousands of positions in a shared graph. We do **not** falsely guarantee that any arbitrary vault can be fully understood automatically.

## Implement ONLY the first vertical slice now

1. Keep the existing `src/core`, tests, and fixture CLI functional.
2. Add `src/adapters` interfaces and a read-only Morpho Vault V1 adapter using **official API docs** at https://docs.morpho.org/developers/api/morpho-vaults/ and official blockchain contract reads where useful. Use the current documented API; never invent response fields.
3. Add `src/connectors` for configurable Ethereum RPC and Morpho API, with bounded requests, clear timeouts/errors and optional caching. Use viem if available; document requirements.
4. Accept `<chainId>:<vaultAddress>` as input. Retrieve the real vault, identify underlying asset, owner/curator, allocation markets where supported; for each market identify loan asset, collateral and oracle as actually available. Build nodes/typed edges with source-evidence, `mode=live`, timestamps, consistent block metadata, and explicit unknowns. **No hardcoded demo graph for live mode.**
5. Add a small CLI command such as `npm run inspect -- 1:0x...` to print normalized graph JSON and completeness report. Provide a documented, verified example vault address only if sourced from official docs; otherwise ask the user for one.
6. Test the normalization layer with captured, appropriately attributed API response fixtures and mock fetch/RPC; include at least one optional live smoke test that gracefully skips without network access.
7. Add `npm run typecheck`, `npm test` and integration documentation. Do not break mock/demo execution.
8. Stop after this slice; list exact implemented capabilities, commands, sources and known gaps. Do not claim risk simulation is live or universal yet.

## Next milestones (plan but don't preimplement)

- Morpho V2 adapter-aware tracing, listed/unlisted enumeration, and wider vault scanning.
- Generic ERC-4626 scanner, proxies/admins, verified source, transaction traces, optional Slither; AI candidate extraction with verification.
- Graph UI with click-node-to-incident and reverse impact highlighting.
- Live oracle freshness and liquidatable exposure model, one financially defensible scenario at a time.
- Withdrawal feasibility / sell-route quotations, break-even incident thresholds and qualified stay/exit decisions.
- Pendle PT chain: settlement -> underlying yield/issuer -> oracle -> PT AMM -> lending collateral.
- Historical incident replay from a pre-incident snapshot; source-backed precision/recall and loss validation.

## Non-negotiables

- State `fixture`, `live`, or `historical_replay` in every result.
- Never use an LLM to create "verified" relationships or assumed probabilities.
- Never use a graph edge alone as evidence of dollar loss.
- Never recommend an exit that is impossible under current chain/withdrawal constraints.
- No trade execution, no wallet signing, no handling private keys.
- Prioritize measurable depth and correct failure propagation over a broad but misleading risk score.
