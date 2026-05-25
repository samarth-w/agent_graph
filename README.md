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

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn

### Install from Source

```bash
# Clone the repo
git clone <your-repo-url>
cd cgraph

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

```bash
git clone <your-repo-url>
cd cgraph
npm install
npm run build
npm link          # makes `cgraph` available globally
cd ../your-project
cgraph index      # index the target project
```

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

## Project Structure

```
cgraph/
├── bin/cgraph.js          # CLI entry point
├── src/
│   ├── cli.ts             # CLI commands (commander)
│   ├── config.ts          # Configuration defaults
│   ├── context.ts         # Context builder (search → expand → snippets)
│   ├── frameworks.ts      # Route extraction (Express, Flask, etc.)
│   ├── gitignore.ts       # .gitignore parsing
│   ├── graph.ts           # BFS traversal, callers, callees, impact, trace
│   ├── index.ts           # Public API re-exports
│   ├── indexer.ts         # File walker + parser + edge resolver
│   ├── mcp.ts             # MCP server (JSON-RPC 2.0 over stdio)
│   ├── parser.ts          # Code parser (babel for JS/TS, regex for Python)
│   ├── query-parser.ts    # Search query field extraction
│   ├── search.ts          # Symbol search with filtering
│   ├── storage.ts         # GraphDB (sql.js SQLite)
│   ├── synthesizer.ts     # Dynamic dispatch edge synthesis
│   ├── types.ts           # All type definitions
│   └── watcher.ts         # File watcher with debounced re-index
├── __tests__/             # Test suite (vitest, 105 tests)
├── package.json
└── tsconfig.json
```

## Development

```bash
# Build
npm run build

# Watch mode (rebuild on save)
npm run dev

# Run tests
npm test

# Watch tests
npm run test:watch
```

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

## License

MIT
