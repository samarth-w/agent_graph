# Copilot Instructions

## Agent Dropdown Handling

If the selected Copilot agent in the dropdown is **cgraph auto**, follow the routing logic in `.github/agents/cgraph-auto.agent.md`.
Use tiered routing by default (lookup -> graph traversal -> context/edit), and only escalate when lower tiers are insufficient.

## Code Exploration — cgraph MCP Tools

Always use **cgraph MCP tools** for code exploration instead of `read_file` or `grep_search`.

### Tool delegation — pick the cheapest tool that answers the question

**Tier 1 — fast lookup (use first, always)**
Use when you only need location, signature, or a quick list of names:
- `cgraph_search` — find symbols by name/kind; use as the first step before any deeper tool
- `cgraph_node` — inspect one symbol's signature, file location, and immediate call trail
- `cgraph_status` / `cgraph_files` — index health and file list

**Tier 2 — graph traversal (use when Tier 1 is insufficient)**
Use when you need to understand relationships or scope of change:
- `cgraph_callers` — who calls this symbol? (use for "where is X used" questions)
- `cgraph_callees` — what does this symbol call? (use for "what does X depend on")
- `cgraph_impact` — transitive blast radius of a change (use before edits to large/shared symbols)
- `cgraph_trace` — shortest call path between two symbols
- `cgraph_affected` — test files that cover a changed symbol (use before running tests)
- `cgraph_changed` — symbols changed in current git diff

**Tier 3 — full context build (use only for complex multi-file tasks)**
Use when you need comprehensive ranked context for writing, refactoring, or reviewing code:
- `cgraph_context` — retrieve ranked source snippets for a task description (best for editing)
- `cgraph_explore` — natural-language query returning related symbols + code (best for Q&A)
- `cgraph_export` — export call graph as Mermaid or DOT (use only when asked to visualize)

### Decision rules

| Trigger | Tool to call |
|---|---|
| "where is X defined / what file" | `cgraph_search` |
| "what calls X" / "who uses X" | `cgraph_callers` |
| "what does X call" / "X depends on" | `cgraph_callees` |
| "will changing X break anything" | `cgraph_impact` |
| "how does A reach B" | `cgraph_trace` |
| "write / refactor / review code around X" | `cgraph_context` |
| "explain how X works" | `cgraph_explore` |
| "what tests cover this change" | `cgraph_affected` |
| "what changed since last commit" | `cgraph_changed` |

### Escalation rule
Start at Tier 1. Only escalate to a higher tier if the result is empty or insufficient.
Never call `cgraph_context` or `cgraph_explore` for a question that `cgraph_search` + `cgraph_node` can answer.

### When to use read_file instead
- Config files, JSON, YAML, Markdown (non-code assets)
- Exact raw line content needed for a precise string replacement
- cgraph is unavailable or returns an error
