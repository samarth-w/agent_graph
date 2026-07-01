/**
 * Library entry — re-exports for programmatic use.
 */
export { GraphDB } from './storage';
export { parseFile } from './parser';
export { indexProject } from './indexer';
export { traverse, findCallers, findCallees, analyzeImpact, evaluateImpactCases, findSymbol, tracePath, getNodeDetail, getIndexedFiles, findAffected } from './graph';
export { loadImpactEvaluationCasesFromFile, evaluateImpactCasesFromFile } from './cli';
export { searchSymbols } from './search';
export { parseQuery } from './query-parser';
export { buildContext, explore } from './context';
export { startMcpServer } from './mcp';
export { FileWatcher } from './watcher';
export { extractRoutes } from './frameworks';
export { synthesizeEdges } from './synthesizer';
export { buildIgnoreFilter } from './gitignore';
export { getDbPath, DEFAULT_CONFIG, detectLanguage } from './config';
export * from './types';
