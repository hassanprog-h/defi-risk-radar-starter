# Implemented local vertical slices

The application runs one local Node HTTP server and a buildless SVG/JavaScript frontend. TypeScript domain and connector code is compiled to `dist/`. This is a working implementation of parts of the target architecture in ARCHITECTURE.md, without empty workspaces or external hosting.

## Automatic observational assessment

`src/live/assess.ts` powers `POST /api/assess` and the dashboard's amount-only dependency-check form. It measures verified market concentration, deduplicates shared components and checks oracle rounds at the snapshot anchor. Missing/stale anchors, inconsistent accounting, duplicate paths and unverified observations withhold unsupported results. Oracle age does not establish staleness without feed-specific heartbeat policy. Forecasts remain explicitly unavailable; no reallocation or execution is fabricated. Manual scenarios are under an advanced view. See [the updated forecasting/reallocation target](AUTOMATION_AND_REALLOCATION.md).

## Files and responsibilities

- `src/core`: original fixture types, bounded reverse traversal, illustrative simulator and decision seed.
- `src/connectors`: validated Morpho/Pendle API clients, bounded JSON requests, read-only viem RPC, Etherscan V2 source/ABI metadata. API shapes were checked against official documentation and actual upstream schemas/responses.
- `src/adapters`: Morpho V1/V2 normalization, adapter/nested-vault traversal, generic ERC-4626 interface reads, Pendle venue associations and token corroboration.
- `src/live`: network identity/deduplication, observations/exposure ledger, inspection orchestration, source/oracle enrichment, documented issuers, conditional scenario analysis, direct redemption assessment and replay validation.
- `scripts/viewer-server.mjs`: local HTTP API, bounded in-memory jobs/snapshots and explicit fixture/live/replay paths.
- `viewer`: real vault/catalogue selection, graph/evidence explorer, scenarios, provider/coverage diagnostics, public-owner withdrawal check and JSON recording import/export.

The root of a live graph is the vault. Investor size is supplied separately as an explicit USD assumption or a measured full-balance valuation from a matched quote; no fabricated investor position node or balance is added.

## Local API

All routes are under the local loopback host. Keys and upstream credential URLs are not returned. POST requests from another browser origin are rejected. Only explicitly whitelisted frontend assets are served; `.env` is never a static resource.

| Endpoint | Contract |
| --- | --- |
| `GET /api/status` | Boolean configuration status; no key values |
| `GET /api/catalogue?chainId=1&version=1&cursor=...` | Paginated listed-vault directory from Morpho |
| `POST /api/inspect` | `{selector:"1:0x...",enrichment?:true}` → job ID |
| `GET /api/jobs/<id>` | running, failed, or complete with graph/scenario report |
| `POST /api/assess` | `{snapshotId,positionUsd:number\|null}` → automatic observational checks; forecasts unavailable, no execution |
| `POST /api/simulate` | Snapshot ID, typed target/scenario, severity/horizon, optional assumed size/probability/cost, optional matching quote ID |
| `POST /api/quote-exit` | Snapshot ID, public owner address, optional raw shares → direct-redemption assessment and quote ID |
| `POST /api/public-holder` | Live Morpho snapshot ID → indexed example holder verified with current balance/code reads; bounded to 20 candidates |
| `POST /api/replay` | Exported graph JSON → validated historical recording/report; current exit quotations disabled |
| `GET /api/demo` | Separate, prominently labelled illustrative fixture report |

Snapshots/jobs are in memory, limited to 30 retained entries. Two discovery jobs may run concurrently. Request bodies are bounded (4 KB ordinarily; 2 MB for a recording). This server is intended for a local analyst session, not public multi-tenant deployment.

## Provenance and temporal consistency

EVM contracts share `eip155:<chainId>:<lowercase-address>` identifiers. Morpho markets use `morpho-market:<chainId>:<marketId>`. Off-chain issuer IDs are namespaced and do not pretend to have a deployment chain.

On-chain relationships have contract-read signatures and pinned block/time evidence. API records retain field paths and available provider blocks. Corroboration preserves the original indexed evidence. Mismatches downgrade evidence and suppress financial conclusions. Source documentation is labelled separately from observed contract state; no AI inference is promoted to verified.

