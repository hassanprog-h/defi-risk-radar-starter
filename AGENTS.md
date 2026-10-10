# Codex operating instructions — DeFi Risk Radar

Read `README.md` and every document in `docs/` before changing architecture. This project is an ambitious hackathon prototype for a financial risk engine, **not** a trading bot. Accuracy and source provenance beat flashy claims.

## Your first task

Implement **Milestone 1 in `docs/ROADMAP.md`**: a read-only, live Morpho Vault V1 adapter with a real Ethereum vault selector, network-aware snapshot metadata, evidence-backed graph edges, validation and tests. Then expose a CLI or small API that renders an actual graph JSON. Keep fixture demo functioning. See `CODEX_START_HERE.md` for full acceptance criteria.

## Product constraints

1. Treat graph nodes as heterogeneous: `position`, `vault`, `lending_market`, `asset`, `oracle`, `yield_source`, `issuer`, `amm`, `chain`, `bridge`, `administrator`, `contract`, `exit_route`.
2. Direction: `dependent -> dependency`. Example: `market --USES_ORACLE--> oracle`.
3. Type every edge. Include provenance: on-chain tx or contract read, API source, block number and timestamp where possible; explicit evidence-status, and source-of-truth hierarchy.
4. A verified on-chain relationship is different from an LLM-inferred candidate. Keep inference separate until independently checked.
5. Share nodes by stable network-specific identifiers: EVM `eip155:<chainId>:<lowercase-address>`, with protocol-specific logical IDs for markets where no unique address exists; off-chain identifiers must be namespaced.
6. Dynamic values (balances, weights, prices, quotes, oracle freshness) must be stored in **snapshots**, not treated as immutable edges.
7. The API must degrade gracefully: rate limit, stale RPC/API, unknown ABI, unlisted vault, reorgs, unavailable archive, incomplete graph.
8. Distinguish an **incident observation**, **hypothetical scenario**, **estimated exposure**, **modelled loss** and **assumed probability**. The UI must label these separately.
9. Simulator MUST NOT produce dollar loss solely because an oracle/chain/admin node is connected to a position. Require an explicit economically justified propagation model.
10. No guaranteed stay/exit when data are incomplete. Implement `STAY`, `EXIT`, `EXIT_UNAVAILABLE`, and `INSUFFICIENT_EVIDENCE`.
11. Exit comparisons are **forward looking**: compare additional losses avoidable by exiting against *currently feasible* exit cost; never compare already-incurred sunk losses.
12. Mainnet interactions are **read only**; do not request users' private keys, submit txs or execute trades.

## Engineering process

- Implement vertical slices, not an empty megarepo. Every milestone should have a working command and tests.
- Verify API schemas against current upstream docs; don't hallucinate response keys or addresses.
- Use API/RPC contracts for ground truth before static calls, runtime traces, or AI.
- Test with a real, verifiable vault AND adversarial fixtures, including unknown oracles, cycles, repeated dependencies, missing edge evidence, changing allocations, and impossible exits.
- Isolate adapters behind a small interface. Keep domain types independent of provider-specific shapes.
- Avoid deep recursion loops, duplicate contract traversal, and N+1 public API requests. Use snapshot caching and controlled concurrency.
- Include `schemaVersion`, `observedAt`, `chainId`, `blockNumber` and provider status with live records.
- Document all modelling assumptions in returned output. A probability guessed by an LLM is not a calibrated probability.
- Validate input addresses and sanitize remote responses. Never store user secret keys.
- Do not copy third-party code without checking applicable licenses (Slither is AGPL-3.0; other projects differ).

## Definition of done for a milestone

- A command/endpoint works with real data or is prominently labelled fixture-only.
- Unit tests and typechecking pass.
- Every displayed dependency can be traced to evidence, or is visibly marked unverified.
- Explicit errors/unknowns are present; no fabricated fallbacks.
- The README's stage list is updated, with real measured limitations.
