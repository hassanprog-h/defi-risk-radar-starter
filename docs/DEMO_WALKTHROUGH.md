# Running the expanded demo

Start with `npm run dev` and open the local URL printed by the server. Keep the existing `.env` server-side. No additional data key is needed for the included historical benchmark or public stablecoin feeds.

## Live position to proposed reallocation

1. Choose **Hyperithm USDC Apex · V2** under **Real examples** and inspect it. The Ethereum address is `0x093272c07700d3ca5301c3bf9b3a392624179e2f`. Inspection builds the dependency graph from indexed relationships and contract reads; click a node or relationship to inspect evidence and missing coverage.
2. Enter `10000` in **Where your vault invests your money**, then use **Show my exposure**. This is an illustrative position size applied to *real current vault allocations*. It does not claim you own that position. Dollar exposures are amounts at risk, not losses.
3. The automatic stablecoin assessment fetches closed hourly market prices. A fixed historical model supplies a reference probability of a defined further price decline. No manual probability is required here. The display discloses training support, timestamps and experimental status. A collateral price forecast alone cannot establish a lender loss.
4. In the reallocation panel, keep Keyrock USDC as a candidate. The default policy permits at most 35% in one lending market and 50% against one collateral token. **Compare destinations** freshly inspects both vaults and solves for the smallest partial move satisfying those limits, allowing for shared exposures. Allocations and the answer change with live state. A source already within the limits correctly needs no move.
5. **Start monitoring** reruns discovery, price checks and comparison every five minutes. Verified relationship changes are recorded. **Stop monitoring** prevents subsequent cycles; an already running read may finish. Reports persist in `.radar/`; monitoring does not automatically resume after a server restart.

This is a concentration policy, not a complete forecast of investment returns. Both example vaults hold USDC, so moving between them retains USDC issuer/depeg risk. Current prices, market weights and graph connectivity cannot establish a general exploit probability. Destination yield, joint loss modelling and post-move exposure verification remain missing.

## Automatic transaction demonstration

Open the local-fork section. **Find a public demo holder** finds somebody else's indexed owner and verifies their actual shares and non-contract account with current reads. It does not give you control of their real wallet.

Place that public address in the fork-owner field and enable the automatic local-fork rehearsal before comparing. Alternatively, select a compatible destination and run the fork demonstration manually. The entered USD position and move fraction determine the amount; they do not select the holder's entire balance. The holder must have enough shares to cover the move and any bounded withdrawal fee.

The server starts an isolated Ethereum fork on local chain 31337. It deploys a fixed policy contract as the impersonated owner, approves bounded source shares once, and lets a separate executor perform the migration without another owner action. The contract rejects deployment on mainnet. All transactions are confined to this newly created local node.

Hyperithm may hold too little idle USDC and have no default liquidity adapter. In that case the supported route first withdraws available funds from verified Morpho markets back into the vault, then redeems and deposits atomically. The small protocol withdrawal fee burns additional owner shares; those shares count toward the permission bounds. The report shows this fee separately from setup and execution gas. Insufficient liquidity, unknown adapters or excessive fees block the route.

The demonstration tests unauthorized execution, excessive size, impossible outputs, revoked permission, expired permission, revoked allowance and duplicate/cumulative spending. Failure rolls back all transaction legs. Download the proof to inspect local receipts, route parameters and actual balance checks. These checks demonstrate transaction mechanics; they do not establish future profitability or real wallet authority. Mainnet transactions sent: zero.

An unavailable **direct** public-owner redemption quote can coexist with a successful forced-liquidity fork route. They test different operations. The source vault's allocations also change when its markets supply the withdrawal, so the pre-move proportional concentration estimate is not a verified post-move result.

## Historical evaluation

Use **Show historical evaluation**. The interactive chart displays March 2023 USDC, DAI and USDT prices; series buttons toggle individual lines. The table starts each price-only case at $10,000, executes a frozen alarm rule after a one-hour delay and includes an assumed switching cost. Download the full report for other cost cases, sources, false alarms and forecast scores. Reproduce it offline with `npm run backtest`.

The UST training example shows a large reduction in subsequent price loss under those assumptions. It is **in-sample** and does not prove an actual Anchor withdrawal. Held-out USDC and DAI examples show the opposite terminal result: exiting during the depeg locks in a loss before their recovery. The USDC probability model also performs worse than the constant-probability baseline. These failures are included deliberately; the experiment does not justify the claim that this system reliably avoids historical crises.

**Load fixture demo** remains a separate fabricated teaching example: $10,000 × 60% allocated to one market × 20% assumed lender loss = $1,200 conditional loss. Multiplying by the fabricated 25% event probability gives $300 expected loss; the $200 assumed exit cost makes its simplified decision EXIT. Its two markets illustrate splitting capital; collateral is what borrowers pledge to secure their loans. The vault's depositor supplies the loan asset to earn yield, rather than pledging ETH to borrow USDC. See [measured benchmark results](BENCHMARK_RESULTS.md) for the real-data experiments.
