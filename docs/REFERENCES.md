# Data providers, standards, third-party projects and research

Links below are *starting points*, not warranties of coverage or compatibility. Confirm APIs and licenses as they change. Never combine several external repositories blindly or copy without reviewing licenses.

## Official data sources — prioritize these first

1. **Morpho developer API:** https://docs.morpho.org/developers/api/morpho-vaults/ — official listed V1/V2 vault REST discovery, market/vault data and GraphQL for unlisted vaults. Public API host `https://api.morpho.org`. Careful: indexed API blocks and on-chain reads need time/block alignment.
2. **Morpho Vault V2 design:** https://docs.morpho.org/learn/concepts/vault-v2/ — V2 adapter, realAssets, cap and role semantics. Never treat V2 as V1.
3. **ERC-4626:** https://eips.ethereum.org/EIPS/eip-4626 — standardized vault accounting and redemption interface; doesn't describe nested deployments or underwriting risk.
4. **ERC-1967:** https://eips.ethereum.org/EIPS/eip-1967 — proxy implementation/admin storage for certain proxy patterns.
5. **Ethereum RPC via viem:** https://viem.sh — contract reads, multicall, event logs; batch queries and anchor at a specific block where feasible.
6. **Chainlink price-feed docs:** https://docs.chain.link/data-feeds/overview — prices/update timestamps, supported sequencer status feeds; not every oracle is Chainlink.
7. **Uniswap developer docs:** https://docs.uniswap.org — current pool data and quoting, provided a real tradable route exists; gas/fees and quote freshness matter.
8. **Pendle developer docs:** https://docs.pendle.finance — future PT/YT/market/underlying and swap/AMM adapter.
9. **L2BEAT:** https://l2beat.com and https://github.com/l2beat/l2beat — L2 governance, bridges, settlement assumptions. Context layer, not full live sequencer monitoring.
10. **DeFi incident datasets:** https://github.com/DeFiHackLabs/DeFi-Hack-Chronicle — historical case studies, for *replay* not calibrated unconditional incident probabilities.

## Existing implementation references

| Repository | What to study | Caution |
| --- | --- | --- |
| Panorama — https://github.com/ohMySol/Panorama | BFS contract dependency graph, verified source and visual approach | Contract graph alone cannot model financial risk; check reuse license |
| PRIP — https://github.com/TanguyLaucournet/protocol-risk-intelligence-platform | Source-backed protocol/governance/security knowledge graph | Research project; automated scoring is not its mature core |
| Tare-Vault — https://github.com/rocketpowerkille/Tare | Wallet -> vault -> exposures and honest uncertainty | Check exact supported integrations and license |
| Aegis — https://github.com/Shivannsh/aegis | Depeg/oracle/bridge/lending incident signals | Check models and actual production readiness |
| Faultline — https://github.com/KrishVenky/Faultline | Liquidations and price-shock contagion | Market-risk only, not entire dependency stack |
| Exit Drill — https://github.com/Nakshatra05/exit-drill | Liquidity stress, exit modelling | Simulated cost is not necessarily executable mainnet quote |
| Slither — https://github.com/crytic/slither | Static call graphs, permission inspection and candidate technical edges | **AGPL-3.0** license; its graph is not a financial exposure graph |
| Morpho Vault V2 — https://github.com/morpho-org/vault-v2 | Actual V2 adapters and allocations | Reading official contract sources is stronger than guessing ABI fields |

Use existing code **as documented inspiration**, and prefer upstream SDKs/official contract libraries where possible. For copied code, perform license review first. Slither could be invoked as a separate developer tooling stage subject to license obligations.

## Research methods worth exploring (not mandatory for first demo)

- **On-chain contract dependency graphs:** combine call and delegatecall traces with upgradeability/admin checks. A call graph is not an economic dependency graph; classify its semantics first.
- **Program analysis:** source AST, intermediate representation, dataflow/authorization analysis via Slither or similar tools; extract candidate feed/admin/protocol edges.
- **Graph-based contagion:** scenario-specific propagation plus unique capital-exposure accounting; shared collateral and forced-selling liquidity can connect positions without direct contract calls.
- **Static + dynamic evidence fusion:** compare contract configuration, historical traces, and indexer output to classify inferred vs verified edges.
- **ML for unknown contracts:** structured relation extraction over source/docs, gold-label evaluation, optional fine-tuning only if precision/recall improve on unseen protocols. LLM class confidence ≠ risk probability.
- **Scenario robustness:** sensitivity ranges, worst-case bounds, historical replay anchored before incident, and risk-model explainability.

These are proposals for investigation, not claimed implemented features in the starter.

## Terminology / risk of misleading evidence

- `totalAssets` is protocol accounting, not guaranteed immediately liquid capital.
- A vault cap is not the same as actual deployed exposure.
- A stablecoin peg deviation can affect dollar-denominated asset value without implying identical bad debt.
- A market price from a DEX is not an executable quote for a large position.
- A newly discovered contract reference is not proof that investor capital relies on it.
- An API showing live indexed state is not guaranteed atomic with another provider's latest chain block.
