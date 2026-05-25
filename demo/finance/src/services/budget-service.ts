// ─── Budget service — tracks spending against category budgets ──

import { Budget, Money, Currency, BudgetAlert } from '../models/types';
import { DataStore } from '../models/store';
import { EventBus } from '../events/event-bus';
import { validateBudget, addMoney, subtractMoney, formatMoney, isPositive } from '../utils/validation';
import { generateId } from '../utils/id';
import { getCurrentMonthRange } from '../utils/dates';

export class BudgetService {
  constructor(
    private store: DataStore,
    private events: EventBus,
  ) {}

  createBudget(
    categoryId: string,
    period: 'monthly' | 'yearly',
    limitAmount: number,
    currency: Currency,
  ): Budget {
    const budget: Budget = {
      id: generateId('bgt_'),
      categoryId,
      period,
      limit: { amount: limitAmount, currency },
      spent: { amount: 0, currency },
      startDate: new Date(),
    };

    const errors = validateBudget(budget);
    if (errors.length > 0) {
      throw new Error(`Invalid budget: ${errors.join(', ')}`);
    }

    this.store.addBudget(budget);
    return budget;
  }

  trackSpending(categoryId: string, amount: Money): void {
    const budget = this.store.getBudgetByCategory(categoryId);
    if (!budget) return; // no budget for this category

    const newSpent = addMoney(budget.spent, amount);
    this.store.updateBudget(budget.id, { spent: newSpent });

    // Check thresholds
    const percentUsed = (newSpent.amount / budget.limit.amount) * 100;
    const remaining = subtractMoney(budget.limit, newSpent);

    if (percentUsed >= 100) {
      const category = this.store.getCategory(categoryId);
      const alert: BudgetAlert = {
        budgetId: budget.id,
        categoryName: category?.name ?? categoryId,
        percentUsed,
        remaining,
        severity: 'critical',
      };
      this.events.emit('budget:exceeded', alert, 'BudgetService');
    } else if (percentUsed >= 80) {
      const category = this.store.getCategory(categoryId);
      const alert: BudgetAlert = {
        budgetId: budget.id,
        categoryName: category?.name ?? categoryId,
        percentUsed,
        remaining,
        severity: 'warning',
      };
      this.events.emit('budget:warning', alert, 'BudgetService');
    }
  }

  getBudgetStatus(): BudgetAlert[] {
    const budgets = this.store.getAllBudgets();
    const alerts: BudgetAlert[] = [];

    for (const budget of budgets) {
      const category = this.store.getCategory(budget.categoryId);
      const percentUsed = (budget.spent.amount / budget.limit.amount) * 100;
      const remaining = subtractMoney(budget.limit, budget.spent);

      let severity: BudgetAlert['severity'];
      if (percentUsed >= 100) severity = 'critical';
      else if (percentUsed >= 80) severity = 'warning';
      else severity = 'info';

      alerts.push({
        budgetId: budget.id,
        categoryName: category?.name ?? budget.categoryId,
        percentUsed: Math.round(percentUsed * 100) / 100,
        remaining,
        severity,
      });
    }

    return alerts.sort((a, b) => b.percentUsed - a.percentUsed);
  }

  resetMonthlyBudgets(): number {
    const budgets = this.store.getAllBudgets().filter(b => b.period === 'monthly');
    let resetCount = 0;

    for (const budget of budgets) {
      if (isPositive(budget.spent)) {
        this.store.updateBudget(budget.id, {
          spent: { amount: 0, currency: budget.spent.currency },
        });
        resetCount++;
      }
    }

    return resetCount;
  }

  getOverBudgetCategories(): string[] {
    return this.getBudgetStatus()
      .filter(a => a.severity === 'critical')
      .map(a => a.categoryName);
  }

  getRemainingBudget(categoryId: string): Money | null {
    const budget = this.store.getBudgetByCategory(categoryId);
    if (!budget) return null;
    return subtractMoney(budget.limit, budget.spent);
  }

  formatBudgetReport(): string {
    const status = this.getBudgetStatus();
    const lines = ['Budget Report', '='.repeat(40)];

    for (const alert of status) {
      const bar = this.renderProgressBar(alert.percentUsed);
      const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '🟡' : '🟢';
      lines.push(`${icon} ${alert.categoryName}: ${bar} ${alert.percentUsed.toFixed(1)}% (${formatMoney(alert.remaining)} remaining)`);
    }

    return lines.join('\n');
  }

  private renderProgressBar(percent: number): string {
    const filled = Math.min(20, Math.round(percent / 5));
    const empty = 20 - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }
}
