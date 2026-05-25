// ─── In-memory data store with validation ──────────────────────

import { Account, Transaction, Category, Budget } from './types';

export class DataStore {
  private accounts: Map<string, Account> = new Map();
  private transactions: Map<string, Transaction> = new Map();
  private categories: Map<string, Category> = new Map();
  private budgets: Map<string, Budget> = new Map();

  // ── Accounts ──────────────────────────────────────────────────
  addAccount(account: Account): void {
    if (this.accounts.has(account.id)) {
      throw new Error(`Account ${account.id} already exists`);
    }
    this.accounts.set(account.id, { ...account });
  }

  getAccount(id: string): Account | undefined {
    const acc = this.accounts.get(id);
    return acc ? { ...acc } : undefined;
  }

  updateAccount(id: string, updates: Partial<Account>): Account {
    const acc = this.accounts.get(id);
    if (!acc) throw new Error(`Account ${id} not found`);
    const updated = { ...acc, ...updates, id }; // never change id
    this.accounts.set(id, updated);
    return { ...updated };
  }

  getAllAccounts(): Account[] {
    return [...this.accounts.values()].map(a => ({ ...a }));
  }

  // ── Transactions ──────────────────────────────────────────────
  addTransaction(tx: Transaction): void {
    this.transactions.set(tx.id, { ...tx });
  }

  getTransaction(id: string): Transaction | undefined {
    const tx = this.transactions.get(id);
    return tx ? { ...tx } : undefined;
  }

  getTransactionsByAccount(accountId: string): Transaction[] {
    return [...this.transactions.values()]
      .filter(tx => tx.accountId === accountId)
      .map(tx => ({ ...tx }));
  }

  getTransactionsByCategory(categoryId: string): Transaction[] {
    return [...this.transactions.values()]
      .filter(tx => tx.categoryId === categoryId)
      .map(tx => ({ ...tx }));
  }

  getTransactionsInRange(start: Date, end: Date): Transaction[] {
    return [...this.transactions.values()]
      .filter(tx => tx.date >= start && tx.date <= end)
      .map(tx => ({ ...tx }));
  }

  getAllTransactions(): Transaction[] {
    return [...this.transactions.values()].map(tx => ({ ...tx }));
  }

  deleteTransaction(id: string): boolean {
    return this.transactions.delete(id);
  }

  // ── Categories ────────────────────────────────────────────────
  addCategory(cat: Category): void {
    this.categories.set(cat.id, { ...cat });
  }

  getCategory(id: string): Category | undefined {
    const cat = this.categories.get(id);
    return cat ? { ...cat } : undefined;
  }

  getAllCategories(): Category[] {
    return [...this.categories.values()].map(c => ({ ...c }));
  }

  getSubCategories(parentId: string): Category[] {
    return [...this.categories.values()]
      .filter(c => c.parentId === parentId)
      .map(c => ({ ...c }));
  }

  // ── Budgets ───────────────────────────────────────────────────
  addBudget(budget: Budget): void {
    this.budgets.set(budget.id, { ...budget });
  }

  getBudget(id: string): Budget | undefined {
    const b = this.budgets.get(id);
    return b ? { ...b } : undefined;
  }

  getBudgetByCategory(categoryId: string): Budget | undefined {
    const b = [...this.budgets.values()].find(b => b.categoryId === categoryId);
    return b ? { ...b } : undefined;
  }

  updateBudget(id: string, updates: Partial<Budget>): Budget {
    const b = this.budgets.get(id);
    if (!b) throw new Error(`Budget ${id} not found`);
    const updated = { ...b, ...updates, id };
    this.budgets.set(id, updated);
    return { ...updated };
  }

  getAllBudgets(): Budget[] {
    return [...this.budgets.values()].map(b => ({ ...b }));
  }

  // ── Utilities ─────────────────────────────────────────────────
  clear(): void {
    this.accounts.clear();
    this.transactions.clear();
    this.categories.clear();
    this.budgets.clear();
  }

  getStats(): { accounts: number; transactions: number; categories: number; budgets: number } {
    return {
      accounts: this.accounts.size,
      transactions: this.transactions.size,
      categories: this.categories.size,
      budgets: this.budgets.size,
    };
  }
}
