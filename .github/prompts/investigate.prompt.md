---
mode: agent
description: Investigate a symbol — understand its callers, callees, and blast radius before making any edits.
---

Given the symbol `${input:symbol}`:

1. Call `cgraph_search` with name=`${input:symbol}` to locate it (Tier 1).
2. If found, call `cgraph_node` to get its signature and immediate call trail.
3. If the question is about breakage/impact, call `cgraph_impact`. If about callers, call `cgraph_callers`. If about dependencies, call `cgraph_callees`.
4. Only escalate to `cgraph_context` or `cgraph_explore` if you need to write or review code.
5. Summarise: file location, who calls it, what it calls, and estimated blast radius.
