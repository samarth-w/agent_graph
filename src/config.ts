import fs from 'fs';
import path from 'path';
import type { GraphConfig, LintRule } from './types';

export const CONFIG_FILE = '.cgraph.json';

export const DEFAULT_CONFIG: GraphConfig = {
  maxDepth: 3,
  maxNodes: 50,
  maxSnippets: 20,
  maxSnippetLines: 30,
  ignorePaths: [
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
    '.cgraph',
    '.next',
    '.nuxt',
  ],
  extensions: [
    '.js', '.jsx', '.ts', '.tsx',
    '.mjs', '.cjs',
    '.py', '.pyi',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx',
    '.sh', '.bash', '.zsh',
    '.ps1', '.psm1', '.psd1',
  ],
};

export const DB_DIR = '.cgraph';
export const DB_FILE = 'graph.db';

export function getDbPath(rootDir: string): string {
  return path.join(rootDir, DB_DIR, DB_FILE);
}

const LANG_MAP: Record<string, string> = {
  '.js':  'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts':  'typescript',
  '.tsx': 'tsx',
  '.py':  'python',
  '.pyi': 'python',
  '.c':   'c',
  '.h':   'c',
  '.cpp': 'cpp',
  '.cc':  'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh':  'cpp',
  '.hxx': 'cpp',
  '.sh':  'shell',
  '.bash':'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.psm1':'powershell',
  '.psd1':'powershell',
};

export function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return LANG_MAP[ext] ?? null;
}

export function isJSTS(lang: string): boolean {
  return ['javascript', 'jsx', 'typescript', 'tsx'].includes(lang);
}

/** Rough token estimate: ~4 chars per token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Load project-level config from .cgraph.json in rootDir,
 * merged over DEFAULT_CONFIG. Unknown keys are ignored.
 */
export function loadConfig(rootDir: string): GraphConfig {
  const configPath = path.join(rootDir, CONFIG_FILE);
  if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const merged: GraphConfig = { ...DEFAULT_CONFIG };
    if (typeof raw.maxDepth === 'number') merged.maxDepth = raw.maxDepth;
    if (typeof raw.maxNodes === 'number') merged.maxNodes = raw.maxNodes;
    if (typeof raw.maxSnippets === 'number') merged.maxSnippets = raw.maxSnippets;
    if (typeof raw.maxSnippetLines === 'number') merged.maxSnippetLines = raw.maxSnippetLines;
    if (Array.isArray(raw.ignorePaths)) merged.ignorePaths = raw.ignorePaths.filter((p: unknown) => typeof p === 'string');
    if (Array.isArray(raw.extensions)) merged.extensions = raw.extensions.filter((e: unknown) => typeof e === 'string');
    if (Array.isArray(raw.rules)) {
      const validTypes = new Set(['deny-dependency', 'max-fan-out', 'no-cycles', 'max-file-symbols']);
      const validSeverities = new Set(['error', 'warn']);
      merged.rules = raw.rules.filter((r: any) =>
        r && typeof r === 'object' &&
        validTypes.has(r.type) &&
        validSeverities.has(r.severity),
      ) as LintRule[];
    }
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
