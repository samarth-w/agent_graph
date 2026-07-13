<div align="center">

# cgraph

### Code intelligence at graph speed.

Turn any repository into a queryable knowledge graph so engineers and AI agents can move from question to decision in one hop.

[Quick Start](#quick-start) · [Tool Compartments](#tool-compartments) · [A2A API](#a2a-api-workflow) · [Architecture](#architecture) · [Development](#development)

</div>

---

## Why cgraph

cgraph precomputes symbols, relationships, and usage paths so high-value questions become direct queries instead of multi-step grep loops.

What this unlocks:

- Faster investigation: callers, callees, traces, and impact in one pass.
- Better merge confidence: risk summaries, quality gates, and affected-test visibility.
- Agent-native workflows: MCP tools and A2A adapter for reliable runtime integration.

## How cgraph Actually Runs

### CLI Execution Path

1. CLI commands enter through `src/cli.ts`.
2. Commands open graph storage through `GraphDB` in `src/storage.ts`.
3. Indexing commands call `indexProject` in `src/indexer.ts`.
4. Query and analysis commands call graph/search/context modules in `src/graph.ts`, `src/search.ts`, and `src/context.ts`.

### MCP Execution Path

1. MCP server starts from `startMcpServer` in `src/mcp.ts`.
2. A `ToolHandler` dispatches each `cgraph_*` method to a specific handler.
3. Handlers resolve or build DB state (`getDb`), then run graph/search/analysis operations.
4. Results are returned as JSON-RPC payloads, with optional compression/CCR retrieval.

### A2A Execution Path

1. A2A server starts from `startA2AServer` in `src/a2a.ts`.
2. HTTP JSON-RPC requests flow through `handleA2ARpcRequest`.
3. Methods `register_agent`, `write_node`, `query_by_agent`, and `read_lineage` are validated and executed against `GraphDB`.
4. Optional controls enforce endpoint auth, registration expiry, and request-rate limits.
5. Trust policy is resolved from config and request context before writes.

## Quick Start

### Install

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

macOS / Linux:

```bash
bash install.sh
```

From source:

```bash
git clone https://github.com/samarth-w/agent_graph.git
cd agent_graph
npm install
npm run build
npm link
```

### First Three Commands

```bash
cgraph index .
cgraph status . --pretty
cgraph smoke --dir demo/finance --target createUser --pretty
```

## Tool Compartments

This project is intentionally organized into operational compartments so teams can adopt it by workflow.

### 1) CLI Navigation Tools

Use these when you need fast repository understanding in terminal workflows.

- `search`, `node`, `files`, `status`
- `callers`, `callees`, `trace`, `impact`, `affected`, `changed`
- `context`, `explore`

Typical loop:

```bash
cgraph search "handleRequest" --pretty
cgraph callers "handleRequest" --pretty
cgraph impact "handleRequest" --mode decision --pretty
```

### 2) Quality and Architecture Tools

Use these for engineering health, refactoring strategy, and architecture compliance.

- `deadcode`, `cycles`, `stats`, `suggest`
- `lint`, `validate`, `dna`, `overview`

Typical loop:

```bash
cgraph dna --pretty
cgraph lint --pretty
cgraph deadcode --pretty
```

### 3) PR and Gate Tools

Use these for release readiness and merge policy enforcement.

- `pr-summary`, `gate`
- `baseline save|list|compare`, `trend`

Typical loop:

```bash
cgraph pr-summary --dir . --format markdown
cgraph gate --dir . --max-cycles 2 --max-dead 50 --min-health 70 --max-risk 60
```

### 4) Reliability and Evaluation Tools

Use these to continuously validate stack behavior and impact quality.

- `smoke`
- `benchmark` (alias: `eval-impact`)

Typical loop:

```bash
cgraph smoke --dir demo/finance --target createUser --pretty
cgraph benchmark demo/impact-eval-cases.sample.json --dir demo/finance --pretty
```

### 5) Runtime Integration Tools

Use these to run cgraph as infrastructure in automated and agentic environments.

- `watch`
- `serve --mcp`
- `serve --a2a`
- `export`

## MCP Tool Compartments

MCP tools are grouped by intent to keep agent usage explicit and predictable.

### Lookup Tier

- `cgraph_search`, `cgraph_node`, `cgraph_files`, `cgraph_status`

### Traversal Tier

- `cgraph_callers`, `cgraph_callees`, `cgraph_trace`, `cgraph_impact`, `cgraph_affected`, `cgraph_changed`

### Context Tier

- `cgraph_context`, `cgraph_explore`, `cgraph_auto_context`, `cgraph_intent_search`

### Quality Tier

- `cgraph_deadcode`, `cgraph_cycles`, `cgraph_stats`, `cgraph_suggest`, `cgraph_validate_plan`, `cgraph_lint`, `cgraph_dna`

### Output Tier

- `cgraph_export`, `cgraph_retrieve_ccr`

## A2A API Workflow

### Start Adapter

```bash
node ./bin/cgraph.js serve --a2a --port 3210
```

### Discover Agent Card

```bash
curl http://localhost:3210/.well-known/agent-card.json
```

### Register Agent (Signed Claim)

Register an agent with an Ed25519-signed claim before trusted writes in `registration_only` mode.

```bash
curl -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"register_agent","params":{"agent_id":"agent.demo","claim":"{\"capabilities\":[\"write_node\"]}","signature":"<base64>","public_key":"<pem>"}}'
```

Optional: revoke a registration.

```bash
curl -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1b","method":"revoke_agent","params":{"agent_id":"agent.demo","reason":"key_rotation"}}'
```

### Write and Query Nodes

```bash
curl -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"2","method":"write_node","params":{"agent_id":"agent.demo","name":"finding","kind":"variable"}}'

curl -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"3","method":"query_by_agent","params":{"agent_id":"agent.demo"}}'

curl -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"4","method":"read_lineage","params":{"name":"finding"}}'
```

### Verified Trust Behavior (`registration_only`)

- Before registration:
  - `write_node` succeeds with `trust_status: unverified`.
  - `query_by_agent` returns `registration_found: false` and no trusted authored nodes.
- Invalid signatures are rejected by `register_agent`.
- After valid Ed25519 registration:
  - `write_node` returns `trust_status: verified`.
  - `query_by_agent` returns `registration_found: true` and registered agent-authored nodes.

These behaviors were validated through live local A2A API tests, including concurrent writes.

### A2A Benchmark Commands

```bash
npm run benchmark:a2a
npm run benchmark:a2a:baseline
npm run benchmark:a2a:compare
npm run benchmark:a2a:gate
npm run benchmark:a2a:gate:local
```

Advanced:

```bash
node ./scripts/benchmark-a2a-multihop.mjs 25 --save reports/a2a-current.json
node ./scripts/benchmark-a2a-multihop.mjs 25 --compare reports/a2a-baseline.json --budget fixtures/a2a-benchmark-budget.json --enforce
```

### A2A API Benchmark (Live Adapter)

Use this when you want endpoint-level latency and throughput numbers from the running A2A server.

1. Start the adapter:

```bash
node ./bin/cgraph.js serve --a2a --port 3210
```

2. Measure discovery endpoint latency:

```bash
curl -s -o /dev/null -w "agent_card_ms=%{time_total}\n" http://localhost:3210/.well-known/agent-card.json
```

3. Measure JSON-RPC write latency (single call):

```bash
curl -s -o /dev/null -w "write_node_ms=%{time_total}\n" \
  -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"b1","method":"write_node","params":{"agent_id":"agent.bench","name":"bench-node","kind":"variable"}}'
```

4. Measure read/query latency:

```bash
curl -s -o /dev/null -w "query_by_agent_ms=%{time_total}\n" \
  -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"b2","method":"query_by_agent","params":{"agent_id":"agent.bench"}}'

curl -s -o /dev/null -w "read_lineage_ms=%{time_total}\n" \
  -X POST http://localhost:3210/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"b3","method":"read_lineage","params":{"name":"bench-node"}}'
```

5. Throughput check (PowerShell, concurrent writes):

```powershell
$jobs = 1..20 | ForEach-Object {
  Start-Job -ScriptBlock {
    param($i)
    $body = "{\"jsonrpc\":\"2.0\",\"id\":\"pw-$i\",\"method\":\"write_node\",\"params\":{\"agent_id\":\"agent.bench\",\"name\":\"bench-$i\",\"kind\":\"variable\"}}"
    curl.exe -s -X POST "http://localhost:3210/rpc" -H "content-type: application/json" -d $body | Out-Null
  } -ArgumentList $_
}
$start = Get-Date
$jobs | Receive-Job -Wait | Out-Null
$elapsed = (Get-Date) - $start
"concurrent_writes=20 elapsed_ms=$([int]$elapsed.TotalMilliseconds)"
$jobs | Remove-Job -Force
```

Notes:

- For trustworthy comparisons, run each measurement multiple times and compare p50/p95.
- In `registration_only` trust mode, register the benchmarking agent first if you want writes counted as verified.

## Architecture

The full architecture is maintained in [architecture.md](architecture.md).

Summary:

- Ingestion: file walking, parsing, symbol and edge extraction.
- Storage: local SQLite graph with files, nodes, and edges.
- Analysis: traversal, impact heuristics, cycles, dead code, and stats.
- Interfaces: CLI commands, MCP tool surface, and A2A JSON-RPC adapter.

## Performance Snapshot

Recent benchmark summary in this workspace:

- Without graph-native flow: 145 calls, 291.5s
- With cgraph: 6 calls, 13.6s
- Net speedup: about 21.4x

Benchmark evidence and reproduction:

- Raw benchmark report used for these headline figures: [demo/demo_benchmark.md](demo/demo_benchmark.md)
- Repro command for agent-workflow benchmark: `node ./scripts/benchmark-agent.mjs demo/finance`
- Repro command for MCP latency/index benchmark: `node ./scripts/benchmark.mjs demo/finance`
- Budget policy for reproducible performance gates: [fixtures/performance-budget.json](fixtures/performance-budget.json) via [scripts/check-performance-budget.mjs](scripts/check-performance-budget.mjs)
- A2A benchmark script and budgets: [scripts/benchmark-a2a-multihop.mjs](scripts/benchmark-a2a-multihop.mjs), [fixtures/a2a-benchmark-budget.json](fixtures/a2a-benchmark-budget.json), [fixtures/a2a-benchmark-budget.local.json](fixtures/a2a-benchmark-budget.local.json)

Why it remains fast:

- Precomputed symbol and relationship graph.
- Bulk adjacency maps instead of repeated scans.
- Incremental sync for low update cost.

## Output Modes

- `--pretty`: readable structured JSON for humans.
- `--format markdown`: report-ready output on commands like `overview`, `pr-summary`, and `gate`.

## Diagnostics and Examples

Repair local graph health with library helpers:

```ts
import { GraphDB, inspectDbHealth, repairDbHealth } from 'cgraph';

const db = await GraphDB.open('./.cgraph/graph.db');
const report = inspectDbHealth(db, process.cwd());
if (!report.ok) {
  const repaired = repairDbHealth(db, process.cwd());
  console.log(`Repaired ${repaired.repaired_count} edge(s).`);
}
```

References:

- [docs/cli-usage.md](docs/cli-usage.md)
- [docs/mcp-workflows.md](docs/mcp-workflows.md)
- [architecture.md](architecture.md)
- [improvements.md](improvements.md)
- [docs/README.md](docs/README.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [examples/diagnostics-repair.ts](examples/diagnostics-repair.ts)
- [fixtures/impact-eval-cases.sample.json](fixtures/impact-eval-cases.sample.json)
- [fixtures/performance-budget.json](fixtures/performance-budget.json)

## Development

```bash
npm install
npm run build
npm test
```

Focused checks:

```bash
npm test -- __tests__/cli.test.ts __tests__/graph.test.ts
node ./bin/cgraph.js smoke --dir demo/finance --target createUser --pretty
node ./bin/cgraph.js benchmark demo/impact-eval-cases.sample.json --dir demo/finance --pretty
```

## Configuration

Optional `.cgraph.json` in project root:

```json
{
  "maxDepth": 5,
  "maxNodes": 100,
  "ignorePaths": ["vendor", "generated"],
  "extensions": [".ts", ".tsx", ".py"],
  "gate": {
    "maxCycles": 2,
    "maxDeadSymbols": 50,
    "minOverallHealth": 70,
    "maxRiskScore": 60,
    "requireAffectedTests": false
  },
  "a2a": {
    "trustMode": "registration_only",
    "maxVerifyLatencyMs": 10,
    "allowVerifyFallback": true,
    "authToken": "change-me",
    "maxBodyBytes": 1048576,
    "registrationTtlMs": 86400000,
    "rateLimitMaxRequests": 120,
    "rateLimitWindowMs": 60000
  }
}
```

## Use as a Library

```ts
import { GraphDB, analyzeImpact } from 'cgraph';

const db = await GraphDB.open('.cgraph/graph.db');
const result = analyzeImpact(db, 'createUser', {
  mode: 'decision',
  maxDepth: 3,
  maxNodes: 50,
  rootDir: process.cwd(),
});
console.log(result);
db.close();
```

## License

AGPL-3.0. See LICENSE.
