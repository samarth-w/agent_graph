# Troubleshooting guide

## Graph database is missing

If the CLI reports that no graph database exists, run:

```bash
node ./bin/cgraph.js index .
```

## Unexpected impact results

- Verify that the target symbol exists with `cgraph search <symbol>`.
- Re-run impact evaluation with a decision mode for more conservative results.
- Compare against the sample fixture in [fixtures/impact-eval-cases.sample.json](../fixtures/impact-eval-cases.sample.json).

## Orphan edges or schema anomalies

Use the diagnostics helpers in the library or the CLI to inspect and repair the graph database:

```ts
import { GraphDB, inspectDbHealth, repairDbHealth } from 'cgraph';

const db = await GraphDB.open('./.cgraph/graph.db');
const report = inspectDbHealth(db, process.cwd());
if (!report.ok) {
  repairDbHealth(db, process.cwd());
}
```
