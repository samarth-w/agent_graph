// ─── Core domain types for the personal finance tracker ────────

export type Currency = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'INR';

export type AccountType = 'checking' | 'savings' | 'credit' | 'investment' | 'cash';

export type TransactionType = 'income' | 'expense' | 'transfer';

export type RecurrenceFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';

export interface Money {
  amount: number;
  currency: Currency;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  balance: Money;
  createdAt: Date;
  isActive: boolean;
}

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  icon: string;
  color: string;
  budget?: Money;
}

export interface Transaction {
  id: string;
  accountId: string;
  type: TransactionType;
  amount: Money;
  categoryId: string;
  description: string;
  date: Date;
  tags: string[];
  recurring?: RecurringRule;
  metadata?: Record<string, unknown>;
}

export interface RecurringRule {
  frequency: RecurrenceFrequency;
  interval: number;
  startDate: Date;
  endDate?: Date;
  lastProcessed?: Date;
}

export interface Budget {
  id: string;
  categoryId: string;
  period: 'monthly' | 'yearly';
  limit: Money;
  spent: Money;
  startDate: Date;
}

export interface BudgetAlert {
  budgetId: string;
  categoryName: string;
  percentUsed: number;
  remaining: Money;
  severity: 'info' | 'warning' | 'critical';
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface PaginationOptions {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
