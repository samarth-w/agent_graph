import type { MemoryReplicationConfig, MemoryReplicationResult, MemoryWriteInput } from './types';

/**
 * Best-effort anti-entropy replication over authenticated A2A RPC peers.
 * A peer applies the exact idempotent version once; callers retain the local
 * durable write even while an unavailable peer is retried on a later write.
 */
export async function replicateMemoryWrite(
  config: MemoryReplicationConfig | undefined,
  input: MemoryWriteInput,
): Promise<MemoryReplicationResult> {
  const peers = config?.enabled ? (config.peers ?? []) : [];
  if (peers.length === 0) return { attempted: 0, acknowledged: 0, failedPeers: [] };
  const timeoutMs = config?.timeoutMs ?? 3_000;
  const outcomes = await Promise.all(peers.map(async (peer) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${peer.replace(/\/$/, '')}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config?.authToken ? { authorization: `Bearer ${config.authToken}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: `replicate:${input.versionId ?? input.idempotencyKey ?? input.memoryId ?? 'new'}`,
          method: 'memory.replication.apply',
          params: {
            principal_id: input.principalId,
            namespace: input.namespace,
            subject_key: input.subjectKey,
            memory_type: input.memoryType,
            payload: input.payload,
            confidence: input.confidence,
            evidence: input.evidence,
            valid_from_ms: input.validFromMs,
            valid_to_ms: input.validToMs,
            memory_id: input.memoryId,
            version_id: input.versionId,
            idempotency_key: input.idempotencyKey,
            origin_peer_id: config?.peerId,
          },
        }),
        signal: controller.signal,
      });
      const body = await response.json() as { error?: unknown; result?: { ok?: boolean } };
      return !body.error && body.result?.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }));
  const failedPeers = peers.filter((_, index) => !outcomes[index]);
  return { attempted: peers.length, acknowledged: peers.length - failedPeers.length, failedPeers };
}
