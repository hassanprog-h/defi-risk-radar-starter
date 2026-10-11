# Saved real-data graph

`steakhouse-usdc.json` and `keyrock-usdc-v2.json` are actual read-only inspections acquired on 2026-10-11 from the official Morpho public API, Ethereum contract reads and Etherscan verified-source metadata. The V2 recording also includes public Pendle market-directory data. Each relationship includes its own evidence. API and RPC block heights, acquisition time and coverage gaps are preserved. V2 financial attribution remains unknown where allocations lack a common block anchor.

This file is a **historical recording**, not a fresh state or a record of an actual security incident. Load it through the dashboard's saved-graph picker, or run `npm run replay -- fixtures/recordings/steakhouse-usdc.json 10000 0.2`. Replay always changes the mode to `historical_replay`; it never changes the original acquisition timestamp or allows current exit recommendations. The position size and loss fraction are hypothetical assumptions.

Regenerate a recording with `node scripts/inspect.mjs <chainId>:<vaultAddress> > <recording.json>` after `npm run build`. Do not substitute snapshots containing private data or credentials. Imported schema validation checks structural consistency, not source authenticity.
