// ─── API controller — handles routing and request/response ──────

import { DataStore } from '../models/store';
import { EventBus } from '../events/event-bus';
import { AccountService } from '../services/account-service';
import { BudgetService } from '../services/budget-service';
import { TransactionService } from '../services/transaction-service';
import { RecurringProcessor } from '../services/recurring-processor';
import { ReportGenerator } from '../reports/report-generator';
import { transactionsToCsv, importTransactionsFromCsv } from '../reports/csv-export';
import type { AccountType, Currency, TransactionType, DateRange } from '../models/types';
import { parseDate } from '../utils/dates';

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export class ApiController {
  private accountService: AccountService;
  private budgetService: BudgetService;
  private transactionService: TransactionService;
  private recurringProcessor: RecurringProcessor;
  private reportGenerator: ReportGenerator;

  constructor(private store: DataStore, private events: EventBus) {
    this.accountService = new AccountService(store, events);
    this.budgetService = new BudgetService(store, events);
    this.transactionService = new TransactionService(store, events, this.accountService, this.budgetService);
    this.recurringProcessor = new RecurringProcessor(store, events, this.transactionService);
    this.reportGenerator = new ReportGenerator(store, events, this.transactionService, this.budgetService, this.accountService);
  }

  async handle(req: ApiRequest): Promise<ApiResponse> {
    try {
      const segments = req.path.split('/').filter(s => s.length > 0);
      const resource = segments[0];
      const id = segments[1];

      switch (resource) {
        case 'accounts': return this.handleAccounts(req, id);
        case 'transactions': return this.handleTransactions(req, id);
        case 'budgets': return this.handleBudgets(req, id);
        case 'reports': return this.handleReports(req, segments.slice(1));
        case 'recurring': return this.handleRecurring(req);
        default:
          return { status: 404, body: { error: `Unknown resource: ${resource}` } };
      }
    } catch (err: any) {
      return { status: 400, body: { error: err.message } };
    }
  }

  private handleAccounts(req: ApiRequest, id?: string): ApiResponse {
    switch (req.method) {
      case 'GET':
        if (id) {
          return { status: 200, body: this.accountService.getAccount(id) };
        }
        return { status: 200, body: this.accountService.listAccounts() };

      case 'POST': {
        const { name, type, currency, initialBalance } = req.body ?? {};
        const account = this.accountService.createAccount(
          name as string,
          type as AccountType,
          currency as Currency,
          initialBalance as number,
        );
        return { status: 201, body: account };
      }

      case 'DELETE':
        if (!id) return { status: 400, body: { error: 'Account ID required' } };
        return { status: 200, body: this.accountService.deactivateAccount(id) };

      default:
        return { status: 405, body: { error: 'Method not allowed' } };
    }
  }

  private handleTransactions(req: ApiRequest, id?: string): ApiResponse {
    switch (req.method) {
      case 'GET': {
        const range = this.parseDateRange(req.query);
        const result = this.transactionService.getTransactions(range, {
          page: parseInt(req.query?.page ?? '1', 10),
          pageSize: parseInt(req.query?.pageSize ?? '50', 10),
          sortBy: req.query?.sortBy,
          sortOrder: (req.query?.sortOrder as 'asc' | 'desc') ?? 'desc',
        });
        return { status: 200, body: result };
      }

      case 'POST': {
        const { accountId, type, amount, currency, categoryId, description, tags } = req.body ?? {};
        const tx = this.transactionService.recordTransaction(
          accountId as string,
          type as TransactionType,
          amount as number,
          currency as Currency,
          categoryId as string,
          description as string,
          new Date(),
          (tags as string[]) ?? [],
        );
        return { status: 201, body: tx };
      }

      case 'DELETE':
        if (!id) return { status: 400, body: { error: 'Transaction ID required' } };
        this.transactionService.deleteTransaction(id);
        return { status: 204, body: null };

      default:
        return { status: 405, body: { error: 'Method not allowed' } };
    }
  }

  private handleBudgets(req: ApiRequest, id?: string): ApiResponse {
    switch (req.method) {
      case 'GET':
        return { status: 200, body: this.budgetService.getBudgetStatus() };

      case 'POST': {
        const { categoryId, period, limit, currency } = req.body ?? {};
        const budget = this.budgetService.createBudget(
          categoryId as string,
          period as 'monthly' | 'yearly',
          limit as number,
          currency as Currency,
        );
        return { status: 201, body: budget };
      }

      default:
        return { status: 405, body: { error: 'Method not allowed' } };
    }
  }

  private handleReports(req: ApiRequest, segments: string[]): ApiResponse {
    const reportType = segments[0] ?? 'summary';

    switch (reportType) {
      case 'summary':
        return { status: 200, body: this.reportGenerator.generateSummary() };

      case 'spending': {
        const range = this.parseDateRange(req.query) ?? { start: new Date(0), end: new Date() };
        return { status: 200, body: this.reportGenerator.getSpendingByCategory(range) };
      }

      case 'trend':
        return { status: 200, body: this.reportGenerator.getMonthlyTrend() };

      case 'text':
        return { status: 200, body: { report: this.reportGenerator.formatTextReport() } };

      case 'csv': {
        const range = this.parseDateRange(req.query);
        const txs = this.transactionService.getTransactions(range);
        return { status: 200, body: { csv: transactionsToCsv(txs.items) } };
      }

      case 'projection':
        return { status: 200, body: this.reportGenerator.projectEndOfMonth() };

      default:
        return { status: 404, body: { error: `Unknown report: ${reportType}` } };
    }
  }

  private handleRecurring(req: ApiRequest): ApiResponse {
    switch (req.method) {
      case 'GET':
        return { status: 200, body: this.recurringProcessor.getUpcoming() };

      case 'POST':
        return { status: 200, body: this.recurringProcessor.processRecurring() };

      default:
        return { status: 405, body: { error: 'Method not allowed' } };
    }
  }

  private parseDateRange(query?: Record<string, string>): DateRange | undefined {
    if (!query?.start || !query?.end) return undefined;
    return { start: parseDate(query.start), end: parseDate(query.end) };
  }
}
