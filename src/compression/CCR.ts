import { randomBytes } from 'crypto';
import { GraphDB } from '../storage';

export class CCR {
  static save(db: GraphDB, originalData: unknown): string {
    const id = `ccr_${randomBytes(4).toString('hex')}`;
    db.saveCCR(id, JSON.stringify(originalData), Date.now());
    return id;
  }

  static retrieve(db: GraphDB, id: string): string | undefined {
    const data = db.getCCR(id);
    return data;
  }
}
