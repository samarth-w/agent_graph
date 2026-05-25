# Copilot Instructions

## Code Exploration

Always use **cgraph MCP tools** for code exploration instead of `read_file` or `grep_search`.

Preferred tools:
- `cgraph_node` — inspect a symbol's signature, location, and call trail
- `cgraph_callers` / `cgraph_callees` — trace call graphs up/down
- `cgraph_search` — find symbols by name or kind
- `cgraph_explore` — get relevant code context for a natural-language query
- `cgraph_context` — retrieve ranked source code for a task description
- `cgraph_impact` — see all symbols/files affected by a change
- `cgraph_trace` — find the call path between two symbols
- `cgraph_affected` — find test files affected by changes
- `cgraph_status` — check index health
- `cgraph_files` — list indexed files
- `cgraph_export` — export call graph as Mermaid or DOT
- `cgraph_changed` — detect symbols changed in git diff

### When to use cgraph vs read_file
- **Use cgraph** to understand code structure, find callers/callees, trace execution paths, assess impact of changes, and get task-relevant context.
- **Use read_file** only when you need the exact raw text of a file (e.g., config files, non-code assets) or when cgraph is unavailable.
