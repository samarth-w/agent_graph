// ─── Report generation — spending analytics & summaries ─────────

import { Transaction, Money, DateRange, Category } from '../models/types';
import { DataStore } from '../models/store';
import { TransactionService } from '../services/transaction-service';
import { BudgetService } from '../services/budget-service';
import { AccountService } from '../services/account-service';
import { EventBus } from '../events/event-bus';
import { formatMoney, subtractMoney, roundMoney } from '../utils/validation';
import { formatDate, getCurrentMonthRange, getMonthRange, daysBetween } from '../utils/dates';

export interface SpendingByCategory {
  categoryId: string;
  categoryName: string;
  total: Money;
  count: number;
  percentage: number;
}

export interface MonthlyTrend {
  month: string;
  income: Money;
  expenses: Money;
  savings: Money;
  savingsRate: number;
}

export interface FinancialSummary {
  netWorth: Money;
  monthlyIncome: Money;
  monthlyExpenses: Money;
  monthlySavings: Money;
  savingsRate: number;
  topExpenseCategories: SpendingByCategory[];
  budgetAlerts: { category: string; percentUsed: number; severity: string }[];
  upcomingRecurring: number;
}

export class ReportGenerator {
  constructor(
    private store: DataStore,
    private events: EventBus,
    private transactionService: TransactionService,
    private budgetService: BudgetService,
    private accountService: AccountService,
  ) {}

  /**
   * Generate spending breakdown by category for a date range.
   */
  getSpendingByCategory(range: DateRange): SpendingByCategory[] {
    const transactions = this.transactionService.getTransactions(range);
    const expenses = transactions.items.filter(tx => tx.type === 'expense');

    const totalExpenses = expenses.reduce((sum, tx) => sum + tx.amount.amount, 0);

    const byCategory = new Map<string, { total: number; count: number; currency: string }>();
    for (const tx of expenses) {
      const entry = byCategory.get(tx.categoryId) ?? { total: 0, count: 0, currency: tx.amount.currency };
      entry.total += tx.amount.amount;
      entry.count++;
      byCategory.set(tx.categoryId, entry);
    }

    const results: SpendingByCategory[] = [];
    for (const [categoryId, data] of byCategory) {
      const category = this.store.getCategory(categoryId);
      results.push({
        categoryId,
        categoryName: category?.name ?? categoryId,
        total: roundMoney({ amount: data.total, currency: data.currency as any }),
        count: data.count,
        percentage: totalExpenses > 0 ? Math.round((data.total / totalExpenses) * 10000) / 100 : 0,
      });
    }

    return results.sort((a, b) => b.total.amount - a.total.amount);
  }

  /**
   * Generate monthly income/expense trend for the past N months.
   */
  getMonthlyTrend(months: number = 6): MonthlyTrend[] {
    const trends: MonthlyTrend[] = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const range = getMonthRange(date.getFullYear(), date.getMonth());

      const income = this.transactionService.getTotalByType('income', range);
      const expenses = this.transactionService.getTotalByType('expense', range);
      const savings = subtractMoney(income, expenses);
      const savingsRate = income.amount > 0 ? (savings.amount / income.amount) * 100 : 0;

      trends.push({
        month: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
        income,
        expenses,
        savings,
        savingsRate: Math.round(savingsRate * 100) / 100,
      });
    }

    return trends;
  }

  /**
   * Full financial summary — the dashboard view.
   */
  generateSummary(): FinancialSummary {
    const monthRange = getCurrentMonthRange();

    const netWorth = this.accountService.getNetWorth();
    const monthlyIncome = this.transactionService.getTotalByType('income', monthRange);
    const monthlyExpenses = this.transactionService.getTotalByType('expense', monthRange);
    const monthlySavings = subtractMoney(monthlyIncome, monthlyExpenses);
    const savingsRate = monthlyIncome.amount > 0
      ? Math.round((monthlySavings.amount / monthlyIncome.amount) * 10000) / 100
      : 0;

    const topExpenseCategories = this.getSpendingByCategory(monthRange).slice(0, 5);
    const budgetAlerts = this.budgetService.getBudgetStatus()
      .filter(a => a.severity !== 'info')
      .map(a => ({
        category: a.categoryName,
        percentUsed: a.percentUsed,
        severity: a.severity,
      }));

    const summary: FinancialSummary = {
      netWorth,
      monthlyIncome,
      monthlyExpenses,
      monthlySavings,
      savingsRate,
      topExpenseCategories,
      budgetAlerts,
      upcomingRecurring: 0, // filled in by caller
    };

    this.events.emit('report:generated', { type: 'summary', date: formatDate(new Date()) }, 'ReportGenerator');
    return summary;
  }

  /**
   * Generate a formatted text report for console/email.
   */
  formatTextReport(): string {
    const summary = this.generateSummary();
    const lines: string[] = [];

    lines.push('═══════════════════════════════════════');
    lines.push('     PERSONAL FINANCE REPORT');
    lines.push(`     ${formatDate(new Date())}`);
    lines.push('═══════════════════════════════════════');
    lines.push('');
    lines.push(`Net Worth:       ${formatMoney(summary.netWorth)}`);
    lines.push(`Monthly Income:  ${formatMoney(summary.monthlyIncome)}`);
    lines.push(`Monthly Expenses:${formatMoney(summary.monthlyExpenses)}`);
    lines.push(`Monthly Savings: ${formatMoney(summary.monthlySavings)}`);
    lines.push(`Savings Rate:    ${summary.savingsRate}%`);
    lines.push('');

    if (summary.topExpenseCategories.length > 0) {
      lines.push('── Top Expense Categories ──────────');
      for (const cat of summary.topExpenseCategories) {
        lines.push(`  ${cat.categoryName}: ${formatMoney(cat.total)} (${cat.percentage}%)`);
      }
      lines.push('');
    }

    if (summary.budgetAlerts.length > 0) {
      lines.push('── Budget Alerts ───────────────────');
      for (const alert of summary.budgetAlerts) {
        const icon = alert.severity === 'critical' ? '🔴' : '🟡';
        lines.push(`  ${icon} ${alert.category}: ${alert.percentUsed}% used`);
      }
      lines.push('');
    }

    lines.push(this.budgetService.formatBudgetReport());

    return lines.join('\n');
  }

  /**
   * Calculate average daily spending over a date range.
   */
  getAverageDailySpending(range: DateRange): Money {
    const expenses = this.transactionService.getTotalByType('expense', range);
    const days = Math.max(1, daysBetween(range.start, range.end));
    return roundMoney({ amount: expenses.amount / days, currency: expenses.currency });
  }

  /**
   * Project end-of-month balance based on current trends.
   */
  projectEndOfMonth(): Money {
    const now = new Date();
    const monthRange = getCurrentMonthRange();
    const daysPassed = daysBetween(monthRange.start, now);
    const totalDays = daysBetween(monthRange.start, monthRange.end);

    if (daysPassed === 0) return this.accountService.getNetWorth();

    const currentExpenses = this.transactionService.getTotalByType('expense', monthRange);
    const dailyRate = currentExpenses.amount / daysPassed;
    const projectedTotal = dailyRate * totalDays;

    const currentIncome = this.transactionService.getTotalByType('income', monthRange);
    const netWorth = this.accountService.getNetWorth();

    return roundMoney({
      amount: netWorth.amount + currentIncome.amount - projectedTotal,
      currency: netWorth.currency,
    });
  }
}