V1 inspections anchor RPC to the API state's block where available. V2 inspections use a fresh RPC block. `src/live/accounting.ts` independently reads root `asset`, `totalAssets`, `totalSupply`, token balance, all `adapters`, each supported direct-market adapter's parent/asset/core, all active `marketIds`, `expectedSupplyAssets` and `realAssets`. Market sums must equal adapter assets and idle plus deployed assets must equal total assets. Membership, loan asset and parent identity must agree. Indexed inputs are preserved as `indexed:*` observations; successful pinned values replace the effective capital ledger. Zero-weight indexed markets absent from active accounting remain visibly zero. Unknown/nested adapters, missing active markets, duplicate identifiers, failed reads and inconsistent totals preserve blocking unknowns. Enumeration is bounded to 32 adapters and 128 active markets per adapter, within the shared RPC budget. Final block-hash checks detect a reorg or an unavailable final verification.

Dynamic values use observations and exposures. Deployed allocations are distinct from supply caps. Proportional loss checks unique paths, normalized fractions and total deployed exposure. Unsupported nested ownership/conversions, inconsistent assets, stale critical data and incomplete allocation traversal suppress numerical estimates.

## Pendle and five-layer semantics

For PT collateral in a supported Morpho graph, the public Pendle directory identifies candidate associated markets. `readTokens()` corroborates market/PT/SY identities; principal `SY()` reads corroborate claim links. `TRADED_ON` describes venue membership. It does not imply a configured lending oracle uses that pool, or that the pool can execute an exit for the investor's size. Configured oracle-to-AMM dependencies use `USES_AMM` only when a recognized oracle's market getter establishes that role.

SY `assetInfo()` is stored as a reference denomination observation, because it can refer to another chain or an approximate accounting asset. It is not automatically a backing edge. ABI-derived generic references remain `USES_CONTRACT` with unresolved economic semantics. The five category cards can be partial even when graph nodes for each layer exist.

## Financial models and exit limits

Supported numerical stresses are V1 market lender loss, reconciled V2 direct-market lender loss and an explicit assumed net shareholder haircut at the root vault. None predicts an incident. Other scenarios return affected paths, mechanism explanations and, where accounting supports it, unique affected exposure; exposure is not loss. `sensitivity` reports expected loss, an assumed-cost comparison and break-even probability separately from the checked decision. `decisionRequirements` explains missing model, size, probability, full exit, freshness and pricing inputs. The UI also displays the market allocation calculation.

Redemption is a read-only `balanceOf`/`maxWithdraw`/`previewRedeem`/`convertToAssets` assessment plus `eth_estimateGas`, current gas price and refreshed USD reference prices. Morpho V2 deliberately returns zero from max functions: this adapter still requires an actual successful `redeem` gas simulation instead of interpreting the zero as an execution ban. Unknown simulation failures remain unknown. It targets the owner as receiver and returns underlying tokens. No transaction, allowance or signature is submitted. A successful estimate is state-specific; it is not a guaranteed fill. Partial redemptions cannot support a full-exit recommendation. Missing prices leave dollar cost unknown. Nonstandard transfer fees, withdrawal queues, swaps, L2 fee components and alternative route searches need separate models.

Only fresh matched quote IDs may enter a live decision. Owner/amount changes clear the frontend quote selection. Stale unavailable quotes do not block exits indefinitely. STAY/EXIT remains conditional on the supplied scenario probability and model; it is not an overall risk clearance or a trading instruction.

Public example holders come from the official GraphQL `vaultPositions` or V2 nested `positions` fields, whose arguments were checked against upstream introspection. Each selected candidate must have a positive on-chain share balance and empty account code at the holder anchor, followed by a block-hash recheck. Balance verification is separate from redemption feasibility. No candidate is called the user's wallet. Owner/amount edits clear any displayed previous checked decision; expired valuations cannot silently override a newly entered hypothetical size.

V2 contract semantics follow the official [Vault V2 reference](https://docs.morpho.org/developers/contracts/morpho-vaults-v2/) and [market adapter reference](https://docs.morpho.org/developers/contracts/morpho-market-v1-adapter-v2/). This implementation uses their read interfaces; it does not copy contract implementation code.

## Validation

Offline tests use attributed public response captures plus explicit adversarial mutations. Browser QA covers the visible live graph, affected paths, fixture switching, historical import, keyboard evidence selection, credential isolation and page overflow on mobile. Real network checks have demonstrated two V1 vaults and a V2 vault; the README records measured counts and material limitations.

Historical recording tests preserve acquisition timestamps and set `mode=historical_replay`. They validate schema and graph/exposure consistency, not provider authenticity or actual incident outcomes. Fresh exit decisions remain disabled. Precision/recall against independently labelled graphs and calibrated loss validation remain evaluation roadmap work.
