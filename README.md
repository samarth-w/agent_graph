# cgraph

Local-first code graph CLI that gives GitHub Copilot (and other AI agents) instant access to your codebase structure — callers, callees, impact analysis, trace paths, and more.

**Zero cloud dependencies.** Indexes your code into a local SQLite database and exposes it via MCP (Model Context Protocol) so AI agents can query the graph without scanning thousands of files.

## Features

- **Install and forget** — one-command installer configures everything, auto-indexes on first Copilot query
- **13 MCP tools** — search, context, trace, explore, node, callers, callees, impact, files, status, affected, export, changed
- **5.1x faster agent workflows** — collapses multi-step grep→read chains into single precomputed queries ([benchmarks](#benchmarks))
- **Multi-language** — TypeScript, JavaScript, JSX, TSX, Python, C, C++, Shell/Bash, PowerShell
- **Framework-aware** — Express, React Router, Next.js, Flask, FastAPI, Django route extraction
- **Dynamic dispatch** — synthesizes edges for callbacks, event emitters, HOFs, promise chains
- **Test impact** — `cgraph affected` finds which test files are impacted by your changes
- **Fast** — sql.js (pure WASM SQLite), no native dependencies, no network calls

## Quick Start

### Option A: One-command install (no Node/git required)

For system programmers and devs who don't have Node.js or git — the installer handles everything:

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

**macOS / Linux:**
```bash
bash install.sh
```

This will:
1. Download a portable Node.js (if you don't have one)
2. Fetch cgraph source
3. Build it
4. Add `cgraph` to your PATH
5. Configure VS Code MCP globally (works in **all** workspaces)

**Install and forget.** Open any project in VS Code, ask Copilot — cgraph auto-indexes on first query.

### Option B: Install from source (if you have Node.js)

Requires Node.js >= 18.0.0 and npm.

```bash
# Clone the repo
git clone https://github.com/samarth-w/agent_graph.git
cd agent_graph

# Install dependencies
npm install

# Build TypeScript
npm run build

# (Optional) Link globally so `cgraph` works from anywhere
npm link
```

### Use with GitHub Copilot (VS Code)

The installer automatically configures cgraph in your **VS Code user settings**, so it works in every workspace — no per-project setup needed.

If you installed from source, add this to your VS Code `settings.json` (Ctrl+Shift+P → "Open User Settings (JSON)"):

```json
{
  "mcp": {
    "servers": {
      "cgraph": {
        "command": "node",
        "args": ["<path-to-cgraph>/bin/cgraph.js", "serve", "--mcp"],
        "cwd": "${workspaceFolder}"
      }
    }
  }
}
```

> **Windows note:** If VS Code can't find `node`, use the absolute path:
> ```json
> "command": "C:\\Program Files\\nodejs\\node.exe"
> ```

**That's it.** cgraph auto-indexes on the first Copilot query — no manual `cgraph index` needed. Open any project, ask Copilot a code question, and cgraph tools are available immediately.

### Teammate Setup (Quick Version)

**If they have Node.js:**
```bash
git clone https://github.com/samarth-w/agent_graph.git
cd agent_graph
npm install
npm run build
npm link          # makes `cgraph` available globally
```
Then add the MCP config to their VS Code user settings (see above).

**If they DON'T have Node.js (system programmers, etc.):**
1. Share the repo folder (zip, USB, network drive — whatever works)
2. They run: `powershell -ExecutionPolicy Bypass -File install.ps1` (Windows)
   or `bash install.sh` (macOS/Linux)
3. Done — CLI on PATH + VS Code MCP configured globally. No per-project setup.

## CLI Commands

| Command | Description |
|---------|-------------|
| `index` | Build / update the code graph (incremental) |
| `sync` | Incremental re-index (changed files only) |
| `status` | Show index health (files, nodes, edges, roles) |
| `search <query>` | Search symbols by name (supports `kind:` `lang:` `path:` filters) |
| `callers <symbol>` | Who calls this symbol? (reverse call graph) |
| `callees <symbol>` | What does this symbol call? (forward call graph) |
| `impact <symbol>` | What breaks if this changes? (blast radius) |
| `trace <from> <to>` | Find call path between two symbols |
| `context <task>` | Build relevant code context for a task |
| `explore <query>` | Get source code for related symbols |
| `node <symbol>` | Symbol detail + call trail |
| `query <symbol>` | Look up a symbol with callers/callees |
| `where <symbol>` | Find where a symbol is defined |
| `files` | List indexed files |
| `affected <files>` | Find test files affected by changes |
| `export` | Generate Mermaid or DOT diagrams |
| `changed` | Show symbols changed in git diff |
| `watch` | Watch for file changes and re-index |
| `serve --mcp` | Start MCP server (used by AI agents) |

All commands output JSON. Add `--pretty` for formatted output.

### Options

```
--depth <n>     Max traversal depth (default: 3)
--max-nodes <n> Max nodes to return (default: 50)
--kind <kind>   Filter by symbol kind (function, class, method, etc.)
--file <path>   Filter by file path
```

## MCP Tools

When running as an MCP server (`cgraph serve --mcp`), these tools are available to AI agents:

| Tool | Purpose |
|------|---------|
| `cgraph_search` | Search symbols by name |
| `cgraph_context` | Build code context for a task (**start here**) |
| `cgraph_trace` | Trace call path between symbols |
| `cgraph_explore` | Get source code for related symbols |
| `cgraph_node` | Symbol detail with call trail |
| `cgraph_callers` | Find all callers of a symbol |
| `cgraph_callees` | Find all callees of a symbol |
| `cgraph_impact` | Analyze change impact radius |
| `cgraph_files` | List indexed files |
| `cgraph_status` | Index health check |
| `cgraph_affected` | Find affected test files |
| `cgraph_export` | Generate Mermaid/DOT diagrams |
| `cgraph_changed` | Map git diff to changed symbols |

## Benchmarks

cgraph collapses multi-step agent workflows into single precomputed queries. Benchmarked on a **personal finance tracker** (16 files, 168 symbols, 1006 edges) — a real-world TypeScript app with services, events, reports, and API layers.

### Finance Demo (16 source files)

| Question | Without cgraph | With cgraph | Speedup | Token Savings |
|----------|---------------|-------------|---------|---------------|
| Where is `formatMoney` defined and who calls it? | 7 calls, 14.0s | **1 call**, 2.2s | **6.5x** | 68% ↓ |
| Impact of changing `ApiController`? | 6 calls, 12.0s | **1 call**, 2.2s | **5.6x** | 96% ↓ |
| How does `createApp` reach `formatMoney`? | 4 calls, 8.0s | **1 call**, 2.2s | **3.6x** | 99% ↓ |
| Changed `store.ts` — what tests to run? | 5 calls, 10.0s | **1 call**, 2.2s | **4.6x** | 98% ↓ |
| Explain the architecture | 11 calls, 22.0s | **2 calls**, 4.4s | **5.0x** | — |
| **Totals** | **33 calls, 66s** | **6 calls, 13s** | **5.1x faster** | **17% less context** |

The benchmark auto-detects symbols from any target project. Run it yourself:

```bash
node scripts/benchmark-agent.mjs <your-project-dir>
```

> Benchmark scripts: `scripts/benchmark.mjs`, `scripts/benchmark-agent.mjs`, `scripts/benchmark-compare.mjs`

## Project Structure

```
cgraph/
├── bin/cgraph.js              # CLI entry point
├── src/
│   ├── cli.ts                 # CLI commands (commander)
│   ├── config.ts              # Configuration defaults
│   ├── context.ts             # Context builder (search → expand → snippets)
│   ├── frameworks.ts          # Route extraction (Express, Flask, etc.)
│   ├── gitignore.ts           # .gitignore parsing
│   ├── graph.ts               # BFS traversal, callers, callees, impact, trace
│   ├── index.ts               # Public API re-exports
│   ├── indexer.ts             # File walker + parser + edge resolver
│   ├── mcp.ts                 # MCP server (JSON-RPC 2.0 over stdio)
│   ├── adaptive.ts            # Dynamic traversal limits (codebase size + fan-out)
│   ├── cache.ts               # LRU cache for MCP tool results
│   ├── export.ts              # Mermaid / DOT diagram generation
│   ├── git.ts                 # Git diff → changed symbol mapping
│   ├── parser.ts              # Code parser (babel for JS/TS, regex for Python/C/C++/Shell/PS1)
│   ├── query-parser.ts        # Search query field extraction
│   ├── search.ts              # Symbol search with filtering
│   ├── storage.ts             # GraphDB (sql.js SQLite)
│   ├── synthesizer.ts         # Dynamic dispatch edge synthesis
│   ├── types.ts               # All type definitions
│   └── watcher.ts             # File watcher with debounced re-index
├── __tests__/                 # Test suite (vitest, 131 tests)
│   └── ...
├── scripts/
│   ├── benchmark.mjs          # MCP server latency benchmark
│   ├── benchmark-agent.mjs    # Agent workflow benchmark (with vs without)
│   ├── benchmark-compare.mjs  # Raw efficiency comparison
│   ├── local-install.ps1/.sh  # Build + npm link for dev
│   ├── setup-mcp.ps1          # Auto-configure .vscode/mcp.json
│   └── smoke-test.ps1/.sh     # 19 end-to-end CLI tests
├── demo/
│   ├── finance/               # Personal finance tracker demo (16 files, 168 symbols)
│   └── cpp-shell/             # C++/Shell demo with edge cases (3 files, 59 symbols)
├── python_test/               # Python test project (Flask app, 6 files)
├── install.ps1                # Windows standalone installer
├── install.sh                 # macOS/Linux standalone installer
├── package.json
└── tsconfig.json
```

## Development

```bash
# Build
npm run build

# Watch mode (rebuild on save)
npm run dev

# Run tests (131 unit tests)
npm test

# Watch tests
npm run test:watch

# Smoke test all CLI commands end-to-end
# Windows:
powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
# macOS/Linux:
bash scripts/smoke-test.sh
```

### Scripts

| Script | Purpose |
|--------|---------|
| `install.ps1` / `install.sh` | Standalone installer (downloads Node if needed) |
| `scripts/local-install.ps1` / `.sh` | Build + npm link for dev testing |
| `scripts/smoke-test.ps1` / `.sh` | 19 end-to-end CLI tests |
| `scripts/setup-mcp.ps1` | Auto-configure MCP for a specific project |
| `scripts/benchmark.mjs` | MCP server latency benchmark (11 tools, burst, cold start) |
| `scripts/benchmark-agent.mjs` | Agent workflow benchmark — with vs without cgraph |
| `scripts/benchmark-compare.mjs` | Raw efficiency comparison (grep+read vs cgraph) |

## Architecture

### Key Design Decisions

- **Pure JS / no native deps** — uses `sql.js` (WASM SQLite) instead of `better-sqlite3` so it works without C++ build tools
- **Incremental indexing** — 3-tier: mtime+size → content hash → only re-parses changed files
- **Import-aware edge resolution** — resolves calls through imports with priority: import match > same-file > global name
- **Role classification** — each symbol is tagged as `entry`, `core`, `utility`, `leaf`, or `dead` based on its position in the call graph
- **Bounded traversal** — BFS with `maxDepth` and `maxNodes` caps and cycle detection
- **Token estimation** — context payloads include estimated token count so agents can budget

### Supported Languages

- JavaScript / TypeScript / JSX / TSX (via `@babel/parser`)
- Python (regex-based — functions, classes, methods, imports)
- C / C++ (regex-based — functions, structs, classes, enums, namespaces, typedefs, `#include`)
- Shell / Bash / Zsh (regex-based — functions, aliases, `source`/`.` imports, command calls)
- PowerShell (regex-based — functions, filters, classes, enums, `Import-Module`, dot-sourcing)

### Database

Per-project SQLite database at `.cgraph/graph.db`. Tables:

- **files** — path, mtime, size, content hash, language
- **nodes** — symbols (name, kind, line range, signature, doc, exported flag, role)
- **edges** — call/import/extends/implements relationships between nodes
- **raw_refs** — unresolved call references (used during edge resolution)
- **metadata** — key-value store (last indexed timestamp, etc.)

## Usage as Library

```typescript
import { GraphDB } from 'cgraph/storage';
import { indexProject } from 'cgraph/indexer';
import { findCallers, traverse } from 'cgraph/graph';
import { buildContext } from 'cgraph/context';

const db = await GraphDB.open('.cgraph/graph.db');
await indexProject('.', { db });

const result = findCallers(db, 'handleRequest', { maxDepth: 3 });
console.log(result.nodes);

db.close();
```

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.

If you want to use cgraph in a proprietary/closed-source product, contact the author for a commercial license.
