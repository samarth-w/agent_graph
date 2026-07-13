# cgraph Documentation Map

This page is the single landing index for project documentation.

## Start Here

- [README.md](../README.md): Product overview, quick start, commands, A2A workflow, and performance summary.
- [architecture.md](../architecture.md): Canonical full-system architecture across ingestion, storage, analysis, and interfaces.
- [improvements.md](../improvements.md): Forward-looking 15/10 masterplan with phases, KPIs, and risk controls.
- [aprogress_150.md](../aprogress_150.md): Historical implementation tracker and milestone completion notes.
- [CHANGELOG.md](../CHANGELOG.md): Versioned release history and unreleased changes.

## Usage Guides

- [cli-usage.md](cli-usage.md): CLI command reference and operational examples.
- [mcp-workflows.md](mcp-workflows.md): MCP tool workflow patterns for agent usage.
- [persistent-memory.md](persistent-memory.md): Canonical memory API, policy behavior, and MCP/A2A bridge.
- [memory-migration.md](memory-migration.md): Side-by-side rollout, backfill, and rollback procedure.
- [memory-operations.md](memory-operations.md): Lifecycle, conflict, and benchmark operational runbook.
- [troubleshooting.md](troubleshooting.md): Common issues and debugging paths.
- [release-process.md](release-process.md): Release flow and automation expectations.

## Benchmarks and Evaluation Inputs

- [demo/demo_benchmark.md](../demo/demo_benchmark.md): Detailed benchmark evidence and walkthroughs.
- [fixtures/impact-eval-cases.sample.json](../fixtures/impact-eval-cases.sample.json): Sample impact evaluation dataset.
- [fixtures/performance-budget.json](../fixtures/performance-budget.json): Performance budget policy used by CI and local checks.
- [fixtures/a2a-benchmark-budget.json](../fixtures/a2a-benchmark-budget.json): Strict A2A benchmark gate profile.
- [fixtures/a2a-benchmark-budget.local.json](../fixtures/a2a-benchmark-budget.local.json): Local A2A benchmark gate profile.

## Script Entry Points

- [scripts/benchmark-agent.mjs](../scripts/benchmark-agent.mjs): Agent workflow benchmark replay.
- [scripts/benchmark.mjs](../scripts/benchmark.mjs): MCP/index benchmark runner.
- [scripts/benchmark-a2a-multihop.mjs](../scripts/benchmark-a2a-multihop.mjs): A2A multihop benchmark and gate runner.
- [scripts/benchmark-memory.mjs](../scripts/benchmark-memory.mjs): Persistent-memory latency and throughput benchmark.
- [scripts/check-performance-budget.mjs](../scripts/check-performance-budget.mjs): Enforces performance budget thresholds.
