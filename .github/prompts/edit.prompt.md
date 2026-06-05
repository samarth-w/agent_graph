---
mode: agent
description: Edit or refactor code — gather ranked context then implement the change.
---

Task: `${input:task}`

1. Call `cgraph_search` to locate the primary symbol(s) involved (Tier 1).
2. Call `cgraph_impact` to understand the blast radius — stop if the change is too risky without further discussion.
3. Call `cgraph_context` with the task description to retrieve ranked source snippets (Tier 3).
4. Implement the change using the retrieved context. Prefer minimal, targeted edits.
5. Call `cgraph_affected` to identify test files that cover the changed symbols, and run them.
