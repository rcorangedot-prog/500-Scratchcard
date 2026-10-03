/**
 * Grid construction and win evaluation.
 *
 * Construction (Dev Spec §5, AC-2):
 *  - Winning grid: the tier symbol is placed in exactly `matchCount` cells
 *    chosen uniformly at random; every other cell is filled uniformly from the
 *    other symbols that are still below (matchCount-1) occurrences, so no
 *    second symbol can ever reach a winning count.
 *  - Losing grid: every cell is filled uniformly from the symbols still below
 *    (matchCount-1) occurrences.
 *
 * Fillers are drawn by chance alone. The engine never steers non-winning
 * symbols toward "near misses" (e.g. deliberately pairing the jackpot symbol);
 * whatever pairs appear are the unmanipulated result of the RNG.
 *
 * Evaluation is independent of construction and is what decides the prize:
 * every grid the engine builds or receives is re-counted before it is shown.
 */

import { type ParSheet, type SymbolId, tierFor } from '../config/parSheet.js';

export interface IntSource {
  nextInt(n: number): number;
}

export type Grid = readonly SymbolId[];

function fillCells(
  grid: (SymbolId | null)[],
  symbols: readonly SymbolId[],
  counts: Map<SymbolId, number>,
  maxPerSymbol: number,
  rng: IntSource,
): void {
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== null) continue;
    const allowed = symbols.filter((s) => (counts.get(s) ?? 0) < maxPerSymbol);
    // validateParSheet() guarantees feasibility; this is a defensive invariant.
    if (allowed.length === 0) throw new Error('grid construction infeasible');
    const s = allowed[rng.nextInt(allowed.length)]!;
    grid[i] = s;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
}

export function buildWinningGrid(ps: ParSheet, symbol: SymbolId, rng: IntSource): SymbolId[] {
  const cellCount = ps.gridRows * ps.gridCols;
  const grid: (SymbolId | null)[] = new Array<SymbolId | null>(cellCount).fill(null);

  // Partial Fisher–Yates: choose matchCount distinct cells for the winning symbol.
  const cells = Array.from({ length: cellCount }, (_, i) => i);
  for (let i = 0; i < ps.matchCount; i++) {
    const j = i + rng.nextInt(cellCount - i);
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
    grid[cells[i]!] = symbol;
  }

  const others = ps.tiers.map((t) => t.symbol).filter((s) => s !== symbol);
  fillCells(grid, others, new Map(), ps.matchCount - 1, rng);
  return grid as SymbolId[];
}

export function buildLosingGrid(ps: ParSheet, rng: IntSource): SymbolId[] {
  const cellCount = ps.gridRows * ps.gridCols;
  const grid: (SymbolId | null)[] = new Array<SymbolId | null>(cellCount).fill(null);
  fillCells(grid, ps.tiers.map((t) => t.symbol), new Map(), ps.matchCount - 1, rng);
  return grid as SymbolId[];
}

export type Evaluation =
  | {
      readonly valid: true;
      readonly isWinner: boolean;
      readonly winningSymbol: SymbolId | null;
      readonly prizeCents: number;
      /** Cell indexes (row-major) holding the winning symbol — for UX highlighting. */
      readonly winningCells: readonly number[];
      readonly counts: Readonly<Record<string, number>>;
    }
  | { readonly valid: false; readonly reason: string };

/** Counts symbols and applies the win rule (Game Spec §4). Independent of construction. */
export function evaluateGrid(ps: ParSheet, grid: readonly string[]): Evaluation {
  const cellCount = ps.gridRows * ps.gridCols;
  if (grid.length !== cellCount) return { valid: false, reason: `grid has ${grid.length} cells, expected ${cellCount}` };
  const known = new Set<string>(ps.tiers.map((t) => t.symbol));
  const counts: Record<string, number> = {};
  for (const s of grid) {
    if (!known.has(s)) return { valid: false, reason: `unknown symbol ${JSON.stringify(s)}` };
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const winners = Object.keys(counts).filter((s) => counts[s]! >= ps.matchCount) as SymbolId[];
  if (winners.length > 1)
    return { valid: false, reason: `multiple winning symbols (${winners.join(',')}) — multi-symbol conflict` };
  if (winners.length === 0)
    return { valid: true, isWinner: false, winningSymbol: null, prizeCents: 0, winningCells: [], counts };
  const sym = winners[0]!;
  return {
    valid: true,
    isWinner: true,
    winningSymbol: sym,
    prizeCents: tierFor(ps, sym).prizeCents,
    winningCells: grid.flatMap((s, i) => (s === sym ? [i] : [])),
    counts,
  };
}
