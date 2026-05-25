# Changelog

## [0.2.0] — 2026-05-25

### New Languages
- **C / C++** parser — functions, structs, classes, enums, namespaces, typedefs, `#include` imports
- **Shell / Bash / Zsh** parser — `function` / `name()` forms, aliases, `source`/`.` imports, command calls
- **PowerShell** parser — functions, filters, classes, enums, `Import-Module`, dot-sourcing

### New Features
- **Adaptive traversal limits** — dynamic depth/node caps based on codebase size and fan-out
- **Export** — `cgraph export` generates Mermaid or DOT call-graph diagrams
- **Git diff mapping** — `cgraph changed` detects symbols changed in `git diff`
- **Test impact** — `cgraph affected` finds test files impacted by changes
- **LRU cache** — MCP tool results cached for repeated queries
- **Auto-configure Copilot** — installers inject `codeGeneration.instructions` so agents prefer cgraph tools
- **Install-and-forget** — auto-configures MCP in VS Code user settings (all workspaces)

### Fixes
- `ftsSearch` uses OR between terms for multi-word queries (was AND — returned empty)
- `--force` re-index purges file data before re-inserting (FK constraint crash)
- Benchmark auto-detects symbols from any target project (was hardcoded to cgraph)
- vitest config scoped to `__tests__/` (excludes demo console.assert tests)
- `install.sh` references `main` branch (was `master`)

### Demo Projects
- **Personal finance tracker** — 17 files, 168 symbols, 1006 edges (TypeScript)
- **C++/Shell demo** — task queue + deploy script with comprehensive edge cases

### Other
- License changed from MIT to AGPL-3.0
- 131 unit tests (up from ~60 in v0.1.0)
- 13 MCP tools (up from 11)
- README rewritten with finance demo benchmarks (5.1x speedup)

## [0.1.0] — 2026-05-24

Initial release.

- JS/TS/JSX/TSX parser (via `@babel/parser`)
- Python parser (regex-based)
- 11 MCP tools (search, context, trace, explore, node, callers, callees, impact, files, status, serve)
- CLI with all commands
- Incremental indexing (mtime+size → hash → skip)
- Import-aware edge resolution
- Framework route extraction (Express, React Router, Next.js, Flask, FastAPI, Django)
- Dynamic dispatch synthesis (callbacks, events, HOFs, promises)
- Role classification (entry, core, utility, leaf, dead)
- Standalone installers for Windows and macOS/Linux
