#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const rootDir = process.argv[2];
const memoryPath = path.join(rootDir, '.cgraph', 'memory.db');
const db = new Database(memoryPath);
db.pragma('journal_mode = WAL');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO memory_access_log(access_id, principal_id, operation, request_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('crash-probe-row', null, 'crash_probe', 'uncommitted', Date.now());
process.stdout.write('READY\n');
setInterval(() => {}, 1_000);
