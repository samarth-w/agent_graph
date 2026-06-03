export type AgentMode = 'coding' | 'thinking';
export type ModelCapacity = 'standard' | 'large';

export class SmartCrusher {
  static crush(data: unknown, mode: AgentMode, capacity: ModelCapacity): unknown {
    let maxLen = mode === 'thinking' ? 25 : 10;
    if (capacity === 'large') maxLen *= 2;
    return SmartCrusher.crushNode(data, mode, capacity, maxLen);
  }

  private static crushNode(
    data: unknown,
    mode: AgentMode,
    capacity: ModelCapacity,
    maxLen: number,
  ): unknown {
    if (Array.isArray(data)) {
      if (data.length > maxLen) {
        const truncated = data
          .slice(0, maxLen)
          .map(item => SmartCrusher.crushNode(item, mode, capacity, maxLen));
        truncated.push(`... [${data.length - maxLen} omitted for token limits. Use CCR retrieve if needed.]`);
        return truncated;
      }
      return data.map(item => SmartCrusher.crushNode(item, mode, capacity, maxLen));
    }

    if (data && typeof data === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (value == null) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        result[key] = SmartCrusher.crushNode(value, mode, capacity, maxLen);
      }
      return result;
    }

    return data;
  }
}
