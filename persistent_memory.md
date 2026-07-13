# Persistent Memory Implementation Spec

Status: Draft for implementation
Owner: cgraph core
Date: 2026-07-13

## 1) Purpose

This document defines a complete, production-grade plan to implement persistent memory in cgraph and bridge MCP and A2A over one canonical memory system.

The intent is to remove ambiguity, minimize architecture drift, and provide hard acceptance criteria. If all sections in this document are implemented and verified, cgraph will have a durable, policy-aware, explainable memory substrate suitable for multi-agent workflows.

## 2) Problem Statement

Current capabilities are strong but incomplete for true persistent memory:

1. Storage is sql.js in-memory first, file-export second; this does not guarantee robust multi-process durability semantics.
2. Memory is encoded as generic graph nodes/docs, not first-class memory records with lifecycle and conflict semantics.
3. MCP and A2A are parallel protocol surfaces, not adapters on top of one memory service contract.
4. Retrieval quality is mostly structural lookup, not policy-weighted memory ranking.
5. Evaluation focuses on graph/tool correctness, not memory quality over time.

## 3) Scope

In scope:

1. Persistent storage semantics and schema migration.
2. Canonical MemoryService used by both MCP and A2A.
3. First-class memory model (facts, versions, evidence, conflicts, retention).
4. Retrieval policy engine (trust, recency, confidence, evidence).
5. Protocol bridge parity for memory operations.
6. Full test and benchmark framework for memory quality and reliability.

Out of scope for this cycle:

1. Full distributed consensus across multiple nodes.
2. Formal verification.
3. Global multi-tenant SaaS control plane.

## 4) Design Principles

1. Single semantic core: MCP and A2A are transport adapters only.
2. Append-first memory log: no destructive overwrite of historical facts.
3. Explainable retrieval: every returned memory carries score contributions and evidence references.
4. Policy-driven lifecycle: TTL, retention, revocation, tombstoning, and compaction are explicit.
5. Deterministic behavior under test: stable ordering and reproducible outputs.
6. Safe migration: old graph data remains readable while new memory tables are introduced.

## 5) Target Architecture

```text
                  +--------------------+
                  |   MCP Transport    |
                  +--------------------+
                           |
                  +--------------------+
                  |   A2A Transport    |
                  +--------------------+
                           |
                    (shared adapter)
                           |
                  +--------------------+
                  |   MemoryService    |
                  |  (canonical API)   |
                  +--------------------+
                   |   |   |    |   |
                   |   |   |    |   +--> Policy Engine
                   |   |   |    +------> Conflict Resolver
                   |   |   +-----------> Evidence Resolver
                   |   +---------------> Principal/Trust Service
                   +-------------------> Durable Store
```

### 5.1 Components

1. MemoryService:
- Creates, updates, supersedes, revokes, and queries memory records.
- Exposes one semantic API used by MCP and A2A.

2. Principal/Trust Service:
- Normalizes agent identity, registration, revocation, expiry, and trust tier.
- Provides a principal snapshot for retrieval policy.

3. Policy Engine:
- Computes retrieval rank using trust, recency, confidence, and evidence.
- Produces structured explanation of scoring.

4. Durable Store:
- Owns append log, record versions, conflict links, and secondary indexes.
- Enforces atomic writes and crash-safe commits.

## 6) Storage Strategy

## 6.1 Engine Decision

Recommended baseline: move memory tables to a file-backed SQLite runtime with real locking semantics (for example, better-sqlite3) while retaining compatibility with existing graph tables.

Rationale:

1. Cross-process durability and locking behavior are straightforward.
2. Transaction semantics and WAL mode improve crash behavior.
3. Migration complexity is manageable and incremental.

Fallback (if immediate engine migration is blocked):

1. Introduce strict single-writer process with lockfile + queue.
2. Use atomic snapshot write protocol (temp file + fsync + rename).
3. Mark this as temporary and schedule full migration.

## 6.2 Required Durability Properties

1. Atomic commit for memory write batches.
2. Read-your-writes consistency inside one process.
3. No silent lost-update under concurrent writes.
4. Startup recovery after interrupted write.
5. Deterministic ordering for equal-score retrieval ties.

## 7) Canonical Data Model

Memory must be explicit, versioned, and explainable.

## 7.1 Logical Entities

1. principals:
- principal_id, key material fingerprint, status, trust tier, expiry, revoked_at.

2. memory_records:
- memory_id (stable id)
- namespace (project, agent, channel)
- subject_key (entity/topic anchor)
- memory_type (fact, plan, observation, decision, warning)
- created_by (principal_id)
- created_at
- status (active, superseded, revoked, expired, tombstoned)

3. memory_versions:
- version_id (append-only)
- memory_id
- payload_json
- confidence
- evidence_ref_count
- valid_from, valid_to
- supersedes_version_id

4. memory_evidence:
- evidence_id
- version_id
- source_type (file, test, benchmark, human_note, tool_result)
- source_ref
- excerpt_hash
- captured_at

