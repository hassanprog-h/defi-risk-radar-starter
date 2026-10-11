# Attributed upstream response captures

These files are **historical public API captures**, acquired for offline adapter tests. They are not fixtures describing invented markets, and are not a substitute for fresh live inspection.

Each capture records the source URL, query/variables where applicable, acquisition timestamp and original response. The queries were checked against Morpho's public introspection schema and official documentation at https://docs.morpho.org/developers/api/morpho-vaults/ on 2026-10-11. Example V1 and V2 addresses are provided by that documentation; the second V1 address was also observed in Morpho's public listed-vault directory.

`scripts/research-upstream.mjs` regenerates the captures through read-only requests. It does not use wallet keys, sign transactions or copy third-party implementation code. Test doubles may modify these responses for adversarial cases; those modifications are confined to tests.
