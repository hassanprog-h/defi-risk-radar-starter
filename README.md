# DeFi Risk Radar — ambitious Belem Capital hackathon starter

> **North star:** Give any supported DeFi position a traceable dependency graph, test what happens when an underlying asset, oracle, protocol, lending market, liquidity venue, administrator or settlement layer fails, then estimate whether the investor should stay, exit, or request more information.

This repository is a **Codex-ready design and executable core skeleton**, not a complete or live DeFi risk platform. The CLI and local graph viewer run **illustrative fixture data**. No blockchain calls are performed yet. Live adapters and the live dashboard remain future work.

## Quick start

```bash
npm install
npm run demo
npm test
npm run dev
```

After `npm run dev`, open **http://localhost:3000** in your browser. Keep the terminal running; press Ctrl+C to stop. If the port is occupied, use `PORT=3001 npm run dev` and open http://localhost:3001. The server binds to local loopback only.

The viewer displays all 9 fixture nodes and 8 typed dependency edges. Select a node or edge to inspect fixture evidence, pan the graph background or use the zoom controls, change hypothetical failure assumptions, and download the full graph JSON. Market loss, unknown oracle loss and blocked exit during a chain outage reuse the existing domain engine. The terminal demo still prints a compact summary; `npm run demo -- --graph` prints the full fixture graph.

**Current stages:** fixture domain core and local visual explorer implemented; live vault inspection, five-layer enrichment and executable exit quotes are not implemented. All viewer values and decisions are illustrative. The viewer does not accept live vault addresses, load API keys, or make RPC/API calls. It needs no additional dependencies. Browser rendering is separate from the CLI and is not started by `npm run demo`.

The demo prints a typed graph and a hypothetical market-loss scenario: $10,000 position, 60% allocation to Market A, 20% severity -> $1,200 scenario loss. With **user-assumed** 25% incident probability over 24h and **assumed** $200 exit cost, the simplified comparison returns EXIT. These figures are fabricated **only to test the code**.

For future live connectors, copy `.env.example` to `.env` and set `ETHEREUM_RPC_URL` to your Ethereum mainnet RPC endpoint and `ETHERSCAN_API_KEY` to your explorer API key. `.env` is ignored by Git. Keep credentials out of frontend code, screenshots and chat. These settings are not used by the current fixture viewer.

## The distinction that matters

- **Facts:** what vault the user owns, where it allocates, what prices/oracles/contracts/admins it relies on, how much is available to withdraw, measured at a particular time/block.
- **Scenarios:** what *if* an oracle is stale, asset depegs, market incurs bad debt, contract is exploited, or chain stops.
- **Models:** propagation rules that translate scenarios through **typed** dependencies into observable failure, blocked access, or *potential* monetary loss.
- **Decisions:** compare *avoidable prospective loss* versus **feasible**, measured exit cost. Do not make up event probabilities. Without one, report loss ranges + break-even probability or INSUFFICIENT_EVIDENCE.

## Belem's judging priorities

| Criterion | Weight | Demonstration |
| --- | ---: | --- |
| Dependency discovery | 30% | Show evidence, breadth, precision/recall, unresolved edges |
| Impact estimation | 30% | Financial mechanism, explicit assumptions and uncertainty |
| Decision usefulness | 25% | Stay/exit or cannot exit/insufficient data with rationale |
| Working demo on real data | 15% | At least one verified live vault and repeatable incident replay |

## Vision versus delivery

**Ambitious product vision:** arbitrary wallet/vault/position across EVM, Solana and other chains; dynamic shared graph across thousands of positions; heterogeneous contracts, bridges, off-chain issuers, collateral/oracle/liquidity layers; AI-assisted evidence extraction and a reusable failure-physics simulation engine.

**Honest hackathon delivery:** Ethereum; live, automatically enumerated Morpho Vaults V1 (then V2); generic ERC-4626 identification; verified oracle/asset/market/admin/chain edges; two or three reproducible end-to-end incident models; exit feasibility and costs; interactive graph UI. A preselected vault is **only a demo entrypoint**. The real graph must be rebuilt from observed data.

**Long-term research:** cover arbitrary unknown vaults via ABI/source/trace analysis + LLM extraction; support other protocol families (Pendle, Aave, cross-chain bridges); model contagion, protocol interlocks and correlated shocks. No completeness guarantee without supporting evidence.

## Read in this order

1. [CODEX_START_HERE.md](CODEX_START_HERE.md) — copyable first prompt for Codex.
2. [AGENTS.md](AGENTS.md) — non-negotiable engineering rules for Codex.
3. [docs/PRODUCT.md](docs/PRODUCT.md) — user flow, ambitious goal and scope.
4. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system services, APIs and live graph refresh.
5. [docs/GRAPH_AND_DISCOVERY.md](docs/GRAPH_AND_DISCOVERY.md) — ontology, discovery methods, evidence.
6. [docs/RISK_ENGINE.md](docs/RISK_ENGINE.md) — simulation, monetary exposure, stay/exit rules.
7. [docs/ROADMAP.md](docs/ROADMAP.md) — milestones and acceptance criteria.
8. [docs/REFERENCES.md](docs/REFERENCES.md) — official sources and reference projects.
9. [docs/EVALUATION.md](docs/EVALUATION.md) — test data, historical replay, judged metrics.

## Intended repository growth

```text
apps/
  web/                 # Next.js + React Flow, live UI (future)
  api/                 # HTTP endpoints, job management (future)
workers/
  indexer/             # snapshot refresh + incident monitoring (future)
packages/
  adapters/            # ERC4626, Morpho V1, Morpho V2, Chainlink, Pendle (future)
  connectors/          # RPC, protocol APIs, indexers, source verification (future)
  graph/               # shared graph engine & storage (future)
  risk/                # scenario propagation and decision models (future)
  schemas/             # versioned types, validation (future)
  simulation/          # reproducible historical snapshots (future)
src/core/              # existing minimal dependency engine + scenario + decision
fixtures/              # existing illustrative fixture, never call it live
tests/                 # existing first unit tests
scripts/demo.mjs        # existing runnable CLI demo
```

Keep the existing core running while adding the first production-grade connector. Do not initially create many empty apps/workspaces merely to fill this target tree.

## Explicit safety and integrity rules

- **Read only.** No wallet signatures, funds movement, orders or automated execution.
- **Never pretend a fixture is live.** All output must declare fixture/live/historical-replay mode, block and timestamp.
- **Never make up probabilities, historical outcomes, exit quotes or missing dependency edges.**
- **Uncertainty is a feature.** Mark `verified`, `inferred`, `unresolved` and return INSUFFICIENT_EVIDENCE where needed.
- **Avoid double-counting.** Oracle/control/chain edges are not automatically fractional capital exposure.
- **No arbitrary-universal claim.** The scanner should try to classify any address, but report coverage and unknowns transparently.
