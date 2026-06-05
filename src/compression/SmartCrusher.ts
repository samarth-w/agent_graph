export class SmartCrusher {
  /**
   * Crush data to fit token limits.
   * @param ccrId  Optional CCR retrieval ID to embed in truncation sentinels,
   *               so agents know exactly which stored object to retrieve.
   */
  static crush(
    data: unknown,
    mode: 'coding' | 'thinking',
    capacity: 'standard' | 'large',
    ccrId?: string,
  ): unknown {
    let maxLen = mode === 'thinking' ? 25 : 10;
    if (capacity === 'large') maxLen *= 2;

    if (Array.isArray(data)) {
      if (data.length > maxLen) {
        // Lossless-first: if the array contains uniform objects, compact to
        // schema+rows format before resorting to lossy truncation.
        const first = data[0];
        if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
          const schema = Object.keys(first as object);
          if (schema.length >= 2 && schema.length <= 20) {
            const uniform = data.every(
              item =>
                item !== null &&
                typeof item === 'object' &&
                !Array.isArray(item) &&
                schema.every(k => k in (item as object)),
            );
            if (uniform) {
              const compacted = {
                _schema: schema,
                _rows: data.map(item => schema.map(k => (item as Record<string, unknown>)[k])),
              };
              // Only use if it's actually smaller than the truncated form
              if (JSON.stringify(compacted).length < JSON.stringify(data).length * 0.85) {
                return compacted;
              }
            }
          }
        }
        // Lossy truncation — embed CCR retrieval hint when available
        const kept = data.slice(0, maxLen).map(item => this.crush(item, mode, capacity, ccrId));
        const droppedCount = data.length - maxLen;
        const hint = ccrId
          ? ` Retrieve full data via cgraph_retrieve_ccr with id=${ccrId}.`
          : ' Use cgraph_retrieve_ccr if needed.';
        kept.push({ _truncated: `${droppedCount} items omitted for token limits.${hint}` });
        return kept;
      }
      return data.map(item => this.crush(item, mode, capacity, ccrId));
    }

    if (data !== null && typeof data === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as object)) {
        if (value == null) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        if (typeof value === 'string' && value.length === 0) continue;
        result[key] = this.crush(value, mode, capacity, ccrId);
      }
      return result;
    }

    return data;
  }
}
