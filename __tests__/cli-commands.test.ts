/**
 * CLI command integration tests — exercises commander action handlers
 * directly via `program.parseAsync`, using `[dir]` positional arguments
 * so no process.cwd() manipulation is needed. Only success paths are
 * exercised (action handlers call process.exit(1) on error, which would
 * kill the test worker).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { program } from '../src/cli';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-cli-cmd-test-'));
}

function captureStdout(): { get: () => string; restore: () => void } {
  let buf = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    buf += chunk.toString();
    return true;
  });
  return { get: () => buf, restore: () => spy.mockRestore() };
}

describe('CLI commands (program.parseAsync)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'demo.ts'), 'export function demo() { return 1; }\n');
    fs.writeFileSync(
      path.join(tempDir, '__tests__', 'demo.test.ts'),
      "import { demo } from '../src/demo';\nexport function invoke() { return demo(); }\n",
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('status reports a non-existent index for an unindexed directory', async () => {
    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'status', tempDir]);
    } finally {
      out.restore();
    }
    const parsed = JSON.parse(out.get());
    expect(parsed.exists).toBe(false);
    expect(parsed.files_count).toBe(0);
  });

  it('index builds a graph database for a directory', async () => {
    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'index', tempDir]);
    } finally {
      out.restore();
    }
    const parsed = JSON.parse(out.get());
    expect(parsed.files_changed).toBeGreaterThanOrEqual(1);
    expect(parsed.nodes_total).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tempDir, '.cgraph'))).toBe(true);
  });

  it('status reports counts after indexing', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'status', tempDir]);
    } finally {
      out.restore();
    }
    const parsed = JSON.parse(out.get());
    expect(parsed.files_count).toBeGreaterThanOrEqual(1);
    expect(parsed.nodes_count).toBeGreaterThanOrEqual(1);
  });

  it('sync performs an incremental index of a directory', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    fs.writeFileSync(path.join(tempDir, 'src', 'extra.ts'), 'export function extra() { return 2; }\n');

    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'sync', tempDir]);
    } finally {
      out.restore();
    }
    const parsed = JSON.parse(out.get());
    expect(parsed.files_changed).toBeGreaterThanOrEqual(1);
  });

  it('index --pretty pretty-prints JSON output', async () => {
    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'index', tempDir, '--pretty']);
    } finally {
      out.restore();
    }
    expect(out.get()).toContain('\n  ');
  });

  it('callers accepts a project root override via --dir', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'callers', 'demo', '--dir', tempDir]);
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.get());
    expect(parsed.symbol).toBe('demo');
    expect(Array.isArray(parsed.callers)).toBe(true);
  });

  it('impact accepts a project root override via --dir', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'impact', 'demo', '--dir', tempDir]);
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.get());
    expect(parsed.target).toBe('demo');
    expect(Array.isArray(parsed.impacted_nodes)).toBe(true);
  });

  it('context builds a payload when given a directory override', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'context', 'demo', '--dir', tempDir]);
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.get());
    expect(parsed.query).toBe('demo');
    expect(Array.isArray(parsed.nodes)).toBe(true);
  });

  it('overview returns a concise project health summary', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'overview', tempDir]);
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.get());
    expect(parsed.root_dir).toBe(tempDir);
    expect(parsed.summary).toBeDefined();
    expect(parsed.health).toBeDefined();
  });

  it('overview supports markdown output mode', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'overview', tempDir, '--format', 'markdown']);
    } finally {
      out.restore();
    }

    const output = out.get();
    expect(output).toContain('# cgraph Overview');
    expect(output).toContain('Overall health');
  });

  it('baseline save and list persist health snapshots', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const saveOut = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'baseline', 'save', 'first', '--dir', tempDir]);
    } finally {
      saveOut.restore();
    }

    const saved = JSON.parse(saveOut.get());
    expect(saved.label).toBe('first');
    expect(saved.snapshot.summary.total_files).toBeGreaterThan(0);

    const listOut = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'baseline', 'list', '--dir', tempDir]);
    } finally {
      listOut.restore();
    }

    const listed = JSON.parse(listOut.get());
    expect(listed.total).toBe(1);
    expect(listed.snapshots[0].label).toBe('first');
  });

  it('baseline save without a label creates unique snapshot labels', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const firstSaveOut = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'baseline', 'save', '--dir', tempDir]);
    } finally {
      firstSaveOut.restore();
    }

    const secondSaveOut = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'baseline', 'save', '--dir', tempDir]);
    } finally {
      secondSaveOut.restore();
    }

    const listOut = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'baseline', 'list', '--dir', tempDir]);
    } finally {
      listOut.restore();
    }

    const listed = JSON.parse(listOut.get());
    expect(listed.total).toBe(2);
    expect(listed.snapshots[0].label).not.toBe(listed.snapshots[1].label);
  });

  it('baseline compare reports an explicit error when labels are missing', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const setupSaveOut = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'baseline', 'save', 'known', '--dir', tempDir]);
    } finally {
      setupSaveOut.restore();
    }

    const out = captureStdout();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null | undefined) => {
      throw new Error(`process.exit unexpectedly called with "${code}"`);
    }) as any);

    await expect(
      program.parseAsync(['node', 'cgraph', 'baseline', 'compare', 'missing', 'known', '--dir', tempDir]),
    ).rejects.toThrow('process.exit unexpectedly called with "1"');

    exitSpy.mockRestore();
    const parsed = JSON.parse(out.get());
    out.restore();
    expect(parsed.error).toContain('Baseline not found: "missing"');
  });

  it('trend compares the latest baseline against the current health snapshot', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const saveOut = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'baseline', 'save', 'base', '--dir', tempDir]);
    } finally {
      saveOut.restore();
    }

    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'trend', '--dir', tempDir]);
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.get());
    expect(parsed.current).toBeDefined();
    expect(parsed.baseline).toBeDefined();
    expect(parsed.deltas).toBeDefined();
  });

  it('pr-summary reports risk, impact, and affected tests for explicit changed files', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync([
        'node',
        'cgraph',
        'pr-summary',
        '--dir',
        tempDir,
        '--files',
        'src/demo.ts',
      ]);
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.get());
    expect(parsed.root_dir).toBe(tempDir);
    expect(parsed.changed_files).toContain('src/demo.ts');
    expect(parsed.total_changed_symbols).toBeGreaterThanOrEqual(1);
    expect(['low', 'medium', 'high']).toContain(parsed.risk_level);
    expect(Array.isArray(parsed.affected_tests)).toBe(true);
  });

  it('pr-summary supports markdown output mode', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync([
        'node',
        'cgraph',
        'pr-summary',
        '--dir',
        tempDir,
        '--files',
        'src/demo.ts',
        '--format',
        'markdown',
      ]);
    } finally {
      out.restore();
    }

    const output = out.get();
    expect(output).toContain('# cgraph PR Summary');
    expect(output).toContain('Risk:');
  });

  it('pr-summary returns a recommendation when no changes are detected', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync(['node', 'cgraph', 'pr-summary', '--dir', tempDir, '--files', '', '--format', 'json']);
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.get());
    expect(parsed.changed_files).toEqual([]);
    expect(parsed.recommendations[0]).toContain('No changed files detected');
  });

  it('gate evaluates thresholds and reports pass/fail checks', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync([
        'node',
        'cgraph',
        'gate',
        '--dir',
        tempDir,
        '--files',
        'src/demo.ts',
        '--max-cycles',
        '100',
        '--max-dead',
        '1000',
        '--min-health',
        '0',
        '--max-risk',
        '100',
      ]);
    } finally {
      out.restore();
    }

    const parsed = JSON.parse(out.get());
    expect(parsed.passed).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.pr_summary).toBeDefined();
  });

  it('gate supports markdown output mode', async () => {
    await program.parseAsync(['node', 'cgraph', 'index', tempDir]);

    const out = captureStdout();
    try {
      await program.parseAsync([
        'node',
        'cgraph',
        'gate',
        '--dir',
        tempDir,
        '--files',
        'src/demo.ts',
        '--max-cycles',
        '100',
        '--max-dead',
        '1000',
        '--min-health',
        '0',
        '--max-risk',
        '100',
        '--format',
        'markdown',
      ]);
    } finally {
      out.restore();
    }

    const output = out.get();
    expect(output).toContain('# cgraph Gate Result');
    expect(output).toContain('Checks');
  });
});
