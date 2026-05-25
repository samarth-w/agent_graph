// ─── Date utilities for financial calculations ─────────────────

import { DateRange, RecurrenceFrequency } from '../models/types';

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function startOfYear(date: Date): Date {
  return new Date(date.getFullYear(), 0, 1);
}

export function endOfYear(date: Date): Date {
  return new Date(date.getFullYear(), 11, 31, 23, 59, 59, 999);
}

export function getCurrentMonthRange(): DateRange {
  const now = new Date();
  return { start: startOfMonth(now), end: endOfMonth(now) };
}

export function getCurrentYearRange(): DateRange {
  const now = new Date();
  return { start: startOfYear(now), end: endOfYear(now) };
}

export function getMonthRange(year: number, month: number): DateRange {
  const start = new Date(year, month, 1);
  return { start, end: endOfMonth(start) };
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

export function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

export function getNextOccurrence(lastDate: Date, frequency: RecurrenceFrequency, interval: number): Date {
  switch (frequency) {
    case 'daily': return addDays(lastDate, interval);
    case 'weekly': return addDays(lastDate, interval * 7);
    case 'biweekly': return addDays(lastDate, interval * 14);
    case 'monthly': return addMonths(lastDate, interval);
    case 'yearly': return addYears(lastDate, interval);
  }
}

export function isDateInRange(date: Date, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}

export function daysBetween(a: Date, b: Date): number {
  const msPerDay = 86400000;
  return Math.abs(Math.floor((b.getTime() - a.getTime()) / msPerDay));
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function parseDate(str: string): Date {
  const d = new Date(str);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${str}`);
  return d;
}
