# Persistent Memory Migration Guide

## Safe rollout

1. Deploy with `memory.enabled: true` (the default).
2. Existing A2A compatibility operations dual-write future registration and node-write activity.
3. Run `cgraph_memory_backfill` once to import legacy `a2a/` graph nodes. The operation records markers and is idempotent.
4. Run `cgraph_memory_migration_report` (or A2A `memory.migration_report`) and require zero parity mismatches before switching consumers.
5. Compare legacy results with `cgraph_memory_query` for the same logical subject during the release window.
6. Move clients to the canonical MCP/A2A memory operations.

## Rollback

Set `memory.enabled` to `false` in `.cgraph.json` to stop compatibility dual-writes. Existing tables and historical versions remain intact, so re-enabling the flag does not require restoration.

## Legacy import semantics

Legacy A2A node documents become `observation` records in the `legacy-a2a` namespace. They are attributed to the recorded `agent_id` when present, otherwise `legacy-import`; each receives a `legacy_import` evidence reference.
