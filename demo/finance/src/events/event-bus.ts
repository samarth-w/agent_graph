// ─── Event system — pub/sub for cross-module communication ─────

export type EventType =
  | 'transaction:created'
  | 'transaction:deleted'
  | 'account:updated'
  | 'budget:exceeded'
  | 'budget:warning'
  | 'recurring:processed'
  | 'report:generated';

export interface AppEvent<T = unknown> {
  type: EventType;
  payload: T;
  timestamp: Date;
  source: string;
}

type EventHandler<T = unknown> = (event: AppEvent<T>) => void;

export class EventBus {
  private handlers = new Map<EventType, Set<EventHandler>>();
  private history: AppEvent[] = [];
  private maxHistory = 100;

  on<T>(type: EventType, handler: EventHandler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as EventHandler);
    this.handlers.set(type, set);

    // Return unsubscribe function
    return () => set.delete(handler as EventHandler);
  }

  emit<T>(type: EventType, payload: T, source: string): void {
    const event: AppEvent<T> = {
      type,
      payload,
      timestamp: new Date(),
      source,
    };

    this.history.push(event as AppEvent);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    const set = this.handlers.get(type);
    if (set) {
      for (const handler of set) {
        try {
          handler(event as AppEvent);
        } catch (err) {
          console.error(`Event handler error for ${type}:`, err);
        }
      }
    }
  }

  getHistory(type?: EventType): AppEvent[] {
    if (type) return this.history.filter(e => e.type === type);
    return [...this.history];
  }

  clear(): void {
    this.handlers.clear();
    this.history = [];
  }
}
