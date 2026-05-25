/** Terminal renderer — draws the board to stdout */
import type { Board, Player, RenderOptions } from './types';
import { getWinningLine } from './rules';

export function defaultRenderOptions(): RenderOptions {
  return { colorEnabled: true, showCoordinates: true, cellWidth: 3 };
}

function colorize(text: string, color: string, enabled: boolean): string {
  if (!enabled) return text;
  const codes: Record<string, string> = {
    red: '\x1b[31m', blue: '\x1b[34m', green: '\x1b[32m',
    yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m',
    reset: '\x1b[0m',
  };
  return `${codes[color] ?? ''}${text}${codes.reset}`;
}

function formatCell(cell: Player | null, isWinning: boolean, opts: RenderOptions): string {
  if (!cell) return ' '.repeat(opts.cellWidth);
  const symbol = ` ${cell} `;
  if (isWinning) return colorize(symbol, 'green', opts.colorEnabled);
  return cell === 'X'
    ? colorize(symbol, 'red', opts.colorEnabled)
    : colorize(symbol, 'blue', opts.colorEnabled);
}

export function renderBoard(board: Board, opts?: Partial<RenderOptions>): string {
  const o = { ...defaultRenderOptions(), ...opts };
  const winLine = getWinningLine(board);
  const winCells = new Set(winLine?.map(([r,c]) => `${r},${c}`) ?? []);

  const lines: string[] = [];
  const sep = '───┼───┼───';

  if (o.showCoordinates) {
    lines.push(colorize('     0   1   2', 'dim', o.colorEnabled));
  }

  for (let r = 0; r < 3; r++) {
    if (r > 0) {
      const prefix = o.showCoordinates ? '   ' : '';
      lines.push(`${prefix}${sep}`);
    }
    const cells = board[r].map((cell, c) =>
      formatCell(cell, winCells.has(`${r},${c}`), o)
    );
    const prefix = o.showCoordinates
      ? colorize(` ${r} `, 'dim', o.colorEnabled)
      : '';
    lines.push(`${prefix}${cells.join('│')}`);
  }

  return lines.join('\n');
}

export function renderStatus(
  currentPlayer: Player,
  winner: Player | null,
  isDraw: boolean,
  opts: RenderOptions,
): string {
  if (winner) {
    return colorize(`🎉 Player ${winner} wins!`, 'green', opts.colorEnabled);
  }
  if (isDraw) {
    return colorize("It's a draw!", 'yellow', opts.colorEnabled);
  }
  const color = currentPlayer === 'X' ? 'red' : 'blue';
  return `Player ${colorize(currentPlayer, color, opts.colorEnabled)}'s turn`;
}

export function renderMoveHistory(
  moves: Array<{ row: number; col: number; player: Player }>,
  opts: RenderOptions,
): string {
  if (moves.length === 0) return 'No moves yet.';
  return moves.map((m, i) => {
    const color = m.player === 'X' ? 'red' : 'blue';
    return `${i + 1}. ${colorize(m.player, color, opts.colorEnabled)} → (${m.row}, ${m.col})`;
  }).join('\n');
}

export function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}
