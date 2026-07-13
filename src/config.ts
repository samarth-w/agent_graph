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
    '.inf', '.dsc', '.dec', '.fdf', '.vfr', '.hfr', '.uni',
    '.asl',
    '.bat', '.nasm',
    '.yaml', '.yml',
    '.md',
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
  '.inf': 'inf',
  '.dsc': 'dsc',
  '.dec': 'dec',
  '.fdf': 'fdf',
  '.vfr': 'vfr',
  '.hfr': 'hfr',
  '.uni': 'uni',
  '.asl': 'asl',
  '.bat': 'batch',
  '.nasm':'nasm',
  '.yaml':'yaml',
  '.yml': 'yaml',
  '.md':  'markdown',
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
    if (raw.gate && typeof raw.gate === 'object') {
      const gate: Record<string, unknown> = raw.gate;
      merged.gate = {};
      if (typeof gate.maxCycles === 'number') merged.gate.maxCycles = gate.maxCycles;
      if (typeof gate.maxDeadSymbols === 'number') merged.gate.maxDeadSymbols = gate.maxDeadSymbols;
      if (typeof gate.minOverallHealth === 'number') merged.gate.minOverallHealth = gate.minOverallHealth;
      if (typeof gate.maxRiskScore === 'number') merged.gate.maxRiskScore = gate.maxRiskScore;
      if (typeof gate.requireAffectedTests === 'boolean') merged.gate.requireAffectedTests = gate.requireAffectedTests;
    }
    if (raw.a2a && typeof raw.a2a === 'object') {
      const a2a: Record<string, unknown> = raw.a2a;
      merged.a2a = {};
      if (a2a.trustMode === 'registration_only' || a2a.trustMode === 'per_write') {
        merged.a2a.trustMode = a2a.trustMode;
      }
      if (typeof a2a.maxVerifyLatencyMs === 'number') merged.a2a.maxVerifyLatencyMs = a2a.maxVerifyLatencyMs;
      if (typeof a2a.allowVerifyFallback === 'boolean') merged.a2a.allowVerifyFallback = a2a.allowVerifyFallback;
      if (typeof a2a.authToken === 'string' && a2a.authToken.length > 0) merged.a2a.authToken = a2a.authToken;
      if (typeof a2a.maxBodyBytes === 'number') merged.a2a.maxBodyBytes = a2a.maxBodyBytes;
      if (typeof a2a.registrationTtlMs === 'number') merged.a2a.registrationTtlMs = a2a.registrationTtlMs;
      if (typeof a2a.rateLimitMaxRequests === 'number') merged.a2a.rateLimitMaxRequests = a2a.rateLimitMaxRequests;
      if (typeof a2a.rateLimitWindowMs === 'number') merged.a2a.rateLimitWindowMs = a2a.rateLimitWindowMs;
    }
    if (raw.memory && typeof raw.memory === 'object') {
      const memory: Record<string, unknown> = raw.memory;
      merged.memory = {};
      if (typeof memory.enabled === 'boolean') merged.memory.enabled = memory.enabled;
      if (typeof memory.requireEvidenceByDefault === 'boolean') merged.memory.requireEvidenceByDefault = memory.requireEvidenceByDefault;
      if (typeof memory.defaultRetentionMs === 'number' && memory.defaultRetentionMs > 0) {
        merged.memory.defaultRetentionMs = memory.defaultRetentionMs;
      }
      if (typeof memory.allowUnverifiedWrites === 'boolean') merged.memory.allowUnverifiedWrites = memory.allowUnverifiedWrites;
      if (typeof memory.defaultDenyNamespaceAccess === 'boolean') merged.memory.defaultDenyNamespaceAccess = memory.defaultDenyNamespaceAccess;
      if (typeof memory.hybridRankingEnabled === 'boolean') merged.memory.hybridRankingEnabled = memory.hybridRankingEnabled;
      if (typeof memory.autoResolveConflicts === 'boolean') merged.memory.autoResolveConflicts = memory.autoResolveConflicts;
      if (typeof memory.autoResolveMinimumMargin === 'number' && memory.autoResolveMinimumMargin >= 0) {
        merged.memory.autoResolveMinimumMargin = memory.autoResolveMinimumMargin;
      }
      if (memory.replication && typeof memory.replication === 'object') {
        const replication = memory.replication as Record<string, unknown>;
        merged.memory.replication = {};
        if (typeof replication.enabled === 'boolean') merged.memory.replication.enabled = replication.enabled;
        if (typeof replication.peerId === 'string') merged.memory.replication.peerId = replication.peerId;
        if (Array.isArray(replication.peers)) merged.memory.replication.peers = replication.peers.filter((peer): peer is string => typeof peer === 'string' && peer.length > 0);
        if (typeof replication.authToken === 'string') merged.memory.replication.authToken = replication.authToken;
        if (typeof replication.timeoutMs === 'number' && replication.timeoutMs > 0) merged.memory.replication.timeoutMs = replication.timeoutMs;
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
