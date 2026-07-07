# cgraph A2A Architectural Changes

This document summarizes the architecture changes introduced by the A2A rollout on branch `a2a`.

## Change Summary

The A2A rollout added a new runtime integration surface (HTTP JSON-RPC), introduced trust-aware write semantics, extended storage to capture edge cost metadata, and added benchmark + CI gate infrastructure focused on multihop root-cause quality.

## 1) New A2A Runtime Layer

### Added module
- `src/a2a.ts`

### Purpose
- Exposes cgraph as an A2A-capable HTTP service.
- Serves an agent card endpoint for capability discovery.
- Handles JSON-RPC methods for registration, writes, lineage reads, and agent-scoped query.

### Core behavior
- Entrypoint: `startA2AServer(rootDir, { port, host })`
- Request router: `handleA2ARpcRequest(rootDir, request)`
- Methods:
  - `register_agent`
  - `write_node`
  - `read_lineage`
  - `query_by_agent`

### Architectural impact
- Introduces transport-layer separation between protocol handling and graph persistence.
- Allows external agents to interact without directly linking library APIs.

## 2) Trust and Identity Model

### Added trust path
- Signed registration flow with Ed25519 verification in A2A request handling.
- Policy resolution via config-driven trust mode.

### Config integration changes
- `src/config.ts` was extended to parse A2A trust configuration:
  - `trustMode`
  - `maxVerifyLatencyMs`
  - `allowVerifyFallback`

### Type system changes
- `src/types.ts` was extended with A2A request/response and trust-related shapes.

### Architectural impact
- Moves write authorization from implicit caller trust to explicit registration + signature verification semantics.
- Enables deterministic behavior for verified vs unverified writes under `registration_only` mode.

## 3) Storage Layer Evolution

### Updated module
- `src/storage.ts`

### Data model changes
- Edge cost columns and migration support were added.
- Edge insertion paths now support optional cost metadata.

### Why this matters
- A2A multihop workflows require visibility into path cost and confidence-like metadata.
- Benchmark and analysis layers can measure `cost_visibility_coverage` reliably.

### Architectural impact
- Storage schema now supports protocol-level provenance and cost-aware reasoning without changing existing graph query APIs.

## 4) Public Surface and Entry Wiring

### Updated modules
- `src/index.ts`
- `src/cli.ts`

### Changes
- Export surface updated to include A2A server helpers.
- CLI serve flow extended to support A2A mode (`serve --a2a`).

### Architectural impact
- A2A becomes a first-class runtime mode alongside MCP and CLI workflows.

## 5) Benchmarking Architecture for A2A

### Added modules
- `scripts/benchmark-a2a-multihop.mjs`
- `scripts/benchmark-a2a-multihop.helpers.mjs`

### Added fixtures
- `fixtures/a2a-benchmark-budget.json` (strict CI profile)
- `fixtures/a2a-benchmark-budget.local.json` (local developer profile)

### Benchmark capabilities
- Simulates multihop agent chains.
- Measures:
  - root cause accuracy
  - conflict resolution accuracy
  - graph RPC efficiency
  - cost visibility coverage
  - estimated agent speedup vs flat workflows
- Supports baseline/save/compare/enforce modes.

### Architectural impact
- Quality verification moved from ad-hoc checks to reproducible, policy-driven benchmark gates.

## 6) CI Gate Integration

### Added workflow
- `.github/workflows/a2a-benchmark-gate.yml`

### Purpose
- Enforces A2A benchmark budget thresholds in CI.
- Prevents regressions in accuracy, RPC count, and performance budgets.

### Architectural impact
- Introduces measurable architecture contracts for A2A behavior at PR time.

## 7) Test Architecture Expansion

### Added tests
- `__tests__/a2a.test.ts`
- `__tests__/benchmark-a2a-multihop.test.ts`

### Updated tests
- `__tests__/storage.test.ts`

### Coverage intent
- Protocol correctness
- trust/registration paths
- benchmark parser + gate logic
- schema/cost compatibility

### Architectural impact
- Improves confidence in cross-layer behavior (transport -> trust -> storage -> benchmark).

## 8) Documentation and Operational Model

### Updated docs
- `README.md`
- `docs/cli-usage.md`
- `docs/mcp-workflows.md`

### What changed conceptually
- cgraph is now positioned not only as a graph CLI/MCP tool, but also as an A2A memory substrate with measurable multihop performance and enforceable quality gates.

## 9) Final Architecture Picture

A2A integration introduced a new protocol layer on top of existing graph services while preserving the core architecture:

- Ingestion/indexing remains in `src/indexer.ts`.
- Core analysis remains in `src/graph.ts`.
- Persistence remains in `src/storage.ts` (extended for cost metadata).
- Interfaces now include:
  - CLI
  - MCP
  - A2A HTTP JSON-RPC

This keeps the core graph engine stable while expanding interoperability and verification rigor.
