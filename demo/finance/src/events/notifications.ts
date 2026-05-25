// ─── Notification listener — reacts to events ──────────────────

import { EventBus, AppEvent } from '../events/event-bus';
import type { BudgetAlert, Transaction } from '../models/types';
import { formatMoney } from '../utils/validation';

export interface Notification {
  id: number;
  type: 'info' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: Date;
  read: boolean;
}

export class NotificationService {
  private notifications: Notification[] = [];
  private nextId = 1;

  constructor(private events: EventBus) {
    this.setupListeners();
  }

  private setupListeners(): void {
    this.events.on<BudgetAlert>('budget:exceeded', (event) => {
      this.addNotification('error',
        'Budget Exceeded!',
        `${event.payload.categoryName} is at ${event.payload.percentUsed.toFixed(0)}% — ${formatMoney(event.payload.remaining)} over budget`,
      );
    });

    this.events.on<BudgetAlert>('budget:warning', (event) => {
      this.addNotification('warning',
        'Budget Warning',
        `${event.payload.categoryName} is at ${event.payload.percentUsed.toFixed(0)}% — ${formatMoney(event.payload.remaining)} remaining`,
      );
    });

    this.events.on<Transaction>('transaction:created', (event) => {
      const tx = event.payload;
      if (tx.amount.amount >= 500) {
        this.addNotification('info',
          'Large Transaction',
          `${tx.type}: ${formatMoney(tx.amount)} — ${tx.description}`,
        );
      }
    });

    this.events.on('recurring:processed', (event) => {
      this.addNotification('info',
        'Recurring Transaction Processed',
        `Transaction ${(event.payload as any).created} created from template ${(event.payload as any).original}`,
      );
    });
  }

  private addNotification(type: Notification['type'], title: string, message: string): void {
    this.notifications.push({
      id: this.nextId++,
      type,
      title,
      message,
      timestamp: new Date(),
      read: false,
    });
  }

  getUnread(): Notification[] {
    return this.notifications.filter(n => !n.read);
  }

  getAll(): Notification[] {
    return [...this.notifications];
  }

  markRead(id: number): void {
    const n = this.notifications.find(n => n.id === id);
    if (n) n.read = true;
  }

  markAllRead(): void {
    for (const n of this.notifications) {
      n.read = true;
    }
  }

  getUnreadCount(): number {
    return this.notifications.filter(n => !n.read).length;
  }

  clear(): void {
    this.notifications = [];
  }
}
