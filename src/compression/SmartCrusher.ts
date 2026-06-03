export class SmartCrusher {
  static crush(data: unknown, mode: 'coding' | 'thinking', capacity: 'standard' | 'large'): unknown {
    let maxLen = mode === 'thinking' ? 25 : 10;
    if (capacity === 'large') maxLen *= 2;

    if (Array.isArray(data)) {
      if (data.length > maxLen) {
        const truncated = data.slice(0, maxLen).map(item => this.crush(item, mode, capacity));
        truncated.push(`... [${data.length - maxLen} omitted for token limits. Use CCR retrieve if needed.]`);
        return truncated;
      }
      return data.map(item => this.crush(item, mode, capacity));
    }

    if (data !== null && typeof data === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value == null) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        if (typeof value === 'string' && value.length === 0) continue;
        result[key] = this.crush(value, mode, capacity);
      }
      return result;
    }

    return data;
  }
}
