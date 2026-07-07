# MCP workflow examples

## A2A memory substrate workflow

Use A2A mode when you need agent-authored lineage and trust-aware provenance, then use MCP tools for code graph decisions.

```text
serve --a2a
register_agent
write_node
read_lineage
query_by_agent
```

Then pivot to MCP for code impact and decision context:

```text
cgraph_impact("targetSymbol")
cgraph_context("refactor task")
```

## Search and context

Use the MCP bridge to resolve the next-best context without leaving the terminal or agent runtime:

```text
cgraph_search("createUser")
cgraph_context("createUser")
cgraph_impact("createUser")
```

## Impact-driven debugging

When a change touches a shared entrypoint, ask for the callers and impact summary before editing:

```text
cgraph_callers("createUser")
cgraph_trace("createUser", "saveUser")
cgraph_affected("src/services/user.ts")
```

## Troubleshooting notes

- Re-index the repository when new symbols or file paths are not showing up.
- Run diagnostics before troubleshooting schema issues.
- Keep benchmark fixtures and budgets in sync when impact heuristics change.
- For A2A regression checks, run baseline then gate:

```text
npm run benchmark:a2a:baseline
npm run benchmark:a2a:gate
```
