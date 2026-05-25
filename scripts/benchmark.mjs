/**
 * cgraph Benchmark — measures tool call latency and indexing speed.
 *
 * Simulates what Copilot does: sends JSON-RPC messages over stdin
 * to the MCP server and measures response times.
 *
 * Usage:
 *   node scripts/benchmark.mjs [project-dir]
 *   node scripts/benchmark.mjs .              # benchmark current dir
 */
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CGRAPH_BIN = resolve(ROOT, 'bin', 'cgraph.js');
const TARGET_DIR = resolve(process.argv[2] || ROOT);

// ─── JSON-RPC helpers ──────────────────────────────────────────
let msgId = 0;

function makeRequest(method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params });
}

function makeToolCall(name, args = {}) {
  return makeRequest('tools/call', { name, arguments: args });
}

// ─── MCP Server Process ────────────────────────────────────────
class McpClient {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.proc = null;
    this.buffer = '';
    this.pending = new Map(); // id → { resolve, reject, startTime }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(process.execPath, [CGRAPH_BIN, 'serve', '--mcp'], {
        cwd: this.projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString();
        this._drain();
      });

      this.proc.stderr.on('data', () => {}); // suppress

      this.proc.on('error', reject);

      // Send initialize
      const initMsg = makeRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'benchmark', version: '1.0.0' },
      });
      this.proc.stdin.write(initMsg + '\n');

      // Wait for initialize response
      const waitInit = (chunk) => {
        this.buffer += chunk.toString();
        try {
          const lines = this.buffer.split('\n').filter(Boolean);
          for (const line of lines) {
            const msg = JSON.parse(line);
            if (msg.result?.protocolVersion || msg.result?.serverInfo) {
              this.buffer = '';
              this.proc.stdout.removeListener('data', waitInit);
              // Send initialized notification
              this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
              resolve();
              return;
            }
          }
        } catch {}
      };
      this.proc.stdout.on('data', waitInit);

      setTimeout(() => reject(new Error('MCP init timeout')), 15000);
    });
  }

  _drain() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          p.elapsed = Date.now() - p.startTime;
          p.resolve({ ...msg, elapsed: p.elapsed });
        }
      } catch {}
    }
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const req = makeRequest(method, params);
      const id = msgId;
      const startTime = Date.now();
      this.pending.set(id, { resolve, reject, startTime });
      this.proc.stdin.write(req + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout on request ${id}`));
        }
      }, 30000);
    });
  }

  async toolCall(name, args = {}) {
    const req = JSON.stringify({
      jsonrpc: '2.0', id: ++msgId, method: 'tools/call',
      params: { name, arguments: args },
    });
    const id = msgId;
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      this.pending.set(id, { resolve, reject, startTime });
      this.proc.stdin.write(req + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${name}`));
        }
      }, 30000);
    });
  }

  stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
    }
  }
}

// ─── Benchmark runner ──────────────────────────────────────────
const results = [];

function record(name, elapsed, detail = '') {
  results.push({ name, elapsed, detail });
  const bar = '█'.repeat(Math.min(50, Math.ceil(elapsed / 10)));
  const pad = name.padEnd(35);
  const ms = `${elapsed}ms`.padStart(8);
  console.log(`  ${pad} ${ms}  ${bar}  ${detail}`);
}

