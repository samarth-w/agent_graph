/** Game engine — manages state transitions and move history */
import type { GameState, Player, Move } from './types';
import { createBoard, setCell, isValidMove } from './board';
import { checkWinner, isGameOver } from './rules';

export function createGame(): GameState {
  return {
    board: createBoard(),
    currentPlayer: 'X',
    winner: null,
    isDraw: false,
    moves: [],
    startedAt: Date.now(),
  };
}

export function makeMove(state: GameState, row: number, col: number): GameState {
  if (state.winner || state.isDraw) {
    throw new Error('Game is already over');
  }
  if (!isValidMove(state.board, row, col)) {
    throw new Error(`Invalid move: (${row}, ${col})`);
  }

  const move: Move = {
    row,
    col,
    player: state.currentPlayer,
    timestamp: Date.now(),
  };

  const newBoard = setCell(state.board, row, col, state.currentPlayer);
  const winner = checkWinner(newBoard);
  const gameOver = isGameOver(newBoard);

  return {
    board: newBoard,
    currentPlayer: switchPlayer(state.currentPlayer),
    winner,
    isDraw: gameOver && !winner,
    moves: [...state.moves, move],
    startedAt: state.startedAt,
  };
}

export function undoMove(state: GameState): GameState {
  if (state.moves.length === 0) {
    throw new Error('No moves to undo');
  }

  const moves = state.moves.slice(0, -1);
  let board = createBoard();
  for (const m of moves) {
    board = setCell(board, m.row, m.col, m.player);
  }

  const winner = checkWinner(board);
  const gameOver = isGameOver(board);
  const lastPlayer = state.moves[state.moves.length - 1].player;

  return {
    board,
    currentPlayer: lastPlayer,
    winner,
    isDraw: gameOver && !winner,
    moves,
    startedAt: state.startedAt,
  };
}

function switchPlayer(player: Player): Player {
  return player === 'X' ? 'O' : 'X';
}

export function getGameDuration(state: GameState): number {
  const last = state.moves[state.moves.length - 1];
  return last ? last.timestamp - state.startedAt : 0;
}

export function replayMoves(moves: Move[]): GameState {
  let state = createGame();
  for (const m of moves) {
    state = makeMove(state, m.row, m.col);
  }
  return state;
}
