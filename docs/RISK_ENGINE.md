# Failure simulation and stay/exit decision — financial primer

## Finance concepts in developer language

- **Position:** Your stake in a strategy, e.g. $10,000 of vault shares.
- **Vault:** Application managing deposited capital across one or more strategies/markets.
- **Collateral:** Property posted by borrowers as security for a loan; price declines may make repayment under-secured.
- **Oracle:** Contract/data source publishing values such as collateral prices.
- **Liquidation:** Forced reduction/closure of an unhealthy borrowing position using collateral.
- **Bad debt:** When a borrower owes more than collateral and recovery mechanisms can cover; this *can* harm lenders.
- **Slippage:** A trade executes at a worse price than an ideal/reference quote, often due to available liquidity.
- **Withdrawal limit:** Amount user can redeem now; distinct from market value and estimated swap liquidity.
- **Risk scenario:** A hypothetical failure and *severity*, not a claim it will occur.
- **Expected loss:** Probability over a specified horizon times prospective loss if the event occurs; probability must be justified or clearly user-assumed.

## Typed failure scenarios / required models

| Scenario | Input | Propagation | Can we directly compute $ loss? |
| --- | --- | --- | --- |
| Market incurs loss | Market identity, realized lender-loss severity | market -> allocated vault -> position | **Baseline** proportional allocation loss, with caveats |
| Oracle stale/manipulated | Feed, error amount/duration | feed -> lending config -> collateral/borrow health -> vault | Not without account-level liquidation/bad-debt model |
| Collateral crash/depeg | Asset, shock %, live collateral quantities | asset -> borrower health -> liquidations -> market -> vault | Only after modelling liquidation/recoveries |
| Smart-contract exploit | Contract, funds-at-risk, recoveries | contract -> controlled markets/vaults -> position | Only if capital-at-risk known or clearly scenario-assumed |
| AMM liquidity shock | Route, depth/fee changes | route -> quote/exit value | Exit cost can be quoted/modelled; not direct loss of all funds |
| Chain/sequencer outage | Chain, start/duration | chain -> affected transactions -> withdrawal availability | Not automatically permanent dollar loss |
| Bridge failure | Bridge/backing, stuck/burnt amount | bridge -> wrapped token backing -> strategy | Depends on bridge design/backing/recovery |
| Privilege/admin compromise | Permission action/pause/upgrade | admin -> contract functions -> assets/withdrawals | Depends on what capabilities are exercised |

Support all categories in the *schema* and graph. Implement advanced economic models iteratively with observed borrower/quote data; otherwise report unknown.

## Baseline financial example (only a fixture)

User position $10,000; vault directs **60%** to Market A. Scenario posits **20% lender loss** in Market A. Naive pro-rata position scenario loss = `$10,000 * 0.6 * 0.2 = $1,200`.

Caveats: vault may reallocate, funds may be idle/queued, creditor status and recovery may change losses, some allocations are caps rather than deployed balance, the market may have buffers, and withdrawals can be restricted. The engine should use deployed *observed exposure*, not a risk cap, and timestamp its value.

**Never treat "ETH price fell 20%" as "vault lenders lost 20%".** Those are not equivalent.

## Critical graph rule: track value paths separately from operational paths

- Financial flow: `position -> vault -> market` with verified capital allocation and accounting.
- Nonfinancial trigger: `market -> oracle` says how a failure might affect health, **not** that 100% of capital is lost.
- Calculate capital-at-risk on a **unique exposure ledger**, not by naïvely summing all graph paths. Shared downstream oracle across two paths can otherwise double-count one invested dollar.
- Normalize position shares from total vault shares/assets using contract accounting. Infer user share of funds only where economic assumptions are valid.
- Avoid circular allocation loops and recursive leveraged loops without an explicit accounting solver.

## Decision model

For a specified horizon H:

```text
scenarioLossUsd = economically justified additional loss IF future event occurs
p              = probability of that event during H (externally calibrated or user-assumed)
expectedStayCostUsd = p * scenarioLossUsd  // only in simple binary model
exitCostUsd     = estimated friction/fees/slippage/gas to exit NOW, for actual size

if exit is infeasible: EXIT_UNAVAILABLE
else if loss unknown or p unknown or quote absent/stale: INSUFFICIENT_EVIDENCE
else if expectedStayCostUsd > exitCostUsd: EXIT
else: STAY

breakEvenP = exitCostUsd / scenarioLossUsd, if scenarioLossUsd > 0
```

Real systems need multiple mutually exclusive / overlapping scenarios, recovery, risk appetite, exposures after partial exit, future yields foregone and execution delay. First prototype intentionally compares one scenario at a time. A break-even probability is often safer than fabricating `p` from a general AI confidence score.

Distinguish **incident already happened** from **risk incident may happen**. Do not compare already-incurred (sunk) losses to today's exit cost. Only compare avoidable incremental losses from here forward.

## Exit calculator

Order of routes:
1. Direct vault redemption: read `maxWithdraw(owner)` / withdrawal queue or position-specific constraints, simulate/preview redemption as supported; estimate fees and gas, account for share transferability and gates.
2. Redeem vault to underlying plus optional swap: quote using actual size, explicit route and block/time; check liquidity and price impact.
3. Selling vault shares into AMM only when a genuine market exists and quote is available.

For each route store route IDs, input/output token, input amount, estimated output, slippage against fair/reference value, fees, gas, quote expiry, confidence/source, maximum feasible amount. If chain paused, quote stale, withdrawals gated or liquidity absent: return `EXIT_UNAVAILABLE` (or partial exit) rather than invent a quote.

## Simulation report format

```json
{
  "scenario": { "kind": "ORACLE_STALE", "targetNodeId": "oracle:...", "horizonHours": 24 },
  "affectedPaths": [["oracle:...", "market:...", "vault:...", "position:..."]],
  "mechanism": "Potential collateral mispricing; cannot infer bad debt without borrower state",
  "exposureUsd": 6000,
  "incrementalLossUsd": null,
  "exit": { "feasible": null, "quoteAsOf": null },
  "decision": "INSUFFICIENT_EVIDENCE",
  "unknowns": ["Borrower liquidation state", "Current exit quote", "Event probability"]
}
```

This is schema illustration; do not present as data from a real market.

## Calibration and validation

1. Test simple direct market loss with hand-checked accounting.
2. Test oracle failure scenario returns **no dollar loss** until economic model available.
3. Historical replay should anchor chain+protocol state before the incident, not use hindsight.
4. Uncertainty decomposition: data freshness, missing dependencies, severity assumptions, probability assumptions, executable quote risk.
5. Validate outputs against observed incident consequences where available. Precision of loss numbers is less important than explainability and error bounds.
