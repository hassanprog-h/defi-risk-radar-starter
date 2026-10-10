# Dependency ontology, discovery strategies, and truthfulness

## What is a dependency?

Anything a DeFi position materially relies on for **value, yield, accounting, execution, permission, settlement, redemption, or withdrawal**. This is **not** synonymous with token-price correlation. A contract call is a *candidate technical relation*, not automatically a capital exposure.

## Minimal node types

`position`, `vault`, `lending_market`, `asset`, `yield_source`, `issuer`, `oracle`, `amm`, `chain`, `bridge`, `contract`, `administrator`, `protocol`, `exit_route`.

## Directed relationship types and their meanings

| Relationship (dependent -> dependency) | Category | What failure could imply | Evidence |
| --- | --- | --- | --- |
| `HOLDS_SHARES_IN` | position | User owns a claim on a vault | verified balance / position API |
| `ALLOCATES_TO` | vault -> lending market | Some capital exposed to downstream market | vault allocation and asset accounting |
| `USES_ORACLE` | lending market -> oracle | Incorrect pricing may change liquidation safety | configured oracle address + feed validation |
| `ACCEPTS_COLLATERAL` | lending market -> asset | Collateral price/depeg impacts borrower positions | market config |
| `ACCOUNTING_ASSET` | vault -> asset | Denomination and sometimes direct redemption exposure | ERC-4626 `asset()`; distinguish denomination from backing |
| `BACKED_BY` | token/wrapper -> asset or issuer | Backing/redemption/default risk | verified issuer/protocol docs + on-chain reserve facts |
| `EARNS_YIELD_FROM` | position/strategy -> market | Yield failure or protocol default | adapter/strategy state |
| `SETTLES_ON` | contract -> chain | Chain outage prevents writes/redemption | actual deployment + chain semantics |
| `CONTROLLED_BY` / `UPGRADEABLE_BY` | contract -> admin | Privileged changes, upgrade or pause | permissions, proxy, timelock |
| `BRIDGED_BY` | wrapped asset -> bridge | Backing or messaging compromise | issuer/bridge adapter |
| `EXITS_THROUGH` | position -> exit route | Liquidity and quote availability | current executable direct withdrawal or swap quote |
| `USES_CONTRACT` | contract -> other contract | Unknown until semantic role classified | source code/static/dynamic trace |

**Important:** `USES_ORACLE`, `SETTLES_ON`, `CONTROLLED_BY` are not 10%/20%/100% allocation edges. Never multiply portfolio value by the number or weight of such edges.

## Six discovery techniques (ordered by reliability)

1. **Known protocol contract state:** Morpho market identifiers, actual vault allocation, oracle address, admin roles. Source of truth for explicit configs.
2. **Protocol API with independent verification:** indexed Morpho/Pendle relationships; account for indexer lag and API schema changes.
3. **EVM standards:** ERC-4626 `asset`, `totalAssets`, `maxWithdraw`, conversions; ERC-20 metadata; ERC-1967 proxy slots; standard access patterns.
4. **Static code + verified ABI:** Slither function call graph and auth; resolve constants/stored addresses. This yields potential paths, not automatically economic dependencies.
5. **Runtime call/transaction traces:** actually executed calls, events, cross-contract capital movements; cannot see never-executed branches and may be historically incomplete.
6. **AI-assisted document/code extraction:** returns candidate edges with exact source snippets; deterministic verification before promotion. Optional fine-tuning only after benchmark proves benefit.

Historical incidents and market data **validate consequence models**; they do not directly prove every structural dependency.

## Universal detection vs protocol-specific depth

- **Level 0:** A contract exists at this address on this chain; what bytecode/ABI do we know?
- **Level 1:** ERC-4626/vault identity and its primary accounting asset, chain, proxy/admin.
- **Level 2:** Actual capital flows/allocations, markets, collateral, oracles, withdrawal routes using known adapters.
- **Level 3:** Nested vaults, bridges/wrappers, issuer/redemption risk, price feed upstream, implied liquidity dependencies and contagion.
- **Level 4:** unknown contracts inferred from source/traces/AI and evidence validated.

Never market a Level-1 result as complete Level-3 coverage. A universal **attempt** is feasible; a universal **complete** analysis is not currently a defensible guarantee.

## Coverage report per position

```json
{
  "positionId": "eip155:1:0x...",
  "mode": "live",
  "atBlock": "123...",
  "verifiedEdges": 12,
  "inferredEdges": 2,
  "unresolvedEdges": 3,
  "categories": {
    "settlement": "verified",
    "asset": "verified",
    "lending": "verified",
    "oracle": "verified",
    "yieldSource": "partial",
    "issuer": "not_applicable_or_unknown",
    "liquidity": "pending_quote",
    "admin": "verified",
    "bridges": "not_applicable_or_unknown"
  }
}
```

The example is only a proposed schema, not a live result. Distinguish `not_applicable` from `not_observed` and `unsupported`.

## AI rules

AI may identify an oracle candidate from an unfamiliar contract's verified source. It cannot know that candidate is correct solely by returning `confidence: 0.97`. For verified graph edges, independently read contract state or tie inference to high-quality explicit contract code. Model confidence is **not** incident probability. Avoid training on already-known versions of contracts while evaluating the same versions (data leakage).

## Acceptance tests for discovery

- Works on 2+ distinct *real* Morpho vaults with no manual edge maps.
- Reverse impact for shared oracle/asset does not duplicate entities across vaults.
- Cycle, unknown address, proxy upgrade, duplicate contract, chain collision and stale API handled safely.
- Every displayed edge has typed relationship and evidence/status; unsupported categories are reported.
- Precision/recall measured on independently curated gold dataset; include materiality-weighted recall for critical edges.
