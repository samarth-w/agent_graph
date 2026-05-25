/** Board logic — creation, validation, state checks */
import type { Board, Cell, Player, Move } from './types';

export function createBoard(): Board {
  return [
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ];
}

export function cloneBoard(board: Board): Board {
  return board.map(row => [...row]);
}

export function getCell(board: Board, row: number, col: number): Cell {
  if (row < 0 || row > 2 || col < 0 || col > 2) return null;
  return board[row][col];
}

export function setCell(board: Board, row: number, col: number, player: Player): Board {
  const newBoard = cloneBoard(board);
  newBoard[row][col] = player;
  return newBoard;
}

export function isValidMove(board: Board, row: number, col: number): boolean {
  if (row < 0 || row > 2 || col < 0 || col > 2) return false;
  return board[row][col] === null;
}

export function getAvailableMoves(board: Board): Array<{ row: number; col: number }> {
  const moves: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (board[r][c] === null) moves.push({ row: r, col: c });
    }
  }
  return moves;
}

export function isBoardFull(board: Board): boolean {
  return getAvailableMoves(board).length === 0;
}

export function countMoves(board: Board): number {
  let count = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell !== null) count++;
    }
  }
  return count;
}
