/**
 * Outcome models — how one RNG draw selects the prize tier for a game.
 *
 * FinitePoolModel (default, Game Spec §5 / Dev Spec §5 "fixed-pool"):
 *   Holds the remaining count of each tier in the current pool of
 *   `totalTickets` (1,000,000). Each game draws uniformly from the remaining
 *   tickets and removes it. This is mathematically identical to dealing the
 *   next ticket from a pre-generated, cryptographically shuffled pool, so a
 *   completed pool reconciles to the Par Sheet EXACTLY (AC-1, AC-3) — while
 *   only storing 10 counters instead of a million grids. When a pool is
 *   exhausted a fresh pool begins (poolCycle + 1).
 *
 * WeightedTierModel ("live probability", matches the HTML simulator):
 *   Each game independently draws an integer in [0, totalTickets) and maps it
 *   through the cumulative winner counts. Every tier probability is exactly
 *   targetWinners / totalTickets; realized counts vary statistically.
 *
 * Both models draw with exact integer ranges via unbiased scaling.
 */

import type { ParSheet, SymbolId } from '../config/parSheet.js';
import type { IntSource } from './grid.js';

export interface TierDraw {
  /** Winning symbol, or null for a losing ticket. */
  readonly symbol: SymbolId | null;
  /** Position drawn within the model's range — recorded for replay/audit. */
  readonly drawIndex: number;
  readonly drawRange: number;
}

export interface PoolState {
  readonly poolCycle: number;
  /** Remaining tickets per symbol; key "LOSE" for non-winners. */
  readonly remaining: Readonly<Record<string, number>>;
}

export interface OutcomeModel {
  readonly kind: 'FINITE_POOL' | 'WEIGHTED';
  /** Pure: picks a tier from the current state without mutating it. */
  drawTier(rng: IntSource): TierDraw;
  /** Applies a committed draw (called only after the game is persisted). */
  commit(draw: TierDraw): void;
  snapshot(): PoolState | null;
}

const LOSE = 'LOSE';

function freshPool(ps: ParSheet): Record<string, number> {
  const r: Record<string, number> = {};
  let winners = 0;
  for (const t of ps.tiers) {
    r[t.symbol] = t.targetWinners;
    winners += t.targetWinners;
  }
  r[LOSE] = ps.totalTickets - winners;
  return r;
}

/** Ordered category list: tiers in par-sheet order, then LOSE. Fixed for replay. */
function categories(ps: ParSheet): string[] {
  return [...ps.tiers.map((t) => t.symbol), LOSE];
}

function pick(cats: string[], counts: Record<string, number>, idx: number): string {
  let acc = 0;
  for (const c of cats) {
    acc += counts[c] ?? 0;
    if (idx < acc) return c;
  }
  throw new Error('draw index out of range');
}

export class FinitePoolModel implements OutcomeModel {
  readonly kind = 'FINITE_POOL';
  private state: { poolCycle: number; remaining: Record<string, number> };
  private readonly cats: string[];

  constructor(
    private readonly ps: ParSheet,
    restored?: PoolState | null,
  ) {
    this.cats = categories(ps);
    this.state = restored
      ? { poolCycle: restored.poolCycle, remaining: { ...restored.remaining } }
      : { poolCycle: 1, remaining: freshPool(ps) };
    for (const c of this.cats) {
      const v = this.state.remaining[c];
      if (!Number.isSafeInteger(v) || v! < 0) throw new Error(`restored pool state invalid for ${c}`);
    }
  }

  private total(): number {
    return this.cats.reduce((a, c) => a + this.state.remaining[c]!, 0);
  }

  drawTier(rng: IntSource): TierDraw {
    let counts = this.state.remaining;
    let range = this.total();
    if (range === 0) {
      counts = freshPool(this.ps);
      range = this.ps.totalTickets;
    }
    const drawIndex = rng.nextInt(range);
    const c = pick(this.cats, counts, drawIndex);
    return { symbol: c === LOSE ? null : (c as SymbolId), drawIndex, drawRange: range };
  }

  commit(draw: TierDraw): void {
    if (this.total() === 0) this.state = { poolCycle: this.state.poolCycle + 1, remaining: freshPool(this.ps) };
    const key = draw.symbol ?? LOSE;
    if ((this.state.remaining[key] ?? 0) <= 0) throw new Error(`pool has no remaining ${key} tickets`);
    this.state.remaining[key]!--;
  }

  snapshot(): PoolState {
    return { poolCycle: this.state.poolCycle, remaining: { ...this.state.remaining } };
  }

  /** Tickets left in the current pool cycle. */
  get remainingTickets(): number {
    return this.total();
  }
}

export class WeightedTierModel implements OutcomeModel {
  readonly kind = 'WEIGHTED';
  private readonly cats: string[];
  private readonly counts: Record<string, number>;

  constructor(private readonly ps: ParSheet) {
    this.cats = categories(ps);
    this.counts = freshPool(ps);
  }

  drawTier(rng: IntSource): TierDraw {
    const drawIndex = rng.nextInt(this.ps.totalTickets);
    const c = pick(this.cats, this.counts, drawIndex);
    return { symbol: c === LOSE ? null : (c as SymbolId), drawIndex, drawRange: this.ps.totalTickets };
  }

  commit(): void {}

  snapshot(): null {
    return null;
  }
}
