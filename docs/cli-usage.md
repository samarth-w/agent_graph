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
