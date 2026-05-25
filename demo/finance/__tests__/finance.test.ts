// ─── Tests for finance tracker services ─────────────────────────

import { DataStore } from '../src/models/store';
import { EventBus } from '../src/events/event-bus';
import { AccountService } from '../src/services/account-service';
import { BudgetService } from '../src/services/budget-service';
import { TransactionService } from '../src/services/transaction-service';
import { ReportGenerator } from '../src/reports/report-generator';
import { NotificationService } from '../src/events/notifications';
import { roundMoney, addMoney, subtractMoney, formatMoney, validateTransaction } from '../src/utils/validation';
import { startOfMonth, endOfMonth, addDays, daysBetween, formatDate } from '../src/utils/dates';

// ─── Money utilities ────────────────────────────────────────────

function testRoundMoney(): void {
  const result = roundMoney({ amount: 10.456, currency: 'USD' });
  console.assert(result.amount === 10.46, `Expected 10.46, got ${result.amount}`);

  const jpy = roundMoney({ amount: 1234.56, currency: 'JPY' });
  console.assert(jpy.amount === 1235, `Expected 1235, got ${jpy.amount}`);
}

function testAddSubtractMoney(): void {
  const a = { amount: 100, currency: 'USD' as const };
  const b = { amount: 50.50, currency: 'USD' as const };

  const sum = addMoney(a, b);
  console.assert(sum.amount === 150.50, `Expected 150.50, got ${sum.amount}`);

  const diff = subtractMoney(a, b);
  console.assert(diff.amount === 49.50, `Expected 49.50, got ${diff.amount}`);
}

function testFormatMoney(): void {
  console.assert(formatMoney({ amount: 1234.56, currency: 'USD' }) === '$1234.56');
  console.assert(formatMoney({ amount: 100, currency: 'EUR' }) === '€100.00');
  console.assert(formatMoney({ amount: 5000, currency: 'JPY' }) === '¥5000');
}

// ─── Date utilities ─────────────────────────────────────────────

function testDateUtils(): void {
  const date = new Date(2025, 5, 15); // June 15, 2025
  const monthStart = startOfMonth(date);
  console.assert(monthStart.getDate() === 1, 'Start of month should be 1');

  const monthEnd = endOfMonth(date);
  console.assert(monthEnd.getDate() === 30, `June should have 30 days, got ${monthEnd.getDate()}`);

  const future = addDays(date, 10);
  console.assert(future.getDate() === 25, 'Adding 10 days to 15th should give 25th');

  console.assert(daysBetween(new Date(2025, 0, 1), new Date(2025, 0, 11)) === 10);
}

// ─── Account service ────────────────────────────────────────────

function testAccountService(): void {
  const store = new DataStore();
  const events = new EventBus();
  const service = new AccountService(store, events);

  const account = service.createAccount('Test Account', 'checking', 'USD', 1000);
  console.assert(account.name === 'Test Account');
  console.assert(account.balance.amount === 1000);

  const retrieved = service.getAccount(account.id);
  console.assert(retrieved.balance.amount === 1000);

  service.applyDebit(account.id, { amount: 200, currency: 'USD' });
  const after = service.getAccount(account.id);
  console.assert(after.balance.amount === 800, `Expected 800, got ${after.balance.amount}`);

  service.applyCredit(account.id, { amount: 50, currency: 'USD' });
  const final = service.getAccount(account.id);
  console.assert(final.balance.amount === 850, `Expected 850, got ${final.balance.amount}`);
}

// ─── Transaction service ────────────────────────────────────────

function testTransactionService(): void {
  const store = new DataStore();
  const events = new EventBus();
  const accounts = new AccountService(store, events);
  const budgets = new BudgetService(store, events);
  const transactions = new TransactionService(store, events, accounts, budgets);

  store.addCategory({ id: 'food', name: 'Food', parentId: null, icon: '🍔', color: '#f00' });
  store.addCategory({ id: 'salary', name: 'Salary', parentId: null, icon: '💰', color: '#0f0' });

  const account = accounts.createAccount('Checking', 'checking', 'USD', 5000);

  const tx = transactions.recordTransaction(account.id, 'expense', 100, 'USD', 'food', 'Lunch');
  console.assert(tx.amount.amount === 100);

  const balance = accounts.getAccount(account.id);
  console.assert(balance.balance.amount === 4900, `Expected 4900, got ${balance.balance.amount}`);

  // Income
  transactions.recordTransaction(account.id, 'income', 3000, 'USD', 'salary', 'Paycheck');
  const afterIncome = accounts.getAccount(account.id);
  console.assert(afterIncome.balance.amount === 7900, `Expected 7900, got ${afterIncome.balance.amount}`);
}

// ─── Budget alerts ──────────────────────────────────────────────

function testBudgetAlerts(): void {
  const store = new DataStore();
  const events = new EventBus();
  const accounts = new AccountService(store, events);
  const budgets = new BudgetService(store, events);
  const transactions = new TransactionService(store, events, accounts, budgets);
  const notifications = new NotificationService(events);

  store.addCategory({ id: 'food', name: 'Food', parentId: null, icon: '🍔', color: '#f00' });
  const account = accounts.createAccount('Test', 'checking', 'USD', 10000);

  budgets.createBudget('food', 'monthly', 100, 'USD');

  // Should trigger warning at 80%
  transactions.recordTransaction(account.id, 'expense', 85, 'USD', 'food', 'Big meal');
  const warningNotifs = notifications.getUnread();
  console.assert(warningNotifs.length >= 1, `Expected warning notification, got ${warningNotifs.length}`);

  // Should trigger critical at 100%
  transactions.recordTransaction(account.id, 'expense', 20, 'USD', 'food', 'Snack');
  const allNotifs = notifications.getUnread();
  const hasCritical = allNotifs.some(n => n.type === 'error');
  console.assert(hasCritical, 'Should have critical notification for exceeding budget');
}

// ─── Report generation ──────────────────────────────────────────

function testReportGeneration(): void {
  const store = new DataStore();
  const events = new EventBus();
  const accounts = new AccountService(store, events);
  const budgets = new BudgetService(store, events);
  const transactions = new TransactionService(store, events, accounts, budgets);
  const reports = new ReportGenerator(store, events, transactions, budgets, accounts);

  store.addCategory({ id: 'food', name: 'Food', parentId: null, icon: '🍔', color: '#f00' });
  store.addCategory({ id: 'salary', name: 'Salary', parentId: null, icon: '💰', color: '#0f0' });

  const account = accounts.createAccount('Checking', 'checking', 'USD', 10000);

  transactions.recordTransaction(account.id, 'income', 5000, 'USD', 'salary', 'Paycheck');
  transactions.recordTransaction(account.id, 'expense', 200, 'USD', 'food', 'Groceries');
  transactions.recordTransaction(account.id, 'expense', 100, 'USD', 'food', 'Restaurants');

  const summary = reports.generateSummary();
  console.assert(summary.netWorth.amount > 0, 'Net worth should be positive');
  console.assert(summary.monthlyIncome.amount === 5000, `Expected income 5000, got ${summary.monthlyIncome.amount}`);

  const report = reports.formatTextReport();
  console.assert(report.includes('PERSONAL FINANCE REPORT'), 'Should contain report header');
  console.assert(report.includes('Food'), 'Should mention food category');
}

// ─── Run all tests ──────────────────────────────────────────────

console.log('Running finance tracker tests...');
testRoundMoney();
testAddSubtractMoney();
testFormatMoney();
testDateUtils();
testAccountService();
testTransactionService();
testBudgetAlerts();
testReportGeneration();
console.log('All tests passed!');
