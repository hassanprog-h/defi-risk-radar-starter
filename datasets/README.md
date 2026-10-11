# Attributed historical USD price data

Public exchange market candles, downloaded for this hackathon research benchmark. Original providers retain rights to their data. This is not third-party application code or a synthetic finance fixture.

- `PROTOCOL.json`: training, validation and test windows, event definition, frozen protective rule and cost assumptions, fixed before viewing outcomes.
- `history/*.json`: normalized `[UTC bucket start seconds, low, high, open, close, volume]` plus exact provider query URLs, retrieval times and normalized response SHA-256 hashes.
- `history/manifest.json`: complete-file SHA-256 hashes, row counts and the copied protocol. UST/DAI/USDT are Coinbase Exchange; USDC is Binance.US, all directly quoted in fiat USD.
- `backtest-report.json`: reproducible model/benchmark metrics, missed and false alarms, all cost cases, isolated-print flags and chart points.
- `fork-migration-recording.json`: timestamped real-vault local-fork execution proof, including bounded forced-liquidity withdrawal, fee accounting and seven permission rejection checks.
- `automatic-reallocation-recording.json`: the complete successful automatic dashboard cycle, retaining source/destination graph evidence, observations, experimental forecasts, proposal and local-fork proof. This is a historical recording, not current feasibility or verified post-move concentration compliance. Mainnet transactions sent: zero.

No forward filling. Data gaps and delisting are preserved. Historical retrieval today is not an archive of what an API published at the historical decision date. Chronological features and training labels respect their availability times; current graph snapshots are not attached to 2022/2023 prices.

Official format references: [Coinbase candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles), [Binance.US API](https://docs.binance.us/), [Kraken recent OHLC](https://docs.kraken.com/api-reference/market-data/get-ohlc-data) for the live USDC feed. No extra API keys needed.

Run `npm run data:history` to fetch again, then `npm run backtest`. Revisions change hashes and are visible. See [results and limitations](../docs/BENCHMARK_RESULTS.md).
