// ─── Validation utilities ───────────────────────────────────────

import { Money, Currency, Account, Transaction, Category, Budget } from '../models/types';

const CURRENCY_DECIMALS: Record<Currency, number> = {
  USD: 2, EUR: 2, GBP: 2, JPY: 0, INR: 2,
};

export function roundMoney(money: Money): Money {
  const decimals = CURRENCY_DECIMALS[money.currency] ?? 2;
  const factor = Math.pow(10, decimals);
  return {
    amount: Math.round(money.amount * factor) / factor,
    currency: money.currency,
  };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return roundMoney({ amount: a.amount + b.amount, currency: a.currency });
}

export function subtractMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return roundMoney({ amount: a.amount - b.amount, currency: a.currency });
}

export function multiplyMoney(money: Money, factor: number): Money {
  return roundMoney({ amount: money.amount * factor, currency: money.currency });
}

export function isPositive(money: Money): boolean {
  return money.amount > 0;
}

export function isZeroOrPositive(money: Money): boolean {
  return money.amount >= 0;
}

export function formatMoney(money: Money): string {
  const symbols: Record<Currency, string> = {
    USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹',
  };
  const decimals = CURRENCY_DECIMALS[money.currency];
  const symbol = symbols[money.currency];
  return `${symbol}${money.amount.toFixed(decimals)}`;
}

export function validateAccount(account: Partial<Account>): string[] {
  const errors: string[] = [];
  if (!account.name?.trim()) errors.push('Account name is required');
  if (!account.type) errors.push('Account type is required');
  if (account.balance && account.balance.amount < 0 && account.type !== 'credit') {
    errors.push('Non-credit accounts cannot have negative balance');
  }
  return errors;
}

export function validateTransaction(tx: Partial<Transaction>): string[] {
  const errors: string[] = [];
  if (!tx.accountId) errors.push('Account ID is required');
  if (!tx.type) errors.push('Transaction type is required');
  if (!tx.amount || tx.amount.amount <= 0) errors.push('Amount must be positive');
  if (!tx.categoryId) errors.push('Category is required');
  if (!tx.date) errors.push('Date is required');
  if (tx.description && tx.description.length > 500) {
    errors.push('Description too long (max 500 chars)');
  }
  return errors;
}

export function validateCategory(cat: Partial<Category>): string[] {
  const errors: string[] = [];
  if (!cat.name?.trim()) errors.push('Category name is required');
  if (cat.name && cat.name.length > 50) errors.push('Category name too long');
  return errors;
}

export function validateBudget(budget: Partial<Budget>): string[] {
  const errors: string[] = [];
  if (!budget.categoryId) errors.push('Category is required');
  if (!budget.limit || budget.limit.amount <= 0) errors.push('Budget limit must be positive');
  if (!budget.period) errors.push('Budget period is required');
  return errors;
}
