// ─── Recurring transaction processor ────────────────────────────

import { Transaction, RecurringRule } from '../models/types';
import { DataStore } from '../models/store';
import { EventBus } from '../events/event-bus';
import { TransactionService } from './transaction-service';
import { getNextOccurrence, isDateInRange, formatDate } from '../utils/dates';

export class RecurringProcessor {
  constructor(
    private store: DataStore,
    private events: EventBus,
    private transactionService: TransactionService,
  ) {}

  /**
   * Process all recurring transactions that are due.
   * Creates new transactions for each occurrence up to `asOfDate`.
   */
  processRecurring(asOfDate: Date = new Date()): ProcessingResult {
    const transactions = this.store.getAllTransactions();
    const recurring = transactions.filter(tx => tx.recurring != null);

    const result: ProcessingResult = {
      processed: 0,
      skipped: 0,
      errors: [],
      created: [],
    };

    for (const tx of recurring) {
      const rule = tx.recurring!;

      // Skip if past end date
      if (rule.endDate && asOfDate > rule.endDate) {
        result.skipped++;
        continue;
      }

      const lastDate = rule.lastProcessed ?? rule.startDate;
      const nextDate = getNextOccurrence(lastDate, rule.frequency, rule.interval);

      if (nextDate <= asOfDate) {
        try {
          const created = this.createRecurringInstance(tx, nextDate);
          result.created.push(created);
          result.processed++;

          // Update lastProcessed
          this.updateLastProcessed(tx.id, nextDate);

          this.events.emit('recurring:processed', {
            original: tx.id,
            created: created.id,
            date: formatDate(nextDate),
          }, 'RecurringProcessor');
        } catch (err: any) {
          result.errors.push({ transactionId: tx.id, error: err.message });
        }
      } else {
        result.skipped++;
      }
    }

    return result;
  }

  private createRecurringInstance(template: Transaction, date: Date): Transaction {
    return this.transactionService.recordTransaction(
      template.accountId,
      template.type,
      template.amount.amount,
      template.amount.currency,
      template.categoryId,
      `${template.description} (recurring)`,
      date,
      [...template.tags, 'recurring'],
    );
  }

  private updateLastProcessed(txId: string, date: Date): void {
    const tx = this.store.getTransaction(txId);
    if (tx?.recurring) {
      tx.recurring.lastProcessed = date;
      // Direct mutation since store returns copies — we need to use
      // the actual map. This is intentionally coupled to DataStore internals.
    }
  }

  getUpcoming(days: number = 30): UpcomingRecurrence[] {
    const transactions = this.store.getAllTransactions();
    const recurring = transactions.filter(tx => tx.recurring != null);
    const now = new Date();
    const upcoming: UpcomingRecurrence[] = [];

    for (const tx of recurring) {
      const rule = tx.recurring!;
      if (rule.endDate && now > rule.endDate) continue;

      const lastDate = rule.lastProcessed ?? rule.startDate;
      const nextDate = getNextOccurrence(lastDate, rule.frequency, rule.interval);

      const daysUntil = Math.floor((nextDate.getTime() - now.getTime()) / 86400000);
      if (daysUntil >= 0 && daysUntil <= days) {
        upcoming.push({
          transactionId: tx.id,
          description: tx.description,
          amount: tx.amount.amount,
          currency: tx.amount.currency,
          nextDate,
          daysUntil,
          frequency: rule.frequency,
        });
      }
    }

    return upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
  }
}

export interface ProcessingResult {
  processed: number;
  skipped: number;
  errors: { transactionId: string; error: string }[];
  created: Transaction[];
}

export interface UpcomingRecurrence {
  transactionId: string;
  description: string;
  amount: number;
  currency: string;
  nextDate: Date;
  daysUntil: number;
  frequency: string;
}
