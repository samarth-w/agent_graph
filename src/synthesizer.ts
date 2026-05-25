/**
 * Callback / dynamic-dispatch synthesizer.
 *
 * Detects patterns that static call-graph analysis misses and
 * creates synthetic edges with provenance metadata:
 *
 * - Callbacks: addEventListener('click', handler), .on('event', fn)
 * - Event emitters: emitter.emit('event') → .on('event', handler)
 * - React: setState/dispatch → component re-render
 * - Promise chains: .then(handler), .catch(handler)
 * - Array HOFs: .map(fn), .filter(fn), .forEach(fn), .reduce(fn)
 */
import type { ParsedCall } from './types';

export interface SynthesizedEdge {
  sourceQName: string;     // enclosing function's qualified name
  targetName: string;      // the callback/handler name
  kind: 'calls';
  provenance: 'heuristic';
  metadata: {
    synthesizedBy: string; // 'callback' | 'event-emitter' | 'react-render' | 'promise' | 'hof'
    via?: string;          // registration function name
    event?: string;        // event name if applicable
    field?: string;        // property name if applicable
  };
  line: number;
}

// Patterns that pass a function reference as an argument
const CALLBACK_RECEIVERS = new Set([
  'addEventListener', 'removeEventListener',
  'on', 'once', 'off', 'addListener', 'removeListener',
  'subscribe', 'unsubscribe',
  'then', 'catch', 'finally',
  'map', 'filter', 'forEach', 'reduce', 'find', 'findIndex',
  'some', 'every', 'flatMap', 'sort',
  'setTimeout', 'setInterval', 'setImmediate',
  'requestAnimationFrame',
  'useEffect', 'useMemo', 'useCallback', 'useLayoutEffect',
]);

// Event emitter patterns
const EMIT_METHODS = new Set(['emit', 'dispatch', 'fire', 'trigger', 'publish', 'send']);

/**
 * Analyze parsed calls and synthesize edges for dynamic dispatch patterns.
 * Returns additional synthetic edges that the static parser missed.
 */
export function synthesizeEdges(
  calls: ParsedCall[],
  relPath: string,
): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = [];

  // Build a map of emitted events → emitter location
  const emittedEvents = new Map<string, { enclosing: string | null; line: number }>();

  for (const call of calls) {
    // Detect event emissions: emitter.emit('eventName')
    if (call.receiver && EMIT_METHODS.has(call.callee)) {
      // The actual event name would need content parsing, but we record the pattern
      emittedEvents.set(`${call.receiver}.${call.callee}`, {
        enclosing: call.enclosingSymbol,
        line: call.line,
      });
    }

    // Detect callback registration patterns
    if (CALLBACK_RECEIVERS.has(call.callee) && call.enclosingSymbol) {
      // For HOF calls like arr.map(handler), arr.filter(fn)
      const isHOF = ['map', 'filter', 'forEach', 'reduce', 'find',
        'findIndex', 'some', 'every', 'flatMap', 'sort'].includes(call.callee);
      const isPromise = ['then', 'catch', 'finally'].includes(call.callee);
      const isEvent = ['addEventListener', 'on', 'once', 'addListener',
        'subscribe'].includes(call.callee);
      const isReact = ['useEffect', 'useMemo', 'useCallback',
        'useLayoutEffect'].includes(call.callee);

      let synthesizedBy: string;
      if (isEvent) synthesizedBy = 'event-emitter';
      else if (isPromise) synthesizedBy = 'promise';
      else if (isReact) synthesizedBy = 'react-render';
      else if (isHOF) synthesizedBy = 'hof';
      else synthesizedBy = 'callback';

      // We don't have the actual callback argument name from ParsedCall,
      // but we record the pattern so edge resolution can attempt to match it
      edges.push({
        sourceQName: call.enclosingSymbol,
        targetName: call.callee, // will be resolved by the indexer
        kind: 'calls',
        provenance: 'heuristic',
        metadata: {
          synthesizedBy,
          via: call.receiver ? `${call.receiver}.${call.callee}` : call.callee,
          event: isEvent ? call.callee : undefined,
        },
        line: call.line,
      });
    }
  }

  return edges;
}

/**
 * Detect React component rendering patterns.
 * When component A renders <B />, A dynamically dispatches to B.
 */
export function detectJsxRendering(
  content: string,
  relPath: string,
  enclosingComponent: string | null,
): SynthesizedEdge[] {
  if (!enclosingComponent) return [];

  const edges: SynthesizedEdge[] = [];
  const jsxComponentRe = /<([A-Z]\w+)[\s/>]/g;
  const lines = content.split('\n');
  let m: RegExpExecArray | null;

  const seen = new Set<string>();
  while ((m = jsxComponentRe.exec(content)) !== null) {
    const componentName = m[1];
    if (seen.has(componentName)) continue;
    seen.add(componentName);

    edges.push({
      sourceQName: `${relPath}::${enclosingComponent}`,
      targetName: componentName,
      kind: 'calls',
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'jsx-render',
        via: componentName,
      },
      line: lineOfOffset(lines, m.index),
    });
  }

  return edges;
}

function lineOfOffset(lines: string[], offset: number): number {
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    pos += lines[i].length + 1;
    if (pos > offset) return i + 1;
  }
  return lines.length;
}
