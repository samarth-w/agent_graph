import type {
  MemoryBackfillResult,
  MemoryCompactionResult,
  MemoryConflict,
  MemoryConflictResult,
  MemoryExpiryResult,
  MemoryMigrationReport,
  MemoryMetrics,
  MemoryAutoResolutionResult,
  MemoryObservability,
  MemoryPrincipalInput,
  MemoryPrincipalSnapshot,
  MemoryQueryInput,
  MemoryQueryResult,
  MemoryRevocationInput,
  MemoryWriteInput,
  MemoryWriteResult,
} from './types';
import { GraphDB } from './storage';
import { NativeMemoryStore } from './memory-store';

export class MemoryService {
  private readonly store: NativeMemoryStore;

  constructor(db: GraphDB) {
    this.store = NativeMemoryStore.open(db);
  }

  static closeForGraphPath(graphPath: string): void {
    NativeMemoryStore.closeForGraphPath(graphPath);
  }

  registerPrincipal(input: MemoryPrincipalInput): MemoryPrincipalSnapshot {
    return this.store.registerPrincipal(input);
  }

  revokePrincipal(input: MemoryRevocationInput): MemoryPrincipalSnapshot {
    return this.store.revokePrincipal(input);
  }

  writeMemory(input: MemoryWriteInput): MemoryWriteResult {
    return this.store.writeMemory(input);
  }

  queryMemory(input: MemoryQueryInput): MemoryQueryResult {
    return this.store.queryMemory(input);
  }

  resolveConflict(input: { leftVersionId: string; rightVersionId: string; conflictType?: string; winnerVersionId?: string }): MemoryConflictResult {
    return this.store.resolveConflict(input);
  }

  expireMemory(input: { nowMs?: number }): MemoryExpiryResult {
    return this.store.expireMemory(input);
  }

  compactMemory(input: { nowMs?: number; retentionMs?: number }): MemoryCompactionResult {
    return this.store.compactMemory(input);
  }

  listConflicts(input: { versionId?: string; includeResolved?: boolean } = {}): MemoryConflict[] {
    return this.store.listConflicts(input);
  }

  backfillLegacyA2AMemory(): MemoryBackfillResult {
    return this.store.backfillLegacyA2AMemory();
  }

  getMigrationReport(): MemoryMigrationReport {
    return this.store.getMigrationReport();
  }

  getMetrics(): MemoryMetrics {
    return this.store.getMetrics();
  }

  recordFeedback(input: { versionId: string; relevance: number; principalId?: string }): void {
    this.store.recordFeedback(input);
  }

  autoResolveConflicts(input: { minimumMargin?: number } = {}): MemoryAutoResolutionResult {
    return this.store.autoResolveConflicts(input);
  }

  recordTrace(input: { operation: string; durationMs: number; status: 'ok' | 'error'; attributes?: Record<string, unknown> }): void {
    this.store.recordTrace(input);
  }

  getObservability(): MemoryObservability {
    return this.store.getObservability();
  }

  consumeRateLimit(bucketKey: string, maxRequests: number, windowMs: number, nowMs: number): boolean {
    return this.store.consumeRateLimit(bucketKey, maxRequests, windowMs, nowMs);
  }
}
