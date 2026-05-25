// ─── CSV import/export for transactions ─────────────────────────

import { Transaction, Currency, TransactionType } from '../models/types';
import { TransactionService } from '../services/transaction-service';
import { formatMoney, roundMoney } from '../utils/validation';
import { formatDate, parseDate } from '../utils/dates';

export interface CsvRow {
  date: string;
  type: string;
  amount: string;
  currency: string;
  category: string;
  description: string;
  tags: string;
  account: string;
}

export function transactionsToCsv(transactions: Transaction[]): string {
  const header = 'Date,Type,Amount,Currency,Category,Description,Tags,Account';
  const rows = transactions.map(tx =>
    [
      formatDate(tx.date),
      tx.type,
      tx.amount.amount.toString(),
      tx.amount.currency,
      tx.categoryId,
      `"${tx.description.replace(/"/g, '""')}"`,
      tx.tags.join(';'),
      tx.accountId,
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

export function importTransactionsFromCsv(
  csv: string,
  transactionService: TransactionService,
  defaultAccountId: string,
): ImportResult {
  const lines = csv.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return { imported: 0, errors: [], skipped: 0 };

  const result: ImportResult = { imported: 0, errors: [], skipped: 0 };

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    try {
      const fields = parseCsvLine(lines[i]);
      if (fields.length < 6) {
        result.errors.push({ line: i + 1, error: 'Too few fields' });
        continue;
      }

      const [dateStr, type, amountStr, currency, category, description, tagsStr] = fields;
      const accountId = fields[7] ?? defaultAccountId;

      const validTypes: TransactionType[] = ['income', 'expense', 'transfer'];
      if (!validTypes.includes(type as TransactionType)) {
        result.errors.push({ line: i + 1, error: `Invalid type: ${type}` });
        continue;
      }

      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) {
        result.errors.push({ line: i + 1, error: `Invalid amount: ${amountStr}` });
        continue;
      }

      const date = parseDate(dateStr);
      const tags = tagsStr ? tagsStr.split(';').filter(t => t.length > 0) : [];

      transactionService.recordTransaction(
        accountId,
        type as TransactionType,
        amount,
        (currency || 'USD') as Currency,
        category || 'uncategorized',
        description || '',
        date,
        tags,
      );

      result.imported++;
    } catch (err: any) {
      result.errors.push({ line: i + 1, error: err.message });
    }
  }

  return result;
}

export interface ImportResult {
  imported: number;
  errors: { line: number; error: string }[];
  skipped: number;
}
