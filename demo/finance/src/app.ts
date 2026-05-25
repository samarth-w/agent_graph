// ─── Application bootstrap — wires everything together ──────────

import { DataStore } from './models/store';
import { EventBus } from './events/event-bus';
import { AccountService } from './services/account-service';
import { BudgetService } from './services/budget-service';
import { TransactionService } from './services/transaction-service';
import { RecurringProcessor } from './services/recurring-processor';
import { ReportGenerator } from './reports/report-generator';
import { NotificationService } from './events/notifications';
import { ApiController } from './api/controller';
import { RequestLogger } from './api/middleware';
import type { Category } from './models/types';

export interface App {
  store: DataStore;
  events: EventBus;
  accounts: AccountService;
  budgets: BudgetService;
  transactions: TransactionService;
  recurring: RecurringProcessor;
  reports: ReportGenerator;
  notifications: NotificationService;
  api: ApiController;
  logger: RequestLogger;
}

export function createApp(): App {
  const store = new DataStore();
  const events = new EventBus();

  const accounts = new AccountService(store, events);
  const budgets = new BudgetService(store, events);
  const transactions = new TransactionService(store, events, accounts, budgets);
  const recurring = new RecurringProcessor(store, events, transactions);
  const reports = new ReportGenerator(store, events, transactions, budgets, accounts);
  const notifications = new NotificationService(events);
  const api = new ApiController(store, events);
  const logger = new RequestLogger();

  return { store, events, accounts, budgets, transactions, recurring, reports, notifications, api, logger };
}

export function seedDemoData(app: App): void {
  // Categories
  const categories: Category[] = [
    { id: 'food', name: 'Food & Dining', parentId: null, icon: '🍔', color: '#FF6B35' },
    { id: 'groceries', name: 'Groceries', parentId: 'food', icon: '🛒', color: '#FF8C5A' },
    { id: 'restaurants', name: 'Restaurants', parentId: 'food', icon: '🍽️', color: '#FFB088' },
    { id: 'transport', name: 'Transportation', parentId: null, icon: '🚗', color: '#004E98' },
    { id: 'gas', name: 'Gas', parentId: 'transport', icon: '⛽', color: '#3A7CC3' },
    { id: 'housing', name: 'Housing', parentId: null, icon: '🏠', color: '#2DC653' },
    { id: 'rent', name: 'Rent', parentId: 'housing', icon: '🔑', color: '#5DD57A' },
    { id: 'utilities', name: 'Utilities', parentId: 'housing', icon: '💡', color: '#8DE4A0' },
    { id: 'entertainment', name: 'Entertainment', parentId: null, icon: '🎬', color: '#9B5DE5' },
    { id: 'salary', name: 'Salary', parentId: null, icon: '💰', color: '#00BBF9' },
    { id: 'freelance', name: 'Freelance', parentId: null, icon: '💻', color: '#00D4AA' },
    { id: 'transfer', name: 'Transfer', parentId: null, icon: '🔄', color: '#888888' },
  ];
  for (const cat of categories) app.store.addCategory(cat);

  // Accounts
  const checking = app.accounts.createAccount('Main Checking', 'checking', 'USD', 5000);
  const savings = app.accounts.createAccount('Emergency Fund', 'savings', 'USD', 15000);
  const credit = app.accounts.createAccount('Visa Card', 'credit', 'USD', 0);

  // Budgets
  app.budgets.createBudget('food', 'monthly', 600, 'USD');
  app.budgets.createBudget('transport', 'monthly', 200, 'USD');
  app.budgets.createBudget('entertainment', 'monthly', 150, 'USD');
  app.budgets.createBudget('housing', 'monthly', 2000, 'USD');

  // Transactions
  const now = new Date();
  app.transactions.recordTransaction(checking.id, 'income', 4500, 'USD', 'salary', 'Monthly salary', new Date(now.getFullYear(), now.getMonth(), 1));
  app.transactions.recordTransaction(checking.id, 'income', 800, 'USD', 'freelance', 'Web dev project', new Date(now.getFullYear(), now.getMonth(), 5));

  app.transactions.recordTransaction(checking.id, 'expense', 1500, 'USD', 'rent', 'Monthly rent', new Date(now.getFullYear(), now.getMonth(), 1));
  app.transactions.recordTransaction(checking.id, 'expense', 120, 'USD', 'utilities', 'Electric + Internet', new Date(now.getFullYear(), now.getMonth(), 3));
  app.transactions.recordTransaction(checking.id, 'expense', 85, 'USD', 'groceries', 'Whole Foods', new Date(now.getFullYear(), now.getMonth(), 4));
  app.transactions.recordTransaction(checking.id, 'expense', 45, 'USD', 'restaurants', 'Dinner out', new Date(now.getFullYear(), now.getMonth(), 6));
  app.transactions.recordTransaction(checking.id, 'expense', 55, 'USD', 'gas', 'Shell station', new Date(now.getFullYear(), now.getMonth(), 7));
  app.transactions.recordTransaction(checking.id, 'expense', 30, 'USD', 'entertainment', 'Movie tickets', new Date(now.getFullYear(), now.getMonth(), 8));
  app.transactions.recordTransaction(credit.id, 'expense', 200, 'USD', 'groceries', 'Costco run', new Date(now.getFullYear(), now.getMonth(), 10));
  app.transactions.recordTransaction(checking.id, 'expense', 65, 'USD', 'restaurants', 'Team lunch', new Date(now.getFullYear(), now.getMonth(), 12));
  app.transactions.recordTransaction(checking.id, 'expense', 40, 'USD', 'entertainment', 'Spotify + Netflix', new Date(now.getFullYear(), now.getMonth(), 15));

  // Transfer
  app.transactions.recordTransfer(checking.id, savings.id, 500, 'USD', 'Savings deposit');
}

// ─── Run demo ───────────────────────────────────────────────────
function main(): void {
  const app = createApp();
  seedDemoData(app);

  console.log(app.reports.formatTextReport());
  console.log('');
  console.log('Notifications:', app.notifications.getUnreadCount(), 'unread');
  for (const n of app.notifications.getUnread()) {
    console.log(`  [${n.type}] ${n.title}: ${n.message}`);
  }

  console.log('');
  console.log('Store stats:', app.store.getStats());
  console.log('Budget report:');
  console.log(app.budgets.formatBudgetReport());
}

main();
