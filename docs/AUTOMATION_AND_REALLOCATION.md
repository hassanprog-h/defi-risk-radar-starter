# Automatic assessment, reallocation and delegated execution

## Updated product direction — 2026-10-11

The user reports Belem prefers actionable reallocation, potentially automatic after initial authorization, and forecasts derived from dependencies/live data rather than manually entered probabilities. This is conversation feedback, not a verified amendment to the published PDF. It expands the original product target. Mainnet remains read-only; the implemented local-fork executor never activates live fund movement.

## Implemented expansion

- Live fiat-USD stablecoin feeds plus an experimental historical regime model automatically supply a defined 24-hour price-event reference probability. It is not a calibrated live incident model. Borrower bad debt and security exploits remain unforecasted. [Measured held-out failures and successes](BENCHMARK_RESULTS.md) are preserved.
- The minimum partial allocation solver enforces user policy limits for observed market and collateral concentrations. Shared exposures are grouped, and the same underlying/issuer risk remains visible. Dollar expected-loss benefits and destination yield are not fabricated.
- A server monitor refreshes accounting, prices and proposals, records verified dependency changes and saves local reports. One explicitly enabled automatic fork rehearsal is allowed per setup; unhedged underlying depeg blocks same-token rehearsal.
- The fork-only policy contract receives bounded source-share approval once; a separate executor atomically redeems and deposits for the fixed owner. Source/destination, amounts, cumulative spending, expiry, cooldown, revocation and minimum outputs are enforced in contract code. Rejection cases and actual real-vault balance/output checks run on the local fork. Deployment is rejected outside chain 31337. See [contract details](../contracts/README.md).

Pending: wider incident/calibration data and borrower/liquidation/recovery models, joint risk/yield allocation optimization, cross-asset swap liquidity and production wallet authorization. The local demonstration is not a real wallet delegation or historical proof of executable incident exits.

## Desired pipeline

1. Select a position and enter its amount for exploratory analysis; read actual owner shares for an executable plan.
2. Discover dependencies; collect fresh, evidenced accounting, borrower, oracle, market, liquidity and control observations.
3. Produce supported event forecasts and prospective loss distributions. The main flow does not ask for event probabilities or lender haircuts. Unsupported models abstain and identify missing inputs.
4. Analyse allowlisted destination vaults and holding the underlying using the same models. Compare shared dependencies and introduced risks.
5. Quote full or partial migration at the actual amount: redemption, optional swap, deposit and resulting shares. Compare staying with feasible allocations over the same horizon, including destination risk, costs and yield.
6. Present a proposal: source/destination/amount, changed exposures, avoided future loss, remaining risk, costs, model/version, uncertainty and expiry.
7. Simulate on a local fork first. Later enable individually approved migration or bounded, revocable delegation for a supported account. Refresh state and resimulate immediately before execution.

Manual stress tests remain an advanced analyst tool. Position selection and amount suffice for exploration; actual execution additionally needs owner authorization and a one-time policy. Amount alone cannot establish ownership or authorize trades.

## Implemented observational slice

`src/live/assess.ts` provides the base observational assessment; `POST /api/assess` now calls the additional price-forecast wrapper. Both accept `{snapshotId, positionUsd}`; a null amount permits checking observations before sizing. They measure verified deployed market concentrations, deduplicate shared components/cycles, and report basic pricing-round checks where readable at the anchor block. Missing/old anchors, inconsistent/duplicate capital and unverified data suppress unsupported measurements. Feed age does not establish staleness without its heartbeat policy. The wrapper adds individual dependency price references; the aggregate portfolio incident-loss forecast remains unavailable. The separate automation endpoint supplies concentration proposals with live execution disabled.

The dashboard runs these checks after inspection and offers an amount-only form named **Where your vault invests your money**. `Inspect live vault` collects new graph/accounting data; **Show my exposure** reevaluates freshness and fetches live price data through the forecast wrapper. The separate reallocation panel starts fresh comparison/background monitoring. Manual controls remain under **Advanced: hypothetical stress tests**. Public-holder redemption checks remain read-only.

## Automatic probability and severity models

The graph identifies what can affect a position. A forecasting model estimates how likely a **defined event** is over a **defined horizon**. An economic model determines the additional shareholder loss conditional on it, accounting for recoveries and mitigation. These are separate quantities.

| Family | Required data/models | Valid output/limit |
| --- | --- | --- |
| Collateral shock/depeg | Historical prices, borrower balances/health, actual oracle pricing, redemption and liquidation depth; validated shock paths | Shock distribution, followed by borrower/liquidation-derived lender-loss distribution |
| Exit/liquidity | Utilization, available funds, queues/gates, amount-specific quotes | Current feasibility/cost; future withdrawal stress needs time-series validation |
| Oracle | Feed-specific heartbeat/deviation policy, round data, independent prices and fallback semantics | Measured failure and supported consequences; no hack probability from a stale feed |
| Contract/admin | Verified incident/vulnerability evidence, privileges, upgrade delays, recoverable funds | Specific mechanism; generic exploit probability stays unknown without a validated hazard model |

