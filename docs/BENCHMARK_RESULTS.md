# Real-data evaluation and measured limits

## What was built and tested

The automatic flow now combines fresh supported vault accounting, live USD stablecoin prices, an experimental historical price-event forecast, a minimum partial concentration-policy proposal and an optional atomic local-fork rehearsal. It does not invent generic hack probabilities or equate collateral price moves with lender bad debt.

Public datasets contain **15,098 actual hourly candles**: UST/USD, DAI/USD and USDT/USD from Coinbase Exchange, and USDC/USD from Binance.US. Live USDC uses Kraken's recent USD candles because Coinbase's USDC/USD candle endpoint is unavailable. All provider/time/hash references are retained in [the manifest](../datasets/history/manifest.json). Historical retrieval today is not a vintage-data archive.

The [protocol](../datasets/PROTOCOL.json) was fixed before downloading and inspecting outcomes. Training uses April–May 2022; validation uses June 2022; held-out tests use January–March 2023 and June 2023 USDT. Missing bars are never forward filled. Forecast features require 24 consecutive prior hours; labels require 24 subsequent hours, entirely available before the training cutoff.

## Probability model

`empirical-depeg-v1` estimates historical event frequencies within four predefined price/momentum regimes. The event is **a further 2% fall from the current hourly close within 24 hours**, measured using subsequent hourly closes. Expected terminal positive downside and path drawdown are separate statistics. This predicts fiat price risk of underlying token units, not stolen funds, oracle compromise or lender haircuts.

Training contains 5,561 overlapping labels and 392 positive labels, largely from **one UST collapse**. They are not 392 independent incidents. Product-day counts disclose support but do not establish independent events or calibrated uncertainty intervals. Mechanism and venue transfer, serial dependence, retrospective revisions and four years of live regime drift prevent a production calibration claim. The model is always marked `validatedForLiveExecution: false`; it cannot authorize execution.

Held-out Brier scores (lower is better) versus an unconditional training-frequency baseline:

| Dataset | Regime model | Constant baseline | Interpretation |
| --- | ---: | ---: | --- |
| DAI, Jan–Mar 2023 | 0.020675 | 0.021657 | Slightly better on this sample |
| USDC, Jan–Mar 2023 | 0.021029 | 0.018326 | **Model worse than baseline** |
| USDT, Jan–Mar 2023 | 0.000765 | 0.004969 | Better; no qualifying drop labels |
| USDT, June 2023 | 0.000037 | 0.004969 | Better; no qualifying drop labels |

June 2022 validation has no qualifying events, so its low Brier score cannot validate crisis forecasting. Test labels overlap, and USDC/DAI March cases share an incident. These are not independent confidence tests. Calibration per regime and skipped labels are in [the full report](../datasets/backtest-report.json).

## Protective-rule counterfactual

A separate frozen rule signals after **two consecutive hourly closes below $0.995, with the latest falling**. It assumes execution at the next hour's opening price after a one-hour processing delay. It does not consume future prices to choose the signal. It switches into actual USDT/USD prices; a USDT source uses a USD-cash assumption. Each case starts with $10,000. Total migration costs are sensitivity assumptions of 10, 30 and 100 basis points; no historical order-book or vault route is established.

At 30 basis points (0.3%):

| Case | Signal UTC | Hold to window end | Switch to destination | Final difference |
| --- | --- | ---: | ---: | ---: |
| UST May 2022 — **in-sample** | May 8, 01:00 | $328.90 | $9,838.15 | +$9,509.25 |
| DAI Jan–Mar 2023 — held out | Mar 11, 05:00 | $9,999.00 | $9,559.08 | **−$439.92** |
| USDC Jan–Mar 2023 — held out | Mar 11, 08:00 | $10,001.00 | $9,003.29 | **−$997.71** |
| USDT Jan–Mar and June 2023 | No alarm | Same as strategy | Same as holding | $0 |

UST's final price is the last available Coinbase close before delisting; there is no fabricated June 1 price. It is not a held-out validation success. No Anchor position, borrower or Terra vault is reconstructed.

DAI/USDC recovered. A protective sale during their crisis locks in losses and misses recovery, even when it improves a temporary downside measure. The report evaluates subsequent hourly-close minima separately and includes destination downside. Those minima are hindsight evaluation at potentially different times, not an executable profit. The rule first signals after stress starts; it does not predict an unseen incident before any evidence.

False-alarm episodes are successive inactive-to-active rule transitions with **no additional 2% close-based fall in the next 24 hours**. This includes repeated crisis/recovery alarms: DAI 10, USDC 17, USDT 0 in the held-out windows. Missing future labels remain unknown. These counts are not “17 unrelated false incident predictions.”

An isolated Binance.US USDC low of $0.33 occurs inside a candle that closes at $0.9169. It is retained and flagged as a suspicious intrahour bar. Hourly-close benefits never use that print to claim a $6,700 avoided loss. Cross-venue execution depth is unavailable.

