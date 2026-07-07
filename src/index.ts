/**
 * Library entry — re-exports for programmatic use.
 */
export { GraphDB } from './storage';
export { parseFile } from './parser';
export { indexProject } from './indexer';
export { traverse, findCallers, findCallees, analyzeImpact, evaluateImpactCases, findSymbol, tracePath, getNodeDetail, getIndexedFiles, findAffected } from './graph';
export { summarizeGraph } from './graph/summary';
export { loadImpactEvaluationCasesFromFile, evaluateImpactCasesFromFile } from './cli';
export { inspectDbHealth, repairDbHealth } from './cli/diagnostics';
export { loadPerformanceBudget, checkPerformanceBudget } from './performance';
export { searchSymbols } from './search';
export { parseQuery } from './query-parser';
export { buildContext, explore } from './context';
export { startMcpServer } from './mcp';
export { getAgentCard, handleA2ARpcRequest, startA2AServer } from './a2a';
export { FileWatcher } from './watcher';
export { extractRoutes } from './frameworks';
export { synthesizeEdges } from './synthesizer';
export { buildIgnoreFilter } from './gitignore';
export { getDbPath, DEFAULT_CONFIG, detectLanguage } from './config';
export * from './types';
