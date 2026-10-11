# Evaluation, testing, reproducibility and demo plan

## Evaluation against Belem's four criteria

- **30% discovery:** breadth+correctness, evidence per dependency, known coverage/unknown gaps, graph recursion beyond top-level vault, materiality-aware edge evaluation.
- **30% impact:** explain how failure flows through the precise capital/accounting path; show data/assumptions; don't equate volatility with losses or outages with stolen funds.
- **25% decision:** prospective incremental risk vs feasible exit cost, quote amount/currency/freshness, break-even assumptions, outcome and caveats.
- **15% demo:** real named vault data, reproducible prompts, incident control changes outputs, simple usable UI, at least one before/after data snapshot.

## Discovery benchmarks

Build gold annotations for diverse sample vaults. Each annotation has `(chain, position, source node, target node, relationship type, active block interval, evidence)`. Compute:

```text
precision  = true discovered edges / all discovered edges
recall     = true discovered edges / all gold edges
coverage   = vaults analyzable to required depth / inspected supported vaults
materiality-weighted recall = sum(critical gold exposure weights recovered) / total
```

Compare deterministic API/ABI baseline versus static source/traces and optional AI; ensure train/test partitions by **protocol family** to measure generalization. Report when gold truth itself is incomplete.

## Risk/backtest methodology

The automatic forecasting/reallocation target additionally requires chronological probability calibration, quiet-period false-alarm evaluation and replay of feasible source-to-destination migrations. Benchmark retained shared risks and destination loss, not just avoided source loss. Permission-boundary and local-fork execution checks are separate from forecast accuracy. See [acceptance criteria](AUTOMATION_AND_REALLOCATION.md).

- Pick a historical on-chain incident with available replay evidence and a relevant supported protocol, rather than choosing a famous incident unrelated to our adapter.
- Freeze state to block *before* event or first detectable signal; avoid future information leaking into the model.
- Reconstruct exposure / applicable oracles / liquidity and available exit paths at that time. If an archive or historical liquidity data are missing, say so and narrow claim.
- Apply the scenario model and compare with observed constraints and economically realized losses where independently reported.
- Provide scenario sensitivity: severe/moderate/minor assumptions and resulting decision or break-even thresholds.

## Automated test classes

- Graph: cycles, repeated shared oracles, cross-chain identical addresses, node/edge dedup, depth/call budgets, dangling edges, stale evidence.
- Adapters: changing fields, null markets, zero allocation, market with no oracle, unlisted vault, Morpho V2 adapter indirection, indexer lag.
- Risk: no dollar loss for mere oracle staleness, loss allocation counts unique capital, zero exposure, over-100% nonsensical weights rejected, complex leverage model marks unsupported.
- Decision: no probability -> threshold/insufficient; no quote -> insufficient; network outage -> unavailable; negative fees rejected; observed sunk loss excluded; unit/currency conversion checks.
- Network: RPC failures, malformed addresses, API 429 retries/budgets, missing archive, reorg/new block consistency.
- UI: simulated incident at graph node highlights paths and labels fixture vs live accurately.

## Suggested 4-minute live demo

1. **00:00–00:30:** explain "one vault hides multiple protocols, data feeds and exit constraints" with source-backed real position.
2. **00:30–01:30:** select a prelisted real Morpho vault; **recompute** dependency graph using live API/RPC; click market, oracle, chain and see evidence.
3. **01:30–02:30:** fail a real oracle or market in a *hypothetical* scenario, highlight propagation and show which position capital is exposed; stress-test severity.
4. **02:30–03:30:** show withdrawal feasibility and estimated exit costs, compare scenario loss and break-even assumption; show STAY/EXIT/UNKNOWN as appropriate.
5. **03:30–04:00:** select a second vault with same discovery pipeline; report measured scanner coverage, known gaps, and future universal architecture.

## Demo reliability

- Have a clearly marked cached **real-data snapshot** for API outages (including retrieval time and original evidence); do not call it live if replayed.
- Keep a separate **fixture mode** that never masquerades as real market data.
- Log request latencies and unknown field counts; gracefully fail or degrade when provider unavailable.
- Verify all numerical assumptions, units and sources before submission.
