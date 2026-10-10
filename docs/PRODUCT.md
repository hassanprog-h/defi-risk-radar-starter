# Product / Vision — DeFi Risk Radar

## Objective (the Belem challenge)

Belem asks for a working risk engine using **real data** that automatically discovers hidden on-chain position dependencies, estimates the economic consequence of an incident in one dependency, then helps answer **stay or exit despite slippage/execution costs**. Their published score weights are: dependency discovery 30%, impact estimation 30%, decision usefulness 25%, and live working demo 15%. The challenge allows many ecosystems and modelling approaches; it does **not** mandate every ecosystem or every scenario.

## Plain-English analogy

This is a **software dependency scanner + attack-path simulator + financial loss calculator**. A web app can depend on a DB, auth provider and cloud region; a DeFi vault can depend on a yield source, collateral, price oracle, market, smart contract, administrator, DEX for exit and settlement chain. Failures need not imply money is lost; an outage might simply block withdrawals.

## North-star product (very ambitious)

- Input: any supported DeFi wallet, position, ERC-4626 vault, lending market or Pendle instrument; batch-scan newly discovered vaults automatically.
- Output: shared, chain-aware, typed dependency knowledge graph with **true economic and operational meaning**, source evidence, time/version, missing-data score and live signals.
- Analysis: simulate a specific incident at a graph node; trace dependent positions, affected mechanisms, capital at risk, liquidation/market price effects, withdrawal restrictions, uncertain recovery and available exit paths.
- Decision: position-level and portfolio-level incremental loss ranges, real execution costs or infeasibility, break-even scenario probabilities, qualified STAY/EXIT/UNKNOWN.
- Research: discover poorly documented relationships from ABIs, source code, traces and optional LLM-assisted extraction. Evaluate across unknown protocol families.
- Long term: Ethereum and other EVMs, Solana, and newer settlement chains; shared risks, concentration, contagion, real-time alerting and historical replay.

## The end-to-end user journey

1. User selects a real, preselected demo vault or inputs chain + vault address. Later select wallet/portfolio.
2. System detects vault type, fetches on-chain/API state, discovers typed edges and tells user what is verified vs incomplete.
3. Interactive graph renders position -> vault -> lending markets -> assets/oracles/exit routes -> infra/controls; click node for evidence and live health.
4. User selects failing node + scenario type + severity + time horizon; or clicks a live warning and runs a scenario.
5. Rule-based simulator computes **which paths are impacted**, *why*, and whether monetary losses can be justified. Unsupported scenarios show qualitative risk/unknown, not invented money.
6. Compute feasible redemption or swap exit cost at actual position size and chain status. If impossible, show blocked exit.
7. Decision report: scenario loss, expected loss only with legitimate probability assumption, break-even probability, exit costs, risk factors, confidence/coverage and citations to raw evidence.
8. Save/share scenario report, compare snapshots and follow changing exposure (future).

## Roles and story

Primary user: portfolio manager monitoring a 5–20 position portfolio. Secondary user: security/risk analyst examining an oracle failure, compromised bridge, admin upgrade, contract exploit, TVL concentration or unusual on-chain activity. For the hackathon, a read-only analyst dashboard is enough; no trading functionality is expected.

## Dependency scope / ontology

1. Settlement/network: chain, rollup/sequencer, bridge and messaging (where applicable).
2. Underlying economic backing: accounting assets, wrapped assets, issuers, redemption and yield sources.
3. Protocol financial flows: vault allocations, lending markets, collateral/borrowing, AMM liquidity, derivatives/perps (future).
4. Data and control: oracles, administrator/multisig, proxy implementation, governance, timelocks.
5. Exit mechanics: direct withdrawal/redemption constraints, DEX routes, executable liquidity, fees and gas.
6. Contagion (separate layer): shared collateral, correlated markets, liquidation sell pressure.

The graph schema should represent all six groups. **Full automated data coverage for every group on every position is a long-term goal, not a day-one claim.**

## Scope boundaries

The product does not custody money, sign transactions, auto-execute trades, predict hacks with certainty, certify smart-contract safety, or provide a guaranteed forecast. It is an exploratory risk decision-support prototype.

## Two demonstration positions vs hundreds of scanned vaults

A preselected vault is a repeatable test and demo fixture; it is NOT the code's hardcoded dependency map. The same adapter should process any vault of its supported protocol version. Batch scanning across many vaults measures coverage; a few hand-verified cases demonstrate correctness and financially defensible simulation. Both matter.
