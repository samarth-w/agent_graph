/**
 * Worker thread for parallel file parsing.
 * Receives file content + language, returns parsed symbols/calls/imports.
 */
import { parentPort } from 'worker_threads';
import { parseFile } from './parser';
import type { FingerprintLevel } from './fingerprint';
import { initTreeSitter } from './treesitter';

if (parentPort) {
  // Each worker loads its own copy of the WASM grammars. Kicked off once and
  // shared by every message, since parseFile itself is synchronous.
  let ready: Promise<boolean> | null = null;

  parentPort.on('message', async (msg: {
    id: number; content: string; language: string; relPath: string;
    fingerprintLevel?: FingerprintLevel;
  }) => {
    try {
      if ((msg.fingerprintLevel ?? 4) >= 3) {
        ready ??= initTreeSitter();
        await ready;
      }
      // Fingerprints must be computed here: the AST never crosses the worker
      // boundary, only the serialized ParseResult does.
      const result = parseFile(msg.content, msg.language, msg.relPath, {
        fingerprintLevel: msg.fingerprintLevel,
      });
      parentPort!.postMessage({ id: msg.id, result, error: null });
    } catch (err: any) {
      parentPort!.postMessage({ id: msg.id, result: null, error: err.message });
    }
  });
}
