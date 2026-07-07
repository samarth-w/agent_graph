# MCP workflow examples

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
