/** Game statistics — tracking wins, losses, averages */
import type { GameState, GameStats, Player } from './types';
import { getGameDuration } from './game';

export function createStats(): GameStats {
  return { totalGames: 0, xWins: 0, oWins: 0, draws: 0, averageMoves: 0 };
}

export function updateStats(stats: GameStats, state: GameState): GameStats {
  const totalMoves = stats.averageMoves * stats.totalGames + state.moves.length;
  const newTotal = stats.totalGames + 1;

  return {
    totalGames: newTotal,
    xWins: stats.xWins + (state.winner === 'X' ? 1 : 0),
    oWins: stats.oWins + (state.winner === 'O' ? 1 : 0),
    draws: stats.draws + (state.isDraw ? 1 : 0),
    averageMoves: totalMoves / newTotal,
  };
}

export function getWinRate(stats: GameStats, player: Player): number {
  if (stats.totalGames === 0) return 0;
  const wins = player === 'X' ? stats.xWins : stats.oWins;
  return (wins / stats.totalGames) * 100;
}

export function formatStats(stats: GameStats): string {
  const lines = [
    '┌─────────────────────────┐',
    '│     Game Statistics      │',
    '├─────────────────────────┤',
    `│ Total Games:    ${String(stats.totalGames).padStart(6)} │`,
    `│ X Wins:         ${String(stats.xWins).padStart(6)} │`,
    `│ O Wins:         ${String(stats.oWins).padStart(6)} │`,
    `│ Draws:          ${String(stats.draws).padStart(6)} │`,
    `│ Avg Moves:      ${stats.averageMoves.toFixed(1).padStart(6)} │`,
    `│ X Win Rate:   ${getWinRate(stats, 'X').toFixed(1).padStart(5)}% │`,
    `│ O Win Rate:   ${getWinRate(stats, 'O').toFixed(1).padStart(5)}% │`,
    '└─────────────────────────┘',
  ];
  return lines.join('\n');
}
