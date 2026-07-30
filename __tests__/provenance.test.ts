import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDB } from '../src/storage';
import { getDbPath } from '../src/config';
import { MemoryService } from '../src/memory';
import { indexProject } from '../src/indexer';
import { syncProvenance, normalizeSymbolBody } from '../src/provenance';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-provenance-test-'));
}

const SOURCE_V1 = `export function computeTax(amount) {
  const rate = 0.2;
  return amount * rate;
}

export function buildInvoice(amount) {
  const tax = computeTax(amount);
  return { amount, tax };
}
`;

// Same semantics as V1, only reformatted / re-indented.
const SOURCE_FORMATTED = `export function computeTax(amount) {

      const rate = 0.2;

      return amount    *    rate;
}

export function buildInvoice(amount) {

      const tax = computeTax(amount);

      return { amount, tax };
}
`;

// computeTax body genuinely changes; buildInvoice text is untouched.
const SOURCE_V2 = `export function computeTax(amount) {
  const rate = 0.35;
  return amount * rate * 1.05;
}

export function buildInvoice(amount) {
  const tax = computeTax(amount);
  return { amount, tax };
}
`;

describe('symbol-level provenance', () => {
  let tempDir: string;
  let sourceFile: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    sourceFile = path.join(tempDir, 'src', 'billing.js');
    fs.writeFileSync(sourceFile, SOURCE_V1);
  });

  afterEach(() => {
    MemoryService.closeForGraphPath(getDbPath(tempDir));
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('ignores formatting-only edits but invalidates on semantic change of a dependency', async () => {
    await indexProject(tempDir, { force: true });

    let db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    service.registerPrincipal({ principalId: 'agent.prov', trustTier: 'trusted' });

    const invoiceNode = db.findNodesByName('buildInvoice')[0];
    expect(invoiceNode).toBeDefined();

    const written = service.writeMemory({
      principalId: 'agent.prov',
      namespace: 'project',
      subjectKey: 'billing',
      memoryType: 'fact',
      payload: { note: 'buildInvoice returns amount plus tax' },
      confidence: 0.9,
      evidence: [{
        sourceType: 'symbol',
        sourceRef: invoiceNode.qualified_name,
        excerptHash: 'excerpt-1',
      }],
    });
    expect(written.ok).toBe(true);

    // First sync establishes the baseline: everything is new, nothing is stale.
    const baseline = syncProvenance(db, tempDir, { service });
    expect(baseline.scannedSymbols).toBeGreaterThan(0);
    expect(baseline.changedSymbols).toEqual([]);
    expect(baseline.invalidatedCount).toBe(0);
    db.close();

    // --- Formatting-only edit must NOT invalidate memory ---
    fs.writeFileSync(sourceFile, SOURCE_FORMATTED);
    await indexProject(tempDir, { force: true });
    db = await GraphDB.open(getDbPath(tempDir));
    const afterFormat = syncProvenance(db, tempDir, { service: new MemoryService(db) });
    expect(afterFormat.changedSymbols).toEqual([]);
    expect(afterFormat.invalidatedCount).toBe(0);
    db.close();

    // --- Semantic edit to computeTax must invalidate the buildInvoice memory ---
    fs.writeFileSync(sourceFile, SOURCE_V2);
    await indexProject(tempDir, { force: true });
    db = await GraphDB.open(getDbPath(tempDir));
    const service3 = new MemoryService(db);
    const afterChange = syncProvenance(db, tempDir, { service: service3 });

    expect(afterChange.changedSymbols.some((s) => s.includes('computeTax'))).toBe(true);
    // buildInvoice text never changed, but it depends on computeTax.
    expect(afterChange.impactedSymbols.some((s) => s.qualifiedName === invoiceNode.qualified_name)).toBe(true);
    expect(afterChange.invalidatedCount).toBeGreaterThan(0);
    expect(afterChange.invalidatedVersionIds).toContain(written.versionId);

    const queried = service3.queryMemory({
      namespace: 'project',
      subjectKey: 'billing',
    });
    expect(queried.results[0].status).toBe('stale');
    expect(queried.results[0].policyWarnings).toContain('stale');
    db.close();
  });

  it('dryRun reports impact without mutating memory or the baseline', async () => {
    await indexProject(tempDir, { force: true });
    let db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    service.registerPrincipal({ principalId: 'agent.dry', trustTier: 'trusted' });

    const node = db.findNodesByName('computeTax')[0];
    const written = service.writeMemory({
      principalId: 'agent.dry',
      namespace: 'project',
      subjectKey: 'billing-dry',
      memoryType: 'fact',
      payload: { note: 'tax rate is 0.2' },
      confidence: 0.9,
      evidence: [{ sourceType: 'symbol', sourceRef: node.qualified_name, excerptHash: 'e' }],
    });
    syncProvenance(db, tempDir, { service });
    db.close();

    fs.writeFileSync(sourceFile, SOURCE_V2);
    await indexProject(tempDir, { force: true });
    db = await GraphDB.open(getDbPath(tempDir));
    const service2 = new MemoryService(db);

    const dry = syncProvenance(db, tempDir, { service: service2, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.changedSymbols.length).toBeGreaterThan(0);
    expect(dry.invalidatedCount).toBe(0);

    const stillActive = service2.queryMemory({
      namespace: 'project',
      subjectKey: 'billing-dry',
    });
    expect(stillActive.results[0].versionId).toBe(written.versionId);
    expect(stillActive.results[0].status).toBe('active');

    // Baseline untouched, so a real sync still detects the same change.
    const real = syncProvenance(db, tempDir, { service: service2 });
    expect(real.changedSymbols).toEqual(dry.changedSymbols);
    expect(real.invalidatedCount).toBeGreaterThan(0);
    db.close();
  });

  it('normalizes whitespace so re-indentation is not a semantic change', () => {
    expect(normalizeSymbolBody(['  a  =  1 ', '', '   b=2'])).toBe('a = 1\nb=2');
  });

  // These three cases are the crux of the contribution: a whitespace-only
  // fingerprint (the prior behaviour) invalidates on all of them, and only the
  // last one is a real semantic change.
  describe('end-to-end invalidation precision', () => {
    async function syncAfterEdit(source: string): Promise<ReturnType<typeof syncProvenance>> {
      fs.writeFileSync(sourceFile, source);
      await indexProject(tempDir, { force: true });
      const db = await GraphDB.open(getDbPath(tempDir));
      const result = syncProvenance(db, tempDir, { service: new MemoryService(db) });
      db.close();
      return result;
    }

    beforeEach(async () => {
      await indexProject(tempDir, { force: true });
      const db = await GraphDB.open(getDbPath(tempDir));
      syncProvenance(db, tempDir, { service: new MemoryService(db) });
      db.close();
    });

    it('does not invalidate on a comment-only edit', async () => {
      const commented = `export function computeTax(amount) {
  // Rate is mandated by the 2024 schedule, see finance/RATES.md.
  const rate = 0.2;
  return amount * rate;
}

/** Builds an invoice line. */
export function buildInvoice(amount) {
  const tax = computeTax(amount); // includes tax
  return { amount, tax };
}
`;
      const result = await syncAfterEdit(commented);
      expect(result.changedSymbols).toEqual([]);
      expect(result.invalidatedCount).toBe(0);
    });

    it('does not invalidate when a local variable is renamed', async () => {
      const renamed = `export function computeTax(amount) {
  const taxRate = 0.2;
  return amount * taxRate;
}

export function buildInvoice(amount) {
  const computedTax = computeTax(amount);
  return { amount, tax: computedTax };
}
`;
      const result = await syncAfterEdit(renamed);
      expect(result.changedSymbols).toEqual([]);
      expect(result.invalidatedCount).toBe(0);
    });

    it('does invalidate when a literal changes', async () => {
      const result = await syncAfterEdit(SOURCE_V2);
      expect(result.changedSymbols.some((s) => s.includes('computeTax'))).toBe(true);
    });
  });
});
