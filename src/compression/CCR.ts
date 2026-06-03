import { randomBytes } from 'crypto';
import { GraphDB } from '../storage';

export class CCR {
  static save(db: GraphDB, originalData: unknown): string {
    const id = `ccr_${randomBytes(4).toString('hex')}`;
    db.saveCcrEntry(id, JSON.stringify(originalData));
    return id;
  }

  static retrieve(db: GraphDB, id: string): string {
    const original = db.getCcrEntry(id);
    return original ?? JSON.stringify({ error: 'CCR cache miss' });
  }
}
