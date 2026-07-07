import { GraphDB, inspectDbHealth, repairDbHealth } from '../src';

async function main() {
  const db = await GraphDB.open('./.cgraph/graph.db');
  const initial = inspectDbHealth(db, process.cwd());

  console.log(JSON.stringify(initial, null, 2));

  if (!initial.ok) {
    const repaired = repairDbHealth(db, process.cwd());
    console.log(`Repaired ${repaired.repaired_count} orphan edge(s).`);
  }

  db.close();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
