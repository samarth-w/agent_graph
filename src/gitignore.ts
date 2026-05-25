/**
 * .gitignore integration — reads .gitignore files (root + nested)
 * and builds a filter function that respects gitignore rules.
 *
 * Falls back to hardcoded ignore list if no .gitignore exists.
 */
import fs from 'fs';
import path from 'path';
import { DEFAULT_CONFIG } from './config';

export interface IgnoreFilter {
  /** Returns true if the path should be IGNORED (excluded from indexing). */
  ignores(relPath: string): boolean;
}

/**
 * Build an ignore filter for a project directory.
 * Reads .gitignore at root and any nested .gitignore files (up to depth 3).
 */
export function buildIgnoreFilter(rootDir: string): IgnoreFilter {
  const patterns: { re: RegExp; negate: boolean }[] = [];

  // Always ignore these regardless of .gitignore
  const builtinIgnore = ['.git', '.cgraph', 'node_modules'];
  for (const p of builtinIgnore) {
    patterns.push({ re: new RegExp(`(^|/)${escapeRegex(p)}(/|$)`), negate: false });
  }

  // Read .gitignore files
  const gitignorePaths = findGitignores(rootDir, 3);
  let hasGitignore = false;

  for (const gp of gitignorePaths) {
    try {
      const content = fs.readFileSync(gp, 'utf-8');
      const dir = path.relative(rootDir, path.dirname(gp)).replace(/\\/g, '/');
      const prefix = dir ? dir + '/' : '';
      const parsed = parseGitignore(content, prefix);
      patterns.push(...parsed);
      hasGitignore = true;
    } catch {
      // skip unreadable
    }
  }

  // If no .gitignore found, fall back to hardcoded patterns
  if (!hasGitignore) {
    for (const p of DEFAULT_CONFIG.ignorePaths) {
      patterns.push({ re: new RegExp(`(^|/)${escapeRegex(p)}(/|$)`), negate: false });
    }
  }

  return {
    ignores(relPath: string): boolean {
      const normalized = relPath.replace(/\\/g, '/');
      let ignored = false;
      for (const { re, negate } of patterns) {
        if (re.test(normalized)) {
          ignored = !negate;
        }
      }
      return ignored;
    },
  };
}

function findGitignores(rootDir: string, maxDepth: number): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    const gi = path.join(dir, '.gitignore');
    if (fs.existsSync(gi)) results.push(gi);
    if (depth >= maxDepth) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(path.join(dir, entry.name), depth + 1);
      }
    } catch {
      // skip
    }
  }

  walk(rootDir, 0);
  return results;
}

function parseGitignore(content: string, prefix: string): { re: RegExp; negate: boolean }[] {
  const results: { re: RegExp; negate: boolean }[] = [];

  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }

    // Remove trailing spaces (unless escaped)
    line = line.replace(/(?<!\\)\s+$/, '');

    // Build regex from gitignore pattern
    let pattern = prefix + line;

    // If pattern doesn't contain /, it matches any directory level
    if (!line.includes('/') || (line.endsWith('/') && !line.slice(0, -1).includes('/'))) {
      pattern = '(^|/)' + gitignorePatternToRegex(line.replace(/\/$/, '')) + '(/|$)';
    } else {
      // Anchored pattern
      if (line.startsWith('/')) {
        pattern = '^' + prefix + gitignorePatternToRegex(line.slice(1));
      } else {
        pattern = '(^|/)' + gitignorePatternToRegex(line);
      }
      // Directory-only patterns
      if (line.endsWith('/')) {
        pattern = pattern.replace(/\/$/, '') + '(/|$)';
      }
    }

    try {
      results.push({ re: new RegExp(pattern), negate });
    } catch {
      // invalid regex — skip
    }
  }

  return results;
}

function gitignorePatternToRegex(pattern: string): string {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
