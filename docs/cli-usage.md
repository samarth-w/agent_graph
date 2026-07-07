# CLI and library usage notes

## Quick start

```bash
npm install
npm run build
node ./bin/cgraph.js index .
node ./bin/cgraph.js status . --pretty
```

## Diagnostics and repair

The library now exposes lightweight diagnostics helpers for inspecting the local graph database and repairing orphan edges when they appear.

```ts
import { GraphDB, inspectDbHealth, repairDbHealth } from 'cgraph';

const db = await GraphDB.open('./.cgraph/graph.db');
const report = inspectDbHealth(db, process.cwd());

if (!report.ok) {
  const repaired = repairDbHealth(db, process.cwd());
  console.log(`Repaired ${repaired.repaired_count} edge(s).`);
}
```

## Baseline and trend workflow

You can now persist health snapshots and compare the current project state with saved baselines.

```bash
node ./bin/cgraph.js baseline save baseline-1 --dir .
node ./bin/cgraph.js baseline list --dir .
node ./bin/cgraph.js trend --dir .
```

## PR summary workflow

Generate a single risk report for a pull request by combining changed files, changed symbols, impact radius, and affected tests.

```bash
node ./bin/cgraph.js pr-summary --dir . --pretty
node ./bin/cgraph.js pr-summary --dir . --files src/cli.ts,src/mcp.ts --pretty
node ./bin/cgraph.js pr-summary --dir . --files src/cli.ts --format markdown
```

## Quality gate workflow

Enforce repository quality thresholds in one command.

```bash
node ./bin/cgraph.js gate --dir . --pretty
node ./bin/cgraph.js gate --dir . --files src/cli.ts --max-cycles 2 --max-dead 50 --min-health 70 --max-risk 60
node ./bin/cgraph.js gate --dir . --files src/cli.ts --format markdown
```

## Benchmark fixture workflow

A small fixture is available in [fixtures/impact-eval-cases.sample.json](../fixtures/impact-eval-cases.sample.json) to help you exercise impact evaluation locally.

```bash
node ./bin/cgraph.js benchmark fixtures/impact-eval-cases.sample.json --dir demo/finance --pretty
```

## A2A adapter workflow

Serve cgraph as an HTTP A2A JSON-RPC adapter:

```bash
node ./bin/cgraph.js serve --a2a --port 3210 --dir .
```

Register a verified agent claim:

```bash
curl -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"reg-1","method":"register_agent","params":{"agent_id":"agent.demo","claim":"{\"capabilities\":[\"write_node\"]}","signature":"<base64>","public_key":"<pem>"}}'
```

Then write a node:

```bash
curl -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"write-1","method":"write_node","params":{"agent_id":"agent.demo","name":"finding","kind":"variable"}}'
```

Read lineage for a node:

```bash
curl -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"lineage-1","method":"read_lineage","params":{"qualified_name":"a2a/agent.demo/123.json::finding"}}'
```

Query authored nodes by agent:

```bash
curl -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"query-1","method":"query_by_agent","params":{"agent_id":"agent.demo"}}'
```

## A2A benchmark scope (Phase 1C)

The A2A multi-hop benchmark path is scoped to a dedicated harness so we can compare flat logs vs graph-backed traces without coupling to the existing code-intelligence benchmark runner:

```bash
node ./scripts/benchmark-a2a-multihop.mjs
npm run benchmark:a2a
```

Run with an explicit iteration count:

```bash
node ./scripts/benchmark-a2a-multihop.mjs 25
```

Save a baseline report, then compare a new run against it:

```bash
node ./scripts/benchmark-a2a-multihop.mjs 25 --save reports/a2a-baseline.json
node ./scripts/benchmark-a2a-multihop.mjs 25 --compare reports/a2a-baseline.json --save reports/a2a-current.json
```

Fast workflow with npm scripts:

```bash
npm run benchmark:a2a:baseline
npm run benchmark:a2a:compare
npm run benchmark:a2a:gate
npm run benchmark:a2a:gate:local
```

Enforce gate thresholds with a budget file:

```bash
node ./scripts/benchmark-a2a-multihop.mjs 25 \
  --compare reports/a2a-baseline.json \
  --save reports/a2a-current.json \
  --budget fixtures/a2a-benchmark-budget.json \
  --enforce
```

Use the local budget profile for faster iteration when runtime jitter is expected:

```bash
node ./scripts/benchmark-a2a-multihop.mjs 15 \
  --compare reports/a2a-baseline.json \
  --save reports/a2a-current.json \
  --budget fixtures/a2a-benchmark-budget.local.json \
  --enforce
```

The benchmark emits JSON with:

- `root_cause_accuracy`: how often both modes identify the same injected bad hop.
- `conflict_resolution_accuracy`: how often the trust/recency/confidence policy chooses the expected winner.
- `flat_log.avg_tool_calls` vs `graph_trace.avg_rpc_calls`: call-count comparison.
- `graph_trace.cost_visibility_coverage`: share of lineage nodes with usable cost metadata.
- `estimated_agent_speedup_vs_flat`: modeled end-user speedup using per-call round-trip cost.
- `compute_speedup_vs_flat`: raw in-process compute ratio (usually less relevant than agent speedup).
- `comparison.delta.*`: percent and absolute deltas vs baseline report when `--compare` is provided.
- `gate.ok` and `gate.violations`: pass/fail budget evaluation output.

Budget thresholds now support:

- `minConflictResolutionAccuracy`
- `minCostVisibilityCoverage`
```