5. memory_conflicts:
- conflict_id
- left_version_id
- right_version_id
- conflict_type (contradiction, stale, duplicate, uncertain)
- resolution_state (open, winner_selected, unresolved)
- winner_version_id

6. memory_access_log:
- access_id
- principal_id
- operation (create, revise, query, revoke)
- request_fingerprint
- created_at

## 7.2 Example SQL Skeleton

```sql
CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  trust_tier TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES principals(principal_id)
);

CREATE TABLE IF NOT EXISTS memory_versions (
  version_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  supersedes_version_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_records(memory_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_subject
  ON memory_records(namespace, subject_key, status);

CREATE INDEX IF NOT EXISTS idx_versions_memory_time
  ON memory_versions(memory_id, created_at DESC);
```

## 8) MemoryService Contract

All protocol layers call this contract.

## 8.1 Core Operations

1. registerPrincipal(input) -> PrincipalSnapshot
2. revokePrincipal(input) -> PrincipalSnapshot
3. writeMemory(input) -> MemoryWriteResult
4. reviseMemory(input) -> MemoryWriteResult
5. queryMemory(input) -> MemoryQueryResult
6. resolveConflict(input) -> ConflictResolutionResult
7. expireMemory(input) -> ExpiryRunResult
8. compactMemory(input) -> CompactionResult

## 8.2 Write Semantics

1. Every write creates a new version row.
2. Overwrite is represented by supersedes link.
3. Optional idempotency_key prevents duplicate writes on retries.
4. Principal status is validated at write time.
5. Trust snapshot is stamped into write metadata.

## 8.3 Query Semantics

Query returns:

1. candidate versions
2. ranked result list
3. score breakdown per result
4. conflict summary
5. policy warnings (stale data, low evidence, revoked source)

## 9) Retrieval Policy Engine

## 9.1 Default Score Function

Let each candidate have:

- T = trust score in [0,1]
- R = recency score in [0,1]
- C = confidence score in [0,1]
- E = evidence score in [0,1]
- P = penalty in [0,1] for conflicts/revocation/staleness

Default weighted score:

$$
S = 0.35T + 0.25R + 0.20C + 0.20E - P
$$

Tie-breakers in order:

1. Higher trust tier
2. More recent valid_from
3. Lexicographic version_id

## 9.2 Hard Rejection Rules

Reject candidate if:

1. principal status is revoked
2. valid_to is in the past and no override is requested
3. evidence_ref_count is zero when query requires evidence

## 9.3 Explainability Output

Each result includes:

1. score_total
2. score_components
3. accepted/rejected rules
4. evidence refs used

## 10) MCP-A2A Bridge Plan

## 10.1 Principle

MCP and A2A become transport adapters over MemoryService.

## 10.2 Mapping Table

1. A2A register_agent -> MemoryService.registerPrincipal
2. A2A revoke_agent -> MemoryService.revokePrincipal
3. A2A write_node -> MemoryService.writeMemory
4. A2A query_by_agent/read_lineage (memory mode) -> MemoryService.queryMemory
5. MCP memory tools (new) -> same MemoryService operations

## 10.3 New MCP Tools (Memory Tier)

1. cgraph_memory_write
2. cgraph_memory_revise
3. cgraph_memory_query
4. cgraph_memory_conflicts
5. cgraph_memory_resolve
6. cgraph_memory_expire
7. cgraph_memory_compact

## 10.4 New A2A Methods

1. write_memory (structured memory write)
2. revise_memory
3. query_memory
4. resolve_memory_conflict
5. compact_memory

Backward compatibility:

1. Keep existing write_node/query_by_agent/read_lineage.
2. Mark as compatibility mode in docs.
3. Internally route through adapters where feasible.

## 11) Security and Policy Model

## 11.1 Unified Principal Model

Principal states:

1. verified
2. unverified
3. expired
4. revoked

Write policy matrix:

1. verified: full write
2. unverified: allowed only in permissive mode with penalty tags
3. expired: blocked or downgraded based on policy
4. revoked: blocked

## 11.2 Namespaces and Access

Memory namespaces:

1. global
2. workspace
3. agent
4. workflow/session

Each query/write checks namespace ACL with principal snapshot.

## 11.3 Rate Limiting

1. Replace process-local buckets with durable/shared limiter state.
2. Emit standardized transport errors:
- JSON-RPC code for logical error
- HTTP 429 for transport endpoint mode where applicable

## 12) Migration Strategy

## 12.1 Schema Migration

Phase 1:

1. Add new memory tables in side-by-side mode.
2. Keep existing graph tables untouched.

Phase 2:

1. Dual-write from A2A compatibility methods.
2. Validate parity between old node-based memory and new memory tables.

Phase 3:

1. Switch read path to MemoryService-first.
2. Keep fallback read for one release window.

## 12.2 Data Backfill

1. Identify legacy A2A memory nodes by namespace/path pattern.
2. Convert each legacy doc into memory_records + memory_versions rows.
3. Generate synthetic evidence refs for legacy records with source=legacy_import.

