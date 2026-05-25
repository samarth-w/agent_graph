/**
 * Gitignore Tests — .gitignore parsing and filtering.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildIgnoreFilter } from '../src/gitignore';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-gitignore-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('buildIgnoreFilter', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { cleanupTempDir(tempDir); });

  it('always ignores .git directory', () => {
    const filter = buildIgnoreFilter(tempDir);
    expect(filter.ignores('.git/config')).toBe(true);
    expect(filter.ignores('.git')).toBe(true);
  });

  it('always ignores node_modules', () => {
    const filter = buildIgnoreFilter(tempDir);
    expect(filter.ignores('node_modules/pkg/index.js')).toBe(true);
  });

  it('always ignores .cgraph', () => {
    const filter = buildIgnoreFilter(tempDir);
    expect(filter.ignores('.cgraph/graph.db')).toBe(true);
  });

  it('does not ignore regular source files', () => {
    const filter = buildIgnoreFilter(tempDir);
    expect(filter.ignores('src/index.ts')).toBe(false);
    expect(filter.ignores('lib/utils.js')).toBe(false);
  });

  it('reads .gitignore and applies patterns', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'dist/\n*.log\nbuild/\n');
    const filter = buildIgnoreFilter(tempDir);
    expect(filter.ignores('dist/index.js')).toBe(true);
    expect(filter.ignores('error.log')).toBe(true);
    expect(filter.ignores('build/output.js')).toBe(true);
    expect(filter.ignores('src/index.ts')).toBe(false);
  });

  it('handles negation patterns', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '*.log\n!important.log\n');
    const filter = buildIgnoreFilter(tempDir);
    expect(filter.ignores('error.log')).toBe(true);
    expect(filter.ignores('important.log')).toBe(false);
  });

  it('ignores comments and blank lines in .gitignore', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '# Build output\ndist/\n\n# Logs\n*.log\n');
    const filter = buildIgnoreFilter(tempDir);
    expect(filter.ignores('dist/bundle.js')).toBe(true);
    expect(filter.ignores('src/index.ts')).toBe(false);
  });

  it('uses default ignore paths when no .gitignore exists', () => {
    const filter = buildIgnoreFilter(tempDir);
    // Should still work with defaults
    expect(filter.ignores('node_modules/x')).toBe(true);
    expect(filter.ignores('src/app.ts')).toBe(false);
  });
});
