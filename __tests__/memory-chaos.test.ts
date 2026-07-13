import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { GraphDB } from '../src/storage';
import { getDbPath } from '../src/config';
import { MemoryService } from '../src/memory';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-memory-chaos-'));
}

function runNodeScript(scriptName: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', scriptName), ...args], { cwd: process.cwd() });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('persistent-memory reliability under load', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({
      memory: {
        defaultDenyNamespaceAccess: true,
      },
    }));
  });

  afterEach(() => {
    MemoryService.closeForGraphPath(getDbPath(tempDir));
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps all writes under concurrent write storm without silent loss', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    service.registerPrincipal({
      principalId: 'agent.storm',
      trustTier: 'trusted',
      metadata: { namespaces: ['workspace'] },
    });

    const writeCount = 64;
    const writes = Array.from({ length: writeCount }, (_, index) => Promise.resolve(service.writeMemory({
      principalId: 'agent.storm',
      namespace: 'workspace',
      subjectKey: 'storm',
      memoryType: 'observation',
      payload: { index },
      memoryId: `storm-${index}`,
      idempotencyKey: `storm-key-${index}`,
      confidence: 0.8,
      evidence: [{ sourceType: 'chaos', sourceRef: String(index) }],
    })));

    const results = await Promise.all(writes);
    expect(results.every(r => r.ok)).toBe(true);

    const queried = service.queryMemory({
      namespace: 'workspace',
      subjectKey: 'storm',
      principalId: 'agent.storm',
      includeSuperseded: true,
      limit: 200,
    });
    expect(queried.total).toBe(writeCount);
  }, 30000);

  it('recovers persisted memory after store restart and maintains idempotency', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    service.registerPrincipal({
      principalId: 'agent.recovery',
      trustTier: 'trusted',
      metadata: { namespaces: ['workspace'] },
    });

    const first = service.writeMemory({
      principalId: 'agent.recovery',
      namespace: 'workspace',
      subjectKey: 'recovery',
      memoryType: 'fact',
      payload: { revision: 1 },
      memoryId: 'stable-memory',
      idempotencyKey: 'stable-idempotency-key',
      confidence: 0.9,
    });
    expect(first.ok).toBe(true);

    MemoryService.closeForGraphPath(getDbPath(tempDir));

    const reopenedDb = await GraphDB.open(getDbPath(tempDir));
    const reopenedService = new MemoryService(reopenedDb);

    reopenedService.registerPrincipal({
      principalId: 'agent.recovery',
      trustTier: 'trusted',
      metadata: { namespaces: ['workspace'] },
    });

    const duplicate = reopenedService.writeMemory({
      principalId: 'agent.recovery',
      namespace: 'workspace',
      subjectKey: 'recovery',
      memoryType: 'fact',
      payload: { revision: 1 },
      memoryId: 'stable-memory',
      idempotencyKey: 'stable-idempotency-key',
      confidence: 0.9,
    });
    expect(duplicate.ok).toBe(true);
    expect(duplicate.versionId).toBe(first.versionId);

    const queried = reopenedService.queryMemory({
      namespace: 'workspace',
      subjectKey: 'recovery',
      principalId: 'agent.recovery',
      includeSuperseded: true,
      limit: 10,
    });
    expect(queried.total).toBe(1);
  });

  it('preserves every successful write across concurrent Node processes', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    new MemoryService(db);
    db.close();
    MemoryService.closeForGraphPath(getDbPath(tempDir));

    const workers = await Promise.all(Array.from({ length: 3 }, (_, workerId) =>
      runNodeScript('memory-write-worker.cjs', [tempDir, String(workerId), '5']),
    ));
    for (const worker of workers) {
      expect(worker.stderr).toBe('');
      expect(worker.code).toBe(0);
      expect(JSON.parse(worker.stdout)).toMatchObject({ ok: true, count: 5 });
    }

    const reopenedDb = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(reopenedDb);
    for (let workerId = 0; workerId < 3; workerId++) {
      const query = service.queryMemory({
        namespace: 'workspace', subjectKey: `worker-${workerId}`, principalId: 'agent.multi-process', limit: 10,
      });
      expect(query.total).toBe(5);
    }
  }, 30000);

  it('rolls back an uncommitted transaction after an abrupt writer termination', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    new MemoryService(db);
    db.close();
    MemoryService.closeForGraphPath(getDbPath(tempDir));

    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'memory-crash-worker.cjs'), tempDir], { cwd: process.cwd() });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', (chunk) => String(chunk).includes('READY') ? resolve() : reject(new Error(`Unexpected worker output: ${chunk}`)));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Crash worker exited before readiness: ${code}`)));
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));

    const reopenedDb = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(reopenedDb);
    expect(service.getMetrics().operations.crash_probe).toBeUndefined();
    const write = service.writeMemory({
      principalId: 'agent.after-crash', namespace: 'workspace', subjectKey: 'recovery', payload: { recovered: true },
    });
    expect(write.ok).toBe(false);
    service.registerPrincipal({ principalId: 'agent.after-crash', trustTier: 'trusted', metadata: { namespaces: ['workspace'] } });
    expect(service.writeMemory({
      principalId: 'agent.after-crash', namespace: 'workspace', subjectKey: 'recovery', payload: { recovered: true },
    }).ok).toBe(true);
  }, 30000);
});
