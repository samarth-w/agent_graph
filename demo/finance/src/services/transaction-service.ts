// ─── Transaction service — records and categorizes transactions ─

import { Transaction, TransactionType, Money, Currency } from '../models/types';
import { DataStore } from '../models/store';
import { EventBus } from '../events/event-bus';
import { AccountService } from './account-service';
import { BudgetService } from './budget-service';
import { validateTransaction, roundMoney } from '../utils/validation';
import { generateId } from '../utils/id';
import { isDateInRange } from '../utils/dates';
import type { DateRange, PaginationOptions, PaginatedResult } from '../models/types';

export class TransactionService {
  constructor(
    private store: DataStore,
    private events: EventBus,
    private accountService: AccountService,
    private budgetService: BudgetService,
  ) {}

  recordTransaction(
    accountId: string,
    type: TransactionType,
    amount: number,
    currency: Currency,
    categoryId: string,
    description: string,
    date: Date = new Date(),
    tags: string[] = [],
  ): Transaction {
    const money: Money = roundMoney({ amount, currency });

    const tx: Transaction = {
      id: generateId('tx_'),
      accountId,
      type,
      amount: money,
      categoryId,
      description,
      date,
      tags,
    };

    const errors = validateTransaction(tx);
    if (errors.length > 0) {
      throw new Error(`Invalid transaction: ${errors.join(', ')}`);
    }

    // Verify account exists
    this.accountService.getAccount(accountId);

    // Apply to account balance
    if (type === 'expense') {
      this.accountService.applyDebit(accountId, money);
    } else if (type === 'income') {
      this.accountService.applyCredit(accountId, money);
    }

    this.store.addTransaction(tx);

    // Update budget tracking
    if (type === 'expense') {
      this.budgetService.trackSpending(categoryId, money);
    }

    this.events.emit('transaction:created', tx, 'TransactionService');
    return tx;
  }

  recordTransfer(
    fromAccountId: string,
    toAccountId: string,
    amount: number,
    currency: Currency,
    description: string = 'Transfer',
  ): { debit: Transaction; credit: Transaction } {
    const money = roundMoney({ amount, currency });

    // Debit from source
    this.accountService.applyDebit(fromAccountId, money);
    const debit: Transaction = {
      id: generateId('tx_'),
      accountId: fromAccountId,
      type: 'transfer',
      amount: money,
      categoryId: 'transfer',
      description: `${description} → out`,
      date: new Date(),
      tags: ['transfer'],
      metadata: { linkedAccount: toAccountId },
    };
    this.store.addTransaction(debit);

    // Credit to destination
    this.accountService.applyCredit(toAccountId, money);
    const credit: Transaction = {
      id: generateId('tx_'),
      accountId: toAccountId,
      type: 'transfer',
      amount: money,
      categoryId: 'transfer',
      description: `${description} ← in`,
      date: new Date(),
      tags: ['transfer'],
      metadata: { linkedAccount: fromAccountId },
    };
    this.store.addTransaction(credit);

    return { debit, credit };
  }

  deleteTransaction(id: string): void {
    const tx = this.store.getTransaction(id);
    if (!tx) throw new Error(`Transaction ${id} not found`);

    // Reverse the balance change
    if (tx.type === 'expense') {
      this.accountService.applyCredit(tx.accountId, tx.amount);
    } else if (tx.type === 'income') {
      this.accountService.applyDebit(tx.accountId, tx.amount);
    }

    this.store.deleteTransaction(id);
    this.events.emit('transaction:deleted', tx, 'TransactionService');
  }

  getTransactions(range?: DateRange, pagination?: PaginationOptions): PaginatedResult<Transaction> {
    let txs = this.store.getAllTransactions();

    if (range) {
      txs = txs.filter(tx => isDateInRange(tx.date, range));
    }

    // Sort
    const sortBy = pagination?.sortBy ?? 'date';
    const sortOrder = pagination?.sortOrder ?? 'desc';
    txs.sort((a, b) => {
      const aVal = sortBy === 'amount' ? a.amount.amount : a.date.getTime();
      const bVal = sortBy === 'amount' ? b.amount.amount : b.date.getTime();
      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });

    // Paginate
    const page = pagination?.page ?? 1;
    const pageSize = pagination?.pageSize ?? 50;
    const start = (page - 1) * pageSize;
    const items = txs.slice(start, start + pageSize);

    return {
      items,
      total: txs.length,
      page,
      pageSize,
      totalPages: Math.ceil(txs.length / pageSize),
    };
  }

  getByCategory(categoryId: string, range?: DateRange): Transaction[] {
    let txs = this.store.getTransactionsByCategory(categoryId);
    if (range) {
      txs = txs.filter(tx => isDateInRange(tx.date, range));
    }
    return txs;
  }

  getByTags(tags: string[]): Transaction[] {
    return this.store.getAllTransactions()
      .filter(tx => tags.some(tag => tx.tags.includes(tag)));
  }

  getTotalByType(type: TransactionType, range?: DateRange): Money {
    let txs = this.store.getAllTransactions().filter(tx => tx.type === type);
    if (range) {
      txs = txs.filter(tx => isDateInRange(tx.date, range));
    }
    if (txs.length === 0) return { amount: 0, currency: 'USD' };

    const currency = txs[0].amount.currency;
    const total = txs.reduce((sum, tx) => sum + tx.amount.amount, 0);
    return roundMoney({ amount: total, currency });
  }
}
