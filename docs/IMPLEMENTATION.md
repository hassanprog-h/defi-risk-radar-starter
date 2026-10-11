# Implemented local vertical slices

The application runs one local Node HTTP server and a buildless SVG/JavaScript frontend. TypeScript domain and connector code is compiled to `dist/`. This is a working implementation of parts of the target architecture in ARCHITECTURE.md, without empty workspaces or external hosting.

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
| `POST /api/simulate` | Snapshot ID, typed target/scenario, severity/horizon, optional assumed size/probability/cost, optional matching quote ID |
| `POST /api/quote-exit` | Snapshot ID, public owner address, optional raw shares → direct-redemption assessment and quote ID |
| `POST /api/replay` | Exported graph JSON → validated historical recording/report; current exit quotations disabled |
| `GET /api/demo` | Separate, prominently labelled illustrative fixture report |

Snapshots/jobs are in memory, limited to 30 retained entries. Two discovery jobs may run concurrently. Request bodies are bounded (4 KB ordinarily; 2 MB for a recording). This server is intended for a local analyst session, not public multi-tenant deployment.

## Provenance and temporal consistency

EVM contracts share `eip155:<chainId>:<lowercase-address>` identifiers. Morpho markets use `morpho-market:<chainId>:<marketId>`. Off-chain issuer IDs are namespaced and do not pretend to have a deployment chain.

On-chain relationships have contract-read signatures and pinned block/time evidence. API records retain field paths and available provider blocks. Corroboration preserves the original indexed evidence. Mismatches downgrade evidence and suppress financial conclusions. Source documentation is labelled separately from observed contract state; no AI inference is promoted to verified.

V1 inspections anchor RPC to the API state's block where available. V2 REST index height anchors corroborating reads, but does not make GraphQL allocations atomic. V2 allocation evidence therefore does not fabricate a source block. The recorded inconsistency prevents dollar-loss attribution until a suitable accounting model is implemented. Final block-hash checks detect a reorg or an unavailable final verification.

Dynamic values use observations and exposures. Deployed allocations are distinct from supply caps. Proportional loss checks unique paths, normalized fractions and total deployed exposure. Unsupported nested ownership/conversions, inconsistent assets, stale critical data and incomplete allocation traversal suppress numerical estimates.

## Pendle and five-layer semantics

For PT collateral in a supported Morpho graph, the public Pendle directory identifies candidate associated markets. `readTokens()` corroborates market/PT/SY identities; principal `SY()` reads corroborate claim links. `TRADED_ON` describes venue membership. It does not imply a configured lending oracle uses that pool, or that the pool can execute an exit for the investor's size. Configured oracle-to-AMM dependencies use `USES_AMM` only when a recognized oracle's market getter establishes that role.

SY `assetInfo()` is stored as a reference denomination observation, because it can refer to another chain or an approximate accounting asset. It is not automatically a backing edge. ABI-derived generic references remain `USES_CONTRACT` with unresolved economic semantics. The five category cards can be partial even when graph nodes for each layer exist.

## Financial models and exit limits

Supported numerical stresses are direct V1 market lender loss and an explicit assumed net shareholder haircut at the root vault. Neither predicts an incident. Other scenarios return affected paths, mechanism explanations and, where accounting supports it, unique affected exposure; exposure is not loss.

Redemption is a read-only `balanceOf`/`maxWithdraw`/`previewRedeem`/`convertToAssets` assessment plus `eth_estimateGas`, current gas price and fresh USD reference prices. It targets the owner as receiver and returns underlying tokens. No transaction, allowance or signature is submitted. A successful estimate is state-specific; it is not a guaranteed fill. Partial redemptions cannot support a full-exit recommendation. Missing prices leave dollar cost unknown. Nonstandard transfer fees, withdrawal queues, swaps, L2 fee components and alternative route searches need separate models.

Only fresh matched quote IDs may enter a live decision. Owner/amount changes clear the frontend quote selection. Stale unavailable quotes do not block exits indefinitely. STAY/EXIT remains conditional on the supplied scenario probability and model; it is not an overall risk clearance or a trading instruction.

## Validation

Offline tests use attributed public response captures plus explicit adversarial mutations. Browser QA covers the visible live graph, affected paths, fixture switching, historical import, keyboard evidence selection, credential isolation and page overflow on mobile. Real network checks have demonstrated two V1 vaults and a V2 vault; the README records measured counts and material limitations.

Historical recording tests preserve acquisition timestamps and set `mode=historical_replay`. They validate schema and graph/exposure consistency, not provider authenticity or actual incident outcomes. Fresh exit decisions remain disabled. Precision/recall against independently labelled graphs and calibrated loss validation remain evaluation roadmap work.
