import path from 'path';
import type { GraphConfig } from './types';

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
