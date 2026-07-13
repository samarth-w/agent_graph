# Advanced Persistent Memory

## Peer replication

Set `memory.replication.enabled` and provide authenticated A2A peer base URLs to replicate successful idempotent writes:

```json
{
  "memory": {
    "replication": {
      "enabled": true,
      "peerId": "workspace-a",
      "peers": ["https://memory-peer.example"],
      "authToken": "shared-peer-token",
      "timeoutMs": 3000
    }
  }
}
```

Replication uses the authenticated `memory.replication.apply` A2A method and version/idempotency identifiers, so peer delivery is safe to retry. It is an anti-entropy replication primitive, not a substitute for a deployed consensus protocol: production multi-region consensus still requires an external quorum/leader service and peer identity management.

## Hybrid and adaptive retrieval

Set `hybridRankingEnabled` to combine the existing explainable trust/recency/confidence/evidence score with deterministic token similarity and stored relevance feedback. Submit feedback with `cgraph_memory_feedback` or `memory.feedback`; use `semanticQuery`/`semantic_query` on queries.

## Automated reconciliation

Set `autoResolveConflicts` to resolve an open contradiction only when the deterministic trust, confidence, and evidence rank advantage exceeds `autoResolveMinimumMargin`. Ambiguous conflicts remain open for a human or agent decision. Invoke `cgraph_memory_auto_resolve` or `memory.auto_resolve` for an explicit pass.

## Sustained workload evaluation

Run `npm run build` then `npm run benchmark:memory:soak -- --duration-ms 60000 --write-rate 50 --read-rate 100`. Supported local faults are `restart` and `revocation`, for example `--fault restart`. The JSON report includes throughput, error rate, p50/p95/p99 cycle latency, restarts, and current lifecycle metrics.