# Persistent Memory Configuration

Configure persistent memory in `.cgraph.json` under `memory`:

```json
{
  "memory": {
    "enabled": true,
    "requireEvidenceByDefault": false,
    "defaultRetentionMs": 604800000,
    "allowUnverifiedWrites": false,
    "defaultDenyNamespaceAccess": false
  }
}
```

| Setting | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Enables canonical-memory routing for compatible A2A calls. Set to `false` for reversible compatibility-mode rollback. |
| `requireEvidenceByDefault` | `false` | Makes all queries reject versions without evidence unless a caller changes policy. |
| `defaultRetentionMs` | `604800000` (7 days) | Retention period used by compaction when no command or API override is supplied. |
| `allowUnverifiedWrites` | `false` | Blocks writes from principals registered with the `unverified` trust tier. |
| `defaultDenyNamespaceAccess` | `false` | Requires an explicit `metadata.namespaces` allow-list for every principal when enabled. |

## Recommended production policy

For multi-agent or shared workspaces, set `allowUnverifiedWrites` to `false` and `defaultDenyNamespaceAccess` to `true`. Register each principal with its permitted namespaces. Use a short retention window for ephemeral workflow/session namespaces and a longer one for audited decisions.

## Scheduled maintenance

Run the following from a scheduler appropriate to the deployment environment:

- `cgraph memory expire --dir <workspace>` to apply TTLs.
- `cgraph memory compact --dir <workspace>` to tombstone records after retention.
- `cgraph memory metrics --dir <workspace>` to collect audit and lifecycle counters.

The commands produce JSON and can be consumed by Task Scheduler, cron, or an external monitoring job.
