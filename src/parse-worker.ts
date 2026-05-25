/**
 * Worker thread for parallel file parsing.
 * Receives file content + language, returns parsed symbols/calls/imports.
 */
import { parentPort } from 'worker_threads';
import { parseFile } from './parser';

if (parentPort) {
  parentPort.on('message', (msg: { id: number; content: string; language: string; relPath: string }) => {
    try {
      const result = parseFile(msg.content, msg.language, msg.relPath);
      parentPort!.postMessage({ id: msg.id, result, error: null });
    } catch (err: any) {
      parentPort!.postMessage({ id: msg.id, result: null, error: err.message });
    }
  });
}