A collateral decline can cause zero lender loss if repayments and liquidation proceeds cover debts. Loss severity cannot simply equal the collateral price decline. An observed outage needs no guessed probability of having already occurred; its future financial damage still needs a model. A full loss distribution can replace the simple binary probability-times-severity formula.

Every forecast records event definition, horizon, as-of block/time, feature evidence, model/version, training and validation periods, calibration results, applicability, uncertainty and expiry. Unknown is distinct from zero. Missing dependencies or unsupported protocol mechanics block automated execution; no LLM confidence fallback.

Use chronological out-of-sample validation with no post-event information. Measure probability reliability, interval coverage, false alarms, missed incidents and drift against base-rate comparators and quiet periods. A single famous incident cannot calibrate a model. Historical avoided-loss claims require reproducible contemporaneous holdings, feasible routes, delays and costs.

## Allocation comparison

For each feasible allocation over the same horizon, compare prospective portfolio loss, migration costs, projected net yield and policy constraints. A simple risk-neutral calculation is:

```text
benefitUsd = expectedLossIfStaying - expectedLossAfterMigration
             - migrationCost + (destinationNetYield - sourceNetYield)
```

Also consider policy loss limits, tail loss and uncertainty. Evaluate staying, holding the underlying and partial moves. A destination's risk is not zero by default. Correlated events and shared dependencies require joint scenario accounting; overlapping losses must not be counted twice.

Fabricated illustration: source expected future loss $300, destination $80, migration cost $40, equal yield: estimated benefit $180. A destination with $290 expected loss produces a $30 disadvantage after the same cost. These are explanatory figures, not model outputs.

A USDC-to-USDC-vault migration retains USDC issuer risk. Switching vaults sharing risky collateral/oracles can preserve the original failure path. Show retained, reduced, removed and introduced dependencies and justified exposure changes; node overlap alone is not a dollar-risk score.

Moving an investor's shares between vaults differs from changing the source vault's internal markets. Internal allocation needs actual allocator authority or the explicitly enabled restricted public mechanism. Ordinary depositors cannot assume curator powers. See [Morpho's Public Allocator explanation](https://morpho.org/blog/introducing-the-public-allocator-for-morpho/).

## One-time authorization

An ERC-20 approval alone does not authorize arbitrary vault withdrawals, swaps and redeposits. Supported smart-account delegation can grant scoped execution. Official starting points are [MetaMask Smart Accounts Kit](https://docs.metamask.io/smart-accounts-kit/) and [Safe modules](https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit). Verify available permission types before selecting an integration; a token spending cap alone is not a reallocation policy.

The policy specifies chain/account, allowed vaults/tokens/functions, per-action and cumulative limits, recipient ownership, expiry/revocation, minimum outputs/slippage, fees and cooldown. Authorization must constrain actual calls/amounts rather than trust a textual proposal. Validate balances, allowances, destination gates/caps and routes. Use atomic migration where supported and explicit recovery states otherwise, plus a kill switch and audit trail. Off-chain quote/model checks are not on-chain protections unless enforced by the execution mechanism.

The analysis service must not hold the user's private key. The delegated executor is a separate trust boundary. Its bounds can limit damage from wrong models/compromised software; they do not guarantee good investments. Granting real permissions or moving funds is a separate activation after the concrete policy and simulation are reviewable. Existing provider keys authorize data reads only.

## Next vertical slices and acceptance criteria

1. **Historical dataset and forecasting baseline:** reconstruct one supported financial mechanism and borrower exposure, define event/horizon, evaluate chronologically, preserve uncertainty/abstention. Command returns evidenced versioned forecasts or explains missing inputs. Passing checks cannot imply zero risk.
2. **Read-only destination comparison:** inspect at least two real supported vaults, find shared risks, quote redemption and destination deposit at actual size. Propose only with comparable supported loss/yield models and fresh costs; otherwise identify missing evidence. Test shared issuer/oracle, illiquid destination, zero capacity, partial moves, incomplete graphs and quote expiry.
3. **Local-fork execution demo:** use fork-funded test accounts, simulate migration and verify resulting shares/balances. Permission tests reject wrong recipients/destinations/amounts, expired/revoked grants and insufficient output. Fork transactions are not mainnet fills.
4. **Delegation and monitoring:** integrate one verified account mechanism, refresh and resimulate allowed moves, log outcomes. Test model expiry, spoofed signals, reorgs, cooldown/cumulative limits, replayed/corrupted plans, failed legs and allocation oscillation. Mainnet activation is separately reviewed.

No new key is needed for the observational slice. Next slices may need borrower history, archive/time-series data and a fork runner. Check public coverage first; request a dataset/key only for a demonstrated gap.
