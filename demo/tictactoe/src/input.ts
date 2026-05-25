/** Input validation and parsing for player moves */
import type { Board } from './types';
import { isValidMove } from './board';

export function parseInput(input: string): { row: number; col: number } | null {
  const cleaned = input.trim().replace(/[,\s]+/g, ' ');
  const parts = cleaned.split(' ');

  if (parts.length === 2) {
    const row = parseInt(parts[0], 10);
    const col = parseInt(parts[1], 10);
    if (!isNaN(row) && !isNaN(col)) return { row, col };
  }

  // Single number: treat as position 0-8
  if (parts.length === 1) {
    const pos = parseInt(parts[0], 10);
    if (!isNaN(pos) && pos >= 0 && pos <= 8) {
      return { row: Math.floor(pos / 3), col: pos % 3 };
    }
  }

  return null;
}

export function validateMove(
  board: Board,
  row: number,
  col: number,
): { valid: boolean; error?: string } {
  if (row < 0 || row > 2 || col < 0 || col > 2) {
    return { valid: false, error: 'Position out of bounds (use 0-2)' };
  }
  if (!isValidMove(board, row, col)) {
    return { valid: false, error: 'Cell is already occupied' };
  }
  return { valid: true };
}

export function parseCommand(input: string): { type: string; args: string[] } {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'quit' || trimmed === 'q') return { type: 'quit', args: [] };
  if (trimmed === 'undo' || trimmed === 'u') return { type: 'undo', args: [] };
  if (trimmed === 'restart' || trimmed === 'r') return { type: 'restart', args: [] };
  if (trimmed === 'stats' || trimmed === 's') return { type: 'stats', args: [] };
  if (trimmed === 'help' || trimmed === 'h') return { type: 'help', args: [] };
  if (trimmed === 'history') return { type: 'history', args: [] };
  return { type: 'move', args: [input] };
}
