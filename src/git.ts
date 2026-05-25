/**
 * Git integration — detect changed files from git diff and map them
 * to affected symbols in the code graph.
 */
import { execSync } from 'child_process';
import path from 'path';
import { GraphDB } from './storage';

export interface GitChange {
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface ChangedSymbol {
  name: string;
  qualified_name: string;
  kind: string;
  file: string;
  start_line: number;
  end_line: number;
  change_type: 'in_diff' | 'in_changed_file';
}

/**
 * Get changed files from git diff.
 * @param rootDir  project root
 * @param ref      git ref to diff against (default: HEAD)
 * @param staged   if true, diff staged changes only
 */
export function getChangedFiles(
  rootDir: string,
  opts: { ref?: string; staged?: boolean } = {},
): GitChange[] {
  const ref = opts.ref ?? 'HEAD';
  const args = opts.staged ? ['diff', '--cached', '--name-status'] : ['diff', '--name-status', ref];

  let stdout: string;
  try {
    stdout = execSync(`git ${args.join(' ')}`, {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return [];
  }

  if (!stdout) return [];

  const changes: GitChange[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const statusCode = parts[0].charAt(0);
    const file = parts[parts.length - 1]; // for renames, take the new name

    let status: GitChange['status'];
    switch (statusCode) {
      case 'A': status = 'added'; break;
      case 'M': status = 'modified'; break;
      case 'D': status = 'deleted'; break;
      case 'R': status = 'renamed'; break;
      default: status = 'modified';
    }
    changes.push({ file, status });
  }
  return changes;
}

/**
 * Get changed line ranges from git diff for a specific file.
 */
function getChangedLineRanges(
  rootDir: string,
  file: string,
  ref: string,
): Array<{ start: number; end: number }> {
  let stdout: string;
  try {
    stdout = execSync(`git diff ${ref} -U0 -- "${file}"`, {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return [];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  // Parse @@ -old,count +new,count @@ hunks
  const hunkRe = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
  let match: RegExpExecArray | null;
  while ((match = hunkRe.exec(stdout)) !== null) {
    const start = parseInt(match[1], 10);
    const count = match[2] ? parseInt(match[2], 10) : 1;
    if (count > 0) {
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return ranges;
}

/**
 * Find symbols affected by git changes.
 * Maps changed lines to specific symbols in the code graph.
 */
export function findChangedSymbols(
  db: GraphDB,
  rootDir: string,
  opts: { ref?: string; staged?: boolean } = {},
): ChangedSymbol[] {
  const changes = getChangedFiles(rootDir, opts);
  if (changes.length === 0) return [];

  const ref = opts.ref ?? 'HEAD';
  const symbols: ChangedSymbol[] = [];
  const seen = new Set<string>();

  for (const change of changes) {
    const normFile = change.file.replace(/\\/g, '/');
    const fileRec = db.getFile(normFile);
    if (!fileRec) continue;

    const fileNodes = db.getNodesForFile(fileRec.id);
    if (fileNodes.length === 0) continue;

    if (change.status === 'added' || change.status === 'deleted') {
      // All symbols in the file are affected
      for (const n of fileNodes) {
        const key = n.qualified_name;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({
          name: n.name,
          qualified_name: n.qualified_name,
          kind: n.kind,
          file: normFile,
          start_line: n.start_line,
          end_line: n.end_line,
          change_type: 'in_changed_file',
        });
      }
      continue;
    }

    // For modified files, check which symbols overlap with changed hunks
    const ranges = getChangedLineRanges(rootDir, change.file, ref);
    if (ranges.length === 0) {
      // Fallback: mark all symbols in file
      for (const n of fileNodes) {
        const key = n.qualified_name;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({
          name: n.name,
          qualified_name: n.qualified_name,
          kind: n.kind,
          file: normFile,
          start_line: n.start_line,
          end_line: n.end_line,
          change_type: 'in_changed_file',
        });
      }
      continue;
    }

    for (const n of fileNodes) {
      const key = n.qualified_name;
      if (seen.has(key)) continue;

      const inDiff = ranges.some(r =>
        n.start_line <= r.end && n.end_line >= r.start
      );

      if (inDiff) {
        seen.add(key);
        symbols.push({
          name: n.name,
          qualified_name: n.qualified_name,
          kind: n.kind,
          file: normFile,
          start_line: n.start_line,
          end_line: n.end_line,
          change_type: 'in_diff',
        });
      }
    }
  }

  return symbols;
}
