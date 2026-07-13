# Persistent Memory API and Operations

The persistent-memory subsystem provides one versioned, policy-ranked store for MCP and A2A.

## Core contract

A principal must be registered before it can write. Each write is append-first: revising a record creates a new version and marks the prior active version as superseded.

Memory records contain a namespace, subject key, type (`fact`, `plan`, `observation`, `decision`, or `warning`), confidence, and optional evidence references.

Queries reject revoked sources, expired records, superseded records, and evidence-empty records when `requireEvidence` is set. Set `includeExpired` or `includeSuperseded` only for audit workflows.

Each returned result includes weighted score components, evidence references, accepted policy rules, and warnings.

## MCP tools

- `cgraph_memory_register_principal`
- `cgraph_memory_write` and `cgraph_memory_revise`
- `cgraph_memory_query`
- `cgraph_memory_conflicts` and `cgraph_memory_resolve`
- `cgraph_memory_expire` and `cgraph_memory_compact`
- `cgraph_memory_backfill` and `cgraph_memory_migration_report`
- `cgraph_memory_metrics`
- `cgraph_memory_revoke_principal`

## A2A methods

The canonical A2A names are `register_memory_principal`, `write_memory`, `revise_memory`, `query_memory`, `resolve_memory_conflict`, and `compact_memory`. The `memory.*` names remain supported aliases, including `memory.revoke_principal`, `memory.backfill`, `memory.migration_report`, and `memory.metrics`.

Existing `register_agent`, `revoke_agent`, and `write_node` calls dual-write into persistent memory unless `.cgraph.json` sets `memory.enabled` to `false`.

## Policy and lifecycle

The default score is $0.35T + 0.25R + 0.20C + 0.20E - P$, where trust, recency, confidence, and evidence are all normalized to $[0,1]$.

Use `memory.expire`/`cgraph_memory_expire` to mark elapsed records. Use compaction after the retention period to tombstone expired or revoked records. Conflicting active versions for one namespace/subject/type are automatically recorded for review.

## Configuration

See [Memory configuration](memory-configuration.md) for all policy defaults, recommended production settings, and scheduled-maintenance examples.

See [Advanced memory](advanced-memory.md) for peer replication, hybrid retrieval, deterministic reconciliation, and soak evaluation.

`enabled: false` provides a reversible compatibility-mode rollback for legacy A2A operations. It does not delete persistent-memory tables or data.
