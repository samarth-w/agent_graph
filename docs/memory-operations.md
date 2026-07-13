# Persistent Memory Operational Runbook

## Routine lifecycle

- Run `cgraph memory expire --dir <workspace>` on a schedule appropriate for the workspace TTL policy.
- Run `cgraph memory compact --dir <workspace>` after expiry with a retention window appropriate to audit requirements.
- Review open conflicts before promoting decisions to trusted workflows.
- Collect `cgraph memory metrics --dir <workspace>` in an external monitoring job. It reports operation counts, lifecycle state, open conflicts, and rate-limit bucket count.

## Troubleshooting

- **Write rejected:** register the principal and check it is neither expired nor revoked.
- **Query has no result:** confirm namespace access, evidence requirements, and whether the version is expired or superseded.
- **Unexpected conflict:** inspect both version IDs with `cgraph_memory_conflicts`; record the selected winner with `cgraph_memory_resolve`.
- **Legacy data absent:** run `cgraph_memory_backfill`; repeat safely because imported node markers prevent duplication.

## Benchmark reproduction

Run `npm run verify` before release. It includes the build, coverage suite, standard performance budget, and persistent-memory SLO gate. Run `npm run benchmark:memory` to reproduce the detailed write/query $p50$ and $p95$, compaction time, and mixed-operation throughput report. Treat regressions as release blockers when they exceed the configured project performance budget.
