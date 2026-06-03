import { randomBytes } from 'crypto';
import { GraphDB } from '../storage';

export class CCR {
  static save(db: GraphDB, originalData: unknown): string {
    const id = `ccr_${randomBytes(4).toString('hex')}`;
    db.saveCCR(id, JSON.stringify(originalData), Date.now());
    return id;
  }

  static retrieve(db: GraphDB, id: string): string {
    const data = db.getCCR(id);
    if (data != null) return data;
    return JSON.stringify({ error: 'CCR cache miss' });
  }
}
