/** AI opponent — minimax with alpha-beta pruning */
import type { Board, Player, AiConfig } from './types';
import { getAvailableMoves, setCell, countMoves } from './board';
import { checkWinner, isGameOver, evaluateBoard } from './rules';

export function createAiConfig(difficulty: AiConfig['difficulty'] = 'hard'): AiConfig {
  const delays: Record<string, number> = { easy: 200, medium: 500, hard: 300 };
  return { difficulty, thinkingDelay: delays[difficulty] };
}

function minimax(
  board: Board,
  depth: number,
  isMaximizing: boolean,
  alpha: number,
  beta: number,
): number {
  const score = evaluateBoard(board);
  if (score !== 0) return score - (isMaximizing ? depth : -depth);
  if (isGameOver(board)) return 0;
  if (depth >= 9) return 0;

  const moves = getAvailableMoves(board);

  if (isMaximizing) {
    let best = -Infinity;
    for (const move of moves) {
      const newBoard = setCell(board, move.row, move.col, 'X');
      const val = minimax(newBoard, depth + 1, false, alpha, beta);
      best = Math.max(best, val);
      alpha = Math.max(alpha, val);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const move of moves) {
      const newBoard = setCell(board, move.row, move.col, 'O');
      const val = minimax(newBoard, depth + 1, true, alpha, beta);
      best = Math.min(best, val);
      beta = Math.min(beta, val);
      if (beta <= alpha) break;
    }
    return best;
  }
}

export function getBestMove(
  board: Board,
  player: Player,
  config: AiConfig,
): { row: number; col: number } {
  const moves = getAvailableMoves(board);
  if (moves.length === 0) throw new Error('No available moves');

  // Easy: random move
  if (config.difficulty === 'easy') {
    return randomMove(moves);
  }

  // Medium: 50% chance of random
  if (config.difficulty === 'medium' && Math.random() < 0.5) {
    return randomMove(moves);
  }

  // Hard: full minimax
  const isMaximizing = player === 'X';
  let bestScore = isMaximizing ? -Infinity : Infinity;
  let bestMove = moves[0];
  const depth = countMoves(board);

  for (const move of moves) {
    const newBoard = setCell(board, move.row, move.col, player);
    const score = minimax(newBoard, depth + 1, !isMaximizing, -Infinity, Infinity);

    if (isMaximizing ? score > bestScore : score < bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}

function randomMove(moves: Array<{ row: number; col: number }>): { row: number; col: number } {
  return moves[Math.floor(Math.random() * moves.length)];
}

export function simulateAiThinking(config: AiConfig): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, config.thinkingDelay));
}