**Allowed claim:** this frozen rule would have changed the price-only portfolio outcomes under the disclosed delay, costs and destination assumptions. **Unsupported claim:** our model proved it would have executed an exit from an actual historical vault or guaranteed avoided loss.

Circle's [March 2023 reserve/recovery announcement](https://www.circle.com/pressroom/3-3-billion-of-usdc-reserve-risk-removed-dollar-de-peg-closes) supports interpreting recovery as a material part of the outcome. It is contextual evaluation evidence, not a feature fed into historical decisions.

## Live reallocation and execution measurements

At Ethereum block **26166976**, Hyperithm USDC Apex's largest market/collateral allocation was about **47.80%**. Against a fresh Keyrock snapshot, the solver proposed moving **51.699%** to meet a **35% market** and **50% collateral** concentration policy. It accounts for overlapping market/collateral factors: moving 26.8% as if the destination had no shared exposures would not generally satisfy the policy. The illustrative $10,000 value gives a proposed $5,169.94 move; it is not the public holder's actual balance.

Retained dependencies include USDC, its documented issuer, Ethereum, Morpho and shared oracle/contracts. Expected-loss reduction is unknown. Global allocations are assumed static; a large migration can change them, so concentration compliance after an actual migration would require remeasurement.

A direct local fork test at block **26166960** atomically migrated a public Keyrock EOA's approximately **204,106.906210 USDC** into Hyperithm, issuing destination shares and preserving the owner's underlying balance. The permitted executor used a newly deployed **fork-only** contract and bounded initial approval. Tests rejected unauthorized callers, excess amounts, impossible outputs, revoked policy, expired permission, revoked allowance and duplicate/cumulative execution. Output/balance/allowance and upstream block-hash invariants passed. Mainnet transactions sent: **zero**.

This validates contract mechanics at the simulated state, not future investment quality, signing authority or a historical crisis exit. Setup gas and recurring execution gas are measured separately, using a fresh mainnet gas price and fresh reference USD prices where available. Missing prices leave costs unknown. See [the fork contract](../contracts/README.md).

A further test at block **26167129** exercised the actual proposal direction: **Hyperithm → Keyrock**, sized as 51.699% of an entered $10,000 position. Hyperithm's direct redemption could not obtain enough idle funds. The fixed route first used permissionless Morpho V2 `forceDeallocate` on a verified market and then redeemed/deposited atomically. It received **5,171.414375 USDC** (USD sizing uses a fresh USDC reference price), with approximately **$0.05154** of protocol withdrawal fees, **$0.31258** setup gas and **$0.21404** execution gas. All seven rejection checks and output/balance invariants passed; mainnet transactions sent remained zero. These are measurements at one fork state, not guaranteed live costs. The [full timestamped proof](../datasets/fork-migration-recording.json) retains receipts, fixed route bounds, share-fee accounting and source block/hash.

The concentration solver assumes static proportional allocations. Withdrawing a particular market to fund redemption changes the vault's internal allocation; this record does **not** establish that the resulting portfolio still meets the pre-move predicted concentration limits. Post-execution exposure reconstruction is required before claiming policy compliance.

The complete **automatic dashboard path** also passed at source block **26167141** and fork block **26167142**, proposing a **$5,169.9420** move for an entered $10,000 position and executing the bounded market-withdrawal route. Its [full recorded cycle](../datasets/automatic-reallocation-recording.json) includes source/destination graph evidence, observed accounting, forecasts, the concentration proposal and fork receipts. Browser checks passed for live V1/V2 discovery, the previously reported market-loss scenarios, monitoring start/stop, benchmark charts, replay, fixture and mobile layout. Offline validation: **58 tests passed, one optional live test skipped, zero failures**; typechecking passed. Dependency audit: zero known vulnerabilities at the check time. None of these software checks validates forecast calibration or production financial execution.

## Reproduce

```bash
npm run backtest
npm test
npm run typecheck
npm run automation -- 1:0x093272c07700d3ca5301c3bf9b3a392624179e2f 10000 1:0x04422053aDDbc9bB2759b248B574e3FCA76Bc145
npm run test:fork -- 0x04422053aDDbc9bB2759b248B574e3FCA76Bc145 0x093272c07700d3ca5301c3bf9b3a392624179e2f 0x41f16eb553daed56c50bfc07c1c69b0465caa3b1
```

Re-download public histories with `npm run data:history`. Browser QA also exercises fresh source/destination comparison, an automatic policy-selected fork rehearsal, historical chart/metrics, monitor stopping, credential isolation and mobile layout.

## What would improve the forecast

Independent crisis histories and current rolling data; mechanism-specific issuer/reserve, pool imbalance and liquidity features; borrower health/liquidation/recovery modelling; cluster-aware uncertainty and calibration; realistic cross-asset execution/withdrawal archives. The [Curve depeg research](https://arxiv.org/abs/2306.10612) suggests pool metrics and change-point detection as richer signals; its reported results have **not** been reproduced by this baseline. No third-party model implementation was copied.