async function benchToolCall(client, name, toolName, args, expectPattern) {
  const res = await client.toolCall(toolName, args);
  const text = res.result?.content?.[0]?.text || '';
  const ok = !expectPattern || text.includes(expectPattern);
  record(name, res.elapsed, ok ? '✓' : `✗ (missing: ${expectPattern})`);
  return res;
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║         cgraph Benchmark                      ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log(`  Target: ${TARGET_DIR}`);
  console.log('');

  // --- Phase 1: CLI indexing speed ---
  console.log('── Phase 1: Indexing Speed ──────────────────────');

  // Clean index for fresh benchmark
  const dbDir = resolve(TARGET_DIR, '.cgraph');
  if (existsSync(dbDir)) rmSync(dbDir, { recursive: true, force: true });

  const idxStart = Date.now();
  const idxProc = spawn(process.execPath, [CGRAPH_BIN, 'index'], {
    cwd: TARGET_DIR, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const idxOutput = await new Promise((resolve) => {
    let out = '';
    idxProc.stdout.on('data', (d) => out += d);
    idxProc.on('close', () => resolve(out));
  });
  const idxElapsed = Date.now() - idxStart;

  let idxData = {};
  try { idxData = JSON.parse(idxOutput); } catch {}
  record('cold index (from scratch)', idxElapsed,
    `${idxData.files_scanned || '?'} files, ${idxData.nodes_total || '?'} nodes, ${idxData.edges_total || '?'} edges`);

  // Incremental re-index (no changes)
  const syncStart = Date.now();
  const syncProc = spawn(process.execPath, [CGRAPH_BIN, 'sync'], {
    cwd: TARGET_DIR, stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise((resolve) => { syncProc.on('close', resolve); });
  record('warm sync (no changes)', Date.now() - syncStart, '0 files changed');

  // --- Phase 2: MCP tool call latency ---
  console.log('');
  console.log('── Phase 2: MCP Tool Call Latency ───────────────');

  const client = new McpClient(TARGET_DIR);
  const connStart = Date.now();
  await client.start();
  record('MCP server connect', Date.now() - connStart, 'handshake');

  // List tools
  const toolsRes = await client.call('tools/list');
  const toolCount = toolsRes.result?.tools?.length || 0;
  record('tools/list', toolsRes.elapsed, `${toolCount} tools`);

  // Individual tool calls
  await benchToolCall(client, 'cgraph_status', 'cgraph_status', {}, 'Files indexed');
  await benchToolCall(client, 'cgraph_files', 'cgraph_files', {}, 'total');
  await benchToolCall(client, 'cgraph_search (symbol)', 'cgraph_search', { query: 'parse' }, '');
  await benchToolCall(client, 'cgraph_search (kind filter)', 'cgraph_search', { query: 'function', kind: 'function' }, '');
  await benchToolCall(client, 'cgraph_callers', 'cgraph_callers', { symbol: 'traverse' }, '');
  await benchToolCall(client, 'cgraph_callees', 'cgraph_callees', { symbol: 'traverse' }, '');
  await benchToolCall(client, 'cgraph_impact', 'cgraph_impact', { symbol: 'traverse' }, '');
  await benchToolCall(client, 'cgraph_trace', 'cgraph_trace', { from: 'indexProject', to: 'parseFile' }, '');
  await benchToolCall(client, 'cgraph_node', 'cgraph_node', { symbol: 'traverse' }, 'trail');
  await benchToolCall(client, 'cgraph_explore', 'cgraph_explore', { query: 'parser traverse' }, '');
  await benchToolCall(client, 'cgraph_context', 'cgraph_context', { task: 'how does indexing work' }, '');
  await benchToolCall(client, 'cgraph_affected', 'cgraph_affected', { files: 'src/parser.ts' }, '');

  // Agentic intelligence tools
  await benchToolCall(client, 'cgraph_auto_context', 'cgraph_auto_context', { file: 'src/parser.ts' }, 'Auto Context');
  await benchToolCall(client, 'cgraph_intent_search', 'cgraph_intent_search', { query: 'parse file and extract symbols' }, 'Intent Search');
  await benchToolCall(client, 'cgraph_validate_plan', 'cgraph_validate_plan', { symbols: 'parseFile,traverse' }, 'Risk');
  await benchToolCall(client, 'cgraph_dna', 'cgraph_dna', {}, 'Codebase DNA');
  // cgraph_lint skipped (requires .cgraph.json rules)

  // --- Phase 3: Burst (sequential rapid-fire) ---
  console.log('');
  console.log('── Phase 3: Burst (10 sequential calls) ────────');

  const burstStart = Date.now();
  for (let i = 0; i < 10; i++) {
    await client.toolCall('cgraph_search', { query: `test${i}` });
  }
  const burstElapsed = Date.now() - burstStart;
  record('10x cgraph_search burst', burstElapsed, `avg ${Math.round(burstElapsed / 10)}ms/call`);

  // --- Phase 4: Auto-index (fire-and-forget) ---
  console.log('');
  console.log('── Phase 4: Fire-and-Forget (cold start) ───────');

  client.stop();
  // Remove DB to simulate first-time use
  if (existsSync(dbDir)) rmSync(dbDir, { recursive: true, force: true });

  const client2 = new McpClient(TARGET_DIR);
  const coldStart = Date.now();
  await client2.start();
  // First tool call triggers auto-index
  const coldRes = await client2.toolCall('cgraph_status', {});
  record('cold start (auto-index + query)', Date.now() - coldStart,
    coldRes.result?.content?.[0]?.text?.includes('Files indexed') ? '✓ indexed' : '? check');
  client2.stop();

  // --- Summary ---
  console.log('');
  console.log('── Summary ─────────────────────────────────────');

  const toolCalls = results.filter(r =>
    r.name.startsWith('cgraph_') && !r.name.includes('burst') && !r.name.includes('cold'));
  const avgLatency = Math.round(toolCalls.reduce((s, r) => s + r.elapsed, 0) / toolCalls.length);
  const maxLatency = Math.max(...toolCalls.map(r => r.elapsed));
  const minLatency = Math.min(...toolCalls.map(r => r.elapsed));

  console.log(`  Tool calls:     ${toolCalls.length}`);
  console.log(`  Avg latency:    ${avgLatency}ms`);
  console.log(`  Min latency:    ${minLatency}ms`);
  console.log(`  Max latency:    ${maxLatency}ms`);
  console.log(`  Cold index:     ${results.find(r => r.name.includes('cold index'))?.elapsed}ms`);
  console.log(`  Warm sync:      ${results.find(r => r.name.includes('warm sync'))?.elapsed}ms`);
  console.log(`  Burst avg:      ${Math.round(burstElapsed / 10)}ms/call`);
  console.log('');
}

main().catch((err) => {
  console.error('Benchmark failed:', err.message);
  process.exit(1);
});
