# Saved real-data graph

`steakhouse-usdc.json` is an actual read-only inspection acquired on 2026-10-11 from the official Morpho public API, Ethereum contract reads and Etherscan verified-source metadata. Each relationship includes its own evidence. API and RPC block heights, acquisition time and coverage gaps are preserved.

This file is a **historical recording**, not a fresh state or a record of an actual security incident. Load it through the dashboard's saved-graph picker, or run `npm run replay -- fixtures/recordings/steakhouse-usdc.json 10000 0.2`. Replay always changes the mode to `historical_replay`; it never changes the original acquisition timestamp or allows current exit recommendations. The position size and loss fraction are hypothetical assumptions.

Regenerate a recording with `node scripts/inspect.mjs <chainId>:<vaultAddress> > <recording.json>` after `npm run build`. Do not substitute snapshots containing private data or credentials. Imported schema validation checks structural consistency, not source authenticity.
