// ─── Request logging middleware ─────────────────────────────────

import { ApiRequest, ApiResponse } from './controller';

export interface RequestLog {
  timestamp: Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export class RequestLogger {
  private logs: RequestLog[] = [];
  private maxLogs = 1000;

  log(req: ApiRequest, res: ApiResponse, durationMs: number): void {
    const entry: RequestLog = {
      timestamp: new Date(),
      method: req.method,
      path: req.path,
      status: res.status,
      durationMs,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  getRecentLogs(count: number = 20): RequestLog[] {
    return this.logs.slice(-count);
  }

  getErrorLogs(): RequestLog[] {
    return this.logs.filter(l => l.status >= 400);
  }

  getAverageResponseTime(): number {
    if (this.logs.length === 0) return 0;
    const total = this.logs.reduce((sum, l) => sum + l.durationMs, 0);
    return Math.round(total / this.logs.length);
  }

  getStatusBreakdown(): Record<number, number> {
    const breakdown: Record<number, number> = {};
    for (const log of this.logs) {
      breakdown[log.status] = (breakdown[log.status] ?? 0) + 1;
    }
    return breakdown;
  }

  clear(): void {
    this.logs = [];
  }
}