## 12.3 Rollback

1. Feature flag memory_service_enabled.
2. Disable flag to route reads/writes to compatibility mode.
3. Keep migration idempotent.

## 13) Implementation Phases

## Phase A: Foundations (week 1)

1. Add memory schema and migration scaffolding.
2. Introduce MemoryService interfaces and stubs.
3. Add principal model shared by A2A and MCP.

Files:

1. src/storage.ts
2. src/types.ts
3. src/memory/service.ts (new)
4. src/memory/policy.ts (new)

Acceptance:

1. Build passes.
2. Migrations are idempotent.
3. New unit tests for schema creation pass.

## Phase B: Protocol Bridge (week 2)

1. Route A2A methods through MemoryService adapters.
2. Add MCP memory tools mapped to same service methods.
3. Add parity tests across MCP and A2A for same scenarios.

Files:

1. src/a2a.ts
2. src/mcp.ts
3. __tests__/a2a.test.ts
4. __tests__/mcp.test.ts
5. __tests__/memory-bridge.test.ts (new)

Acceptance:

1. Identical semantic outputs for equivalent MCP/A2A requests.
2. Compatibility methods remain functional.

## Phase C: Retrieval Quality (week 3)

1. Implement scoring engine and explainability payload.
2. Add conflict detection and resolution endpoints.
3. Add expiry and compaction jobs.

Files:

1. src/memory/policy.ts
2. src/memory/conflicts.ts (new)
3. src/memory/maintenance.ts (new)
4. __tests__/memory-policy.test.ts (new)

Acceptance:

1. Deterministic ranking tests pass.
2. Conflict tests pass.
3. Expiry/compaction tests pass.

## Phase D: Hardening and Ops (week 4)

1. Add durability chaos tests.
2. Add memory benchmarks and SLO checks.
3. Add observability hooks and dashboards docs.

Files:

1. scripts/benchmark-memory.mjs (new)
2. __tests__/memory-chaos.test.ts (new)
3. docs/troubleshooting.md
4. docs/README.md

Acceptance:

1. No lost writes in stress scenarios.
2. SLO budgets pass in CI.

## 14) Test Plan (Airtight)

## 14.1 Correctness

1. Unit tests for each MemoryService method.
2. Property tests for idempotency and version chaining.
3. Determinism tests for ranking tie-breakers.

## 14.2 Reliability

1. Concurrent write storm test (single process and multi-process simulation).
2. Crash injection during commit.
3. Recovery verification on restart.

## 14.3 Security

1. Revoked principal cannot write.
2. Expired principal behavior matches policy.
3. Namespace ACL denial cases.

## 14.4 Bridge Conformance

For each scenario, assert MCP and A2A parity:

1. principal registration
2. memory write
3. conflict retrieval
4. expiry behavior
5. query ranking order

## 14.5 Performance

Benchmarks must report:

1. write p50/p95 latency
2. query p50/p95 latency
3. compaction duration
4. throughput under mixed read/write load

## 15) SLOs and Acceptance Gates

Release is blocked if any fail:

1. Lost-write rate > 0 in stress tests.
2. MCP-A2A conformance < 100% on canonical suite.
3. Query p95 exceeds configured budget for baseline dataset.
4. Evidence-required query returns evidence-empty result.
5. Determinism suite fails.

## 16) Risks and Mitigations

Risk 1: Protocol drift between MCP and A2A.
Mitigation: single MemoryService + conformance tests in CI.

Risk 2: Migration complexity.
Mitigation: side-by-side tables + feature flag + idempotent backfill.

Risk 3: Ranking regressions.
Mitigation: fixed benchmark corpus + pinned expected order snapshots.

Risk 4: Performance regression from richer policy.
Mitigation: indexed query paths + precomputed feature columns + cache.

## 17) Open Decisions (must be finalized)

1. Storage engine migration now vs deferred with temporary single-writer mode.
2. Default strictness for unverified principals.
3. Namespace ACL defaults for local-only deployments.
4. Compaction cadence and retention period by namespace.

## 18) Deliverables Checklist

Code:

1. MemoryService implementation
2. Principal/trust unification
3. MCP memory tools
4. A2A memory methods
5. Conflict and lifecycle jobs

Docs:

1. API contract reference
2. Migration guide
3. Operational runbook
4. Benchmark reproduction guide

Validation:

1. Conformance suite
2. Stress/chaos suite
3. Performance suite
4. Security suite

## 19) Definition of Done

Persistent memory is considered complete only when all conditions are true:

1. Durable store guarantees no silent lost updates under tested concurrency models.
2. MCP and A2A memory operations are semantic adapters over one shared service.
3. Memory records are versioned, evidence-linked, policy-ranked, and explainable.
4. Revocation, expiry, and retention are enforced and observable.
5. CI gates pass conformance, reliability, security, and performance checks.

---

This spec is intentionally strict. The goal is not feature count; the goal is trustworthy memory behavior under real multi-agent load.
