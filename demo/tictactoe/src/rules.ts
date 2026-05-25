/** Win detection and game-over logic */
import type { Board, Player } from './types';
import { isBoardFull } from './board';

const LINES = [
  // rows
  [[0,0],[0,1],[0,2]],
  [[1,0],[1,1],[1,2]],
  [[2,0],[2,1],[2,2]],
  // columns
  [[0,0],[1,0],[2,0]],
  [[0,1],[1,1],[2,1]],
  [[0,2],[1,2],[2,2]],
  // diagonals
  [[0,0],[1,1],[2,2]],
  [[0,2],[1,1],[2,0]],
];

export function checkWinner(board: Board): Player | null {
  for (const line of LINES) {
    const [a, b, c] = line;
    const va = board[a[0]][a[1]];
    const vb = board[b[0]][b[1]];
    const vc = board[c[0]][c[1]];
    if (va && va === vb && vb === vc) return va;
  }
  return null;
}

export function isGameOver(board: Board): boolean {
  return checkWinner(board) !== null || isBoardFull(board);
}

export function getWinningLine(board: Board): number[][] | null {
  for (const line of LINES) {
    const [a, b, c] = line;
    const va = board[a[0]][a[1]];
    const vb = board[b[0]][b[1]];
    const vc = board[c[0]][c[1]];
    if (va && va === vb && vb === vc) return line;
  }
  return null;
}

export function evaluateBoard(board: Board): number {
  const winner = checkWinner(board);
  if (winner === 'X') return 10;
  if (winner === 'O') return -10;
  return 0;
}
