/** Shared types for the tic-tac-toe game */

export type Player = 'X' | 'O';
export type Cell = Player | null;
export type Board = Cell[][];

export interface Move {
  row: number;
  col: number;
  player: Player;
  timestamp: number;
}

export interface GameState {
  board: Board;
  currentPlayer: Player;
  winner: Player | null;
  isDraw: boolean;
  moves: Move[];
  startedAt: number;
}

export interface GameStats {
  totalGames: number;
  xWins: number;
  oWins: number;
  draws: number;
  averageMoves: number;
}

export interface AiConfig {
  difficulty: 'easy' | 'medium' | 'hard';
  thinkingDelay: number;
}

export interface RenderOptions {
  colorEnabled: boolean;
  showCoordinates: boolean;
  cellWidth: number;
}
