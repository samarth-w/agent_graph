/** Main game loop — ties everything together */
import { createGame, makeMove, undoMove } from './game';
import { getBestMove, createAiConfig, simulateAiThinking } from './ai';
import { renderBoard, renderStatus, renderMoveHistory, clearScreen, defaultRenderOptions } from './renderer';
import { createStats, updateStats, formatStats } from './stats';
import { parseInput, validateMove, parseCommand } from './input';
import type { GameState, AiConfig } from './types';

const renderOpts = defaultRenderOptions();

export async function startGame(vsAi = true, difficulty: AiConfig['difficulty'] = 'hard') {
  const aiConfig = createAiConfig(difficulty);
  let state = createGame();
  let stats = createStats();

  console.log('🎮 Tic-Tac-Toe');
  console.log('Type "help" for commands\n');
  displayBoard(state);

  // Simulate a full game for demo purposes
  while (!state.winner && !state.isDraw) {
    if (vsAi && state.currentPlayer === 'O') {
      // AI turn
      await simulateAiThinking(aiConfig);
      const aiMove = getBestMove(state.board, 'O', aiConfig);
      state = makeMove(state, aiMove.row, aiMove.col);
    } else {
      // For demo: pick first available move
      const move = getBestMove(state.board, state.currentPlayer, createAiConfig('medium'));
      state = makeMove(state, move.row, move.col);
    }
    displayBoard(state);
  }

  stats = updateStats(stats, state);
  console.log(formatStats(stats));
  return state;
}

function displayBoard(state: GameState): void {
  console.log(renderBoard(state.board));
  console.log(renderStatus(state.currentPlayer, state.winner, state.isDraw, renderOpts));
  console.log(`Moves played: ${state.moves.length}\n`);
}

function handleCommand(cmd: string, state: GameState, stats: ReturnType<typeof createStats>) {
  const parsed = parseCommand(cmd);

  switch (parsed.type) {
    case 'quit':
      console.log('Thanks for playing!');
      return { state, stats, quit: true };

    case 'undo':
      try {
        state = undoMove(state);
        displayBoard(state);
      } catch (e: any) {
        console.log(e.message);
      }
      return { state, stats, quit: false };

    case 'restart':
      state = createGame();
      displayBoard(state);
      return { state, stats, quit: false };

    case 'stats':
      console.log(formatStats(stats));
      return { state, stats, quit: false };

    case 'history':
      console.log(renderMoveHistory(state.moves, renderOpts));
      return { state, stats, quit: false };

    case 'help':
      printHelp();
      return { state, stats, quit: false };

    case 'move': {
      const input = parseInput(parsed.args[0]);
      if (!input) {
        console.log('Invalid input. Use "row col" (e.g. "1 2") or position 0-8');
        return { state, stats, quit: false };
      }
      const validation = validateMove(state.board, input.row, input.col);
      if (!validation.valid) {
        console.log(validation.error);
        return { state, stats, quit: false };
      }
      state = makeMove(state, input.row, input.col);
      displayBoard(state);
      if (state.winner || state.isDraw) {
        stats = updateStats(stats, state);
      }
      return { state, stats, quit: false };
    }

    default:
      return { state, stats, quit: false };
  }
}

function printHelp(): void {
  console.log(`
Commands:
  <row> <col>  Make a move (e.g. "1 2")
  <0-8>        Make a move by position
  undo (u)     Undo last move
  restart (r)  Start a new game
  stats (s)    Show game statistics
  history      Show move history
  help (h)     Show this help
  quit (q)     Exit the game
`);
}

// Entry point
startGame(true, 'hard').catch(console.error);
