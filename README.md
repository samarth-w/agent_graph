# cgraph

Local-first code graph CLI that gives GitHub Copilot (and other AI agents) instant access to your codebase structure — callers, callees, impact analysis, trace paths, and more.

**Zero cloud dependencies.** Indexes your code into a local SQLite database and exposes it via MCP (Model Context Protocol) so AI agents can query the graph without scanning thousands of files.

## Features

- **11 MCP tools** — search, context, trace, explore, node, callers, callees, impact, files, status, affected
- **Multi-language** — TypeScript, JavaScript, JSX, TSX, Python
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
# After repo is hosted, this will work as a one-liner:
# curl -fsSL https://raw.githubusercontent.com/samarth-w/agent_graph/master/install.sh | bash

# For now, from a shared copy:
bash install.sh
```

This will:
1. Download a portable Node.js (if you don't have one)
2. Fetch cgraph source
3. Build it
4. Add `cgraph` to your PATH

**That's it.** No npm, no git, no Node.js knowledge needed.

### Option B: Install from source (if you have Node.js)

### Prerequisites

- Node.js >= 18.0.0
- npm

### Install from Source

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

### Index Your Project

```bash
# From your project directory
cgraph index

# Check what was indexed
cgraph status
```

### Use with GitHub Copilot (VS Code)

Create `.vscode/mcp.json` in the project you want to analyze:

```json
{
  "servers": {
    "cgraph": {
      "command": "node",
      "args": ["<path-to-cgraph>/bin/cgraph.js", "serve", "--mcp"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

> **Windows note:** If VS Code can't find `node`, use the absolute path:
> ```json
> "command": "C:\\Program Files\\nodejs\\node.exe"
> ```

Restart VS Code. The 11 cgraph tools will appear in Copilot Chat automatically.

### Teammate Setup (Quick Version)

**If they have Node.js:**
```bash
git clone https://github.com/samarth-w/agent_graph.git
cd agent_graph
npm install
npm run build
npm link          # makes `cgraph` available globally
cd ../your-project
cgraph index      # index the target project
```

**If they DON'T have Node.js (system programmers, etc.):**
1. Share the repo folder (zip, USB, network drive — whatever works)
2. They run: `powershell -ExecutionPolicy Bypass -File install.ps1` (Windows)
   or `bash install.sh` (macOS/Linux)
3. Done — `cgraph` is on their PATH

Then add the `.vscode/mcp.json` above to the target project. Done.

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

## Benchmarks

cgraph collapses multi-step agent workflows into single precomputed queries. Benchmarked on a **tic-tac-toe demo** (8 files, 49 nodes, 110 edges) and **cgraph's own codebase** (23 files, 272 nodes, 416 edges).

### Tic-Tac-Toe Demo (live benchmark)

| Task | Without cgraph | With cgraph | Speedup |
|------|---------------|-------------|----------|
| Refactor `minimax` — what breaks? | 5 tool calls | **1 call** (`impact`) | 5x fewer calls |
| How does user input reach the board? | 4 tool calls, found 4 functions | **1 call** (`callees`), found **27 functions** | 4x fewer calls, 6.7x more complete |
| Changed `checkWinner` — what's affected? | 2 calls + manual tracing, found ~5 symbols | **1 call** (`impact`), found **12 symbols** across 4 files | 2.4x more coverage |
| **Totals** | **11 calls**, partial results | **3 calls**, complete results | **3.7x fewer calls** |

### Agent Workflow Benchmark (cgraph codebase)

| Question | Calls | Agent Time | Token Savings |
|----------|-------|------------|---------------|
| Where is `parseFile` defined and who calls it? | 4 → 1 | 8.0s → 2.2s | 41% ↓ |
| Impact of changing `GraphDB.open`? | 10 → 1 | 20.0s → 2.2s | 92% ↓ |
| How does CLI reach the database? | 7 → 1 | 14.0s → 2.2s | 100% ↓ |
| Changed `config.ts` — what tests to run? | 5 → 1 | 10.0s → 2.2s | 99% ↓ |
| Explain the architecture | 11 → 2 | 22.0s → 4.4s | 36% ↓ |
| **Totals** | **37 → 6** | **74s → 13s (5.7x faster)** | **75% less context** |

> Full benchmark details: [demo/demo_benchmark.md](demo/demo_benchmark.md)
>
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
│   ├── parser.ts              # Code parser (babel for JS/TS, regex for Python)
│   ├── query-parser.ts        # Search query field extraction
│   ├── search.ts              # Symbol search with filtering
│   ├── storage.ts             # GraphDB (sql.js SQLite)
│   ├── synthesizer.ts         # Dynamic dispatch edge synthesis
│   ├── types.ts               # All type definitions
│   └── watcher.ts             # File watcher with debounced re-index
├── __tests__/                 # Test suite (vitest, 105 tests)
│   ├── frameworks.test.ts
│   ├── gitignore.test.ts
│   ├── graph.test.ts
│   ├── mcp.test.ts
│   ├── parser.test.ts
│   ├── query-parser.test.ts
│   ├── storage.test.ts
│   └── synthesizer.test.ts
├── scripts/
│   ├── benchmark.mjs          # MCP server latency benchmark
│   ├── benchmark-agent.mjs    # Agent workflow benchmark (with vs without)
│   ├── benchmark-compare.mjs  # Raw efficiency comparison
│   ├── local-install.ps1/.sh  # Build + npm link for dev
│   ├── setup-mcp.ps1          # Auto-configure .vscode/mcp.json
│   └── smoke-test.ps1/.sh     # 19 end-to-end CLI tests
├── demo/
│   ├── demo_benchmark.md      # Full benchmark results
│   └── tictactoe/src/         # Tic-tac-toe demo project (8 files)
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

# Run tests (105 unit tests)
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
| `scripts/setup-mcp.ps1` | Auto-configure `.vscode/mcp.json` for a project |
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
- Python (regex-based, covers functions, classes, methods, imports)

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

MIT
