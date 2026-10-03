/**
 * Par Sheet configuration for the 3x3 Symbol Match instant game.
 *
 * Source of truth: par_sheet_3x3_symbol_match.xlsx ("Par Sheet" and
 * "Symbol Legend" tabs). Any change to prizes or winner counts must be made in
 * the workbook first and then reflected here; validateParSheet() refuses to
 * run the engine if the declared totals no longer reconcile (Dev Spec §4).
 *
 * All money is held in integer minor units (cents) so that payout and RTP
 * arithmetic is exact — no floating point rounding in any value that is paid.
 */

export const SYMBOL_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;
export type SymbolId = (typeof SYMBOL_IDS)[number];

export interface PrizeTier {
  /** Par Sheet symbol code A–I. */
  readonly symbol: SymbolId;
  /** Display name of the icon (Symbol Legend tab). */
  readonly name: string;
  /** Asset reference the UX resolves to an icon; never hardcoded client-side (Dev Spec §9). */
  readonly iconRef: string;
  /** Prize paid for 3+ of this symbol, in minor units. */
  readonly prizeCents: number;
  /** Exact number of winning tickets for this tier per pool of `totalTickets`. */
  readonly targetWinners: number;
}

export interface ParSheet {
  readonly gameId: string;
  readonly gameName: string;
  readonly parSheetVersion: string;
  readonly ticketPriceCents: number;
  /** Tickets per production run / finite pool. */
  readonly totalTickets: number;
  readonly gridRows: number;
  readonly gridCols: number;
  /** Minimum count of one symbol that makes a winning ticket. */
  readonly matchCount: number;
  readonly tiers: readonly PrizeTier[];
  /** Declared totals copied from the workbook — used to reconcile, never to compute. */
  readonly declared: {
    readonly totalWinners: number;
    readonly totalPayoutCents: number;
    /** RTP in basis points (7500 = 75.00%). */
    readonly rtpBasisPoints: number;
  };
}

export const PAR_SHEET_3X3: ParSheet = Object.freeze({
  gameId: 'SC-3X3-SYMBOL-MATCH',
  gameName: '3×3 Symbol Match',
  parSheetVersion: '1.0',
  ticketPriceCents: 100,
  totalTickets: 1_000_000,
  gridRows: 3,
  gridCols: 3,
  matchCount: 3,
  tiers: Object.freeze([
    { symbol: 'A', name: 'Cherry', iconRef: 'icon.cherry', prizeCents: 50, targetWinners: 150_000 },
    { symbol: 'B', name: 'Bell', iconRef: 'icon.bell', prizeCents: 100, targetWinners: 60_000 },
    { symbol: 'C', name: 'Clover', iconRef: 'icon.clover', prizeCents: 200, targetWinners: 30_000 },
    { symbol: 'D', name: 'Star', iconRef: 'icon.star', prizeCents: 500, targetWinners: 12_000 },
    { symbol: 'E', name: 'Horseshoe', iconRef: 'icon.horseshoe', prizeCents: 1_000, targetWinners: 6_000 },
    { symbol: 'F', name: 'Diamond', iconRef: 'icon.diamond', prizeCents: 2_000, targetWinners: 4_000 },
    { symbol: 'G', name: 'Crown', iconRef: 'icon.crown', prizeCents: 5_000, targetWinners: 2_000 },
    { symbol: 'H', name: 'Wild Card 7', iconRef: 'icon.wild7', prizeCents: 10_000, targetWinners: 1_000 },
    { symbol: 'I', name: 'Jackpot Coin', iconRef: 'icon.jackpot_coin', prizeCents: 50_000, targetWinners: 310 },
  ] satisfies PrizeTier[]),
  declared: Object.freeze({
    totalWinners: 265_310,
    totalPayoutCents: 75_000_000,
    rtpBasisPoints: 7_500,
  }),
});

export class ParSheetError extends Error {
  constructor(readonly problems: string[]) {
    super(`Par sheet failed validation: ${problems.join('; ')}`);
    this.name = 'ParSheetError';
  }
}

/** Derived, reconciled figures used by the engine and the rules screen. */
export interface ParSheetSummary {
  readonly cellCount: number;
  readonly totalWinners: number;
  readonly totalLosers: number;
  readonly totalPayoutCents: number;
  readonly totalRevenueCents: number;
  /** Exact RTP as a rational: payout / revenue. */
  readonly rtp: number;
  readonly maxPrizeCents: number;
  readonly minPrizeCents: number;
}

export function summarizeParSheet(ps: ParSheet): ParSheetSummary {
  const totalWinners = ps.tiers.reduce((a, t) => a + t.targetWinners, 0);
  const totalPayoutCents = ps.tiers.reduce((a, t) => a + t.prizeCents * t.targetWinners, 0);
  const totalRevenueCents = ps.ticketPriceCents * ps.totalTickets;
  return {
    cellCount: ps.gridRows * ps.gridCols,
    totalWinners,
    totalLosers: ps.totalTickets - totalWinners,
    totalPayoutCents,
    totalRevenueCents,
    rtp: totalPayoutCents / totalRevenueCents,
    maxPrizeCents: Math.max(...ps.tiers.map((t) => t.prizeCents)),
    minPrizeCents: Math.min(...ps.tiers.map((t) => t.prizeCents)),
  };
}

/**
 * Validates the configuration. The engine must refuse to start on any problem
 * (Dev Spec §4, Developer Action List Phase 1).
 */
export function validateParSheet(ps: ParSheet): ParSheetSummary {
  const problems: string[] = [];
  const isPosInt = (n: number) => Number.isSafeInteger(n) && n > 0;

  if (!isPosInt(ps.ticketPriceCents)) problems.push('ticketPriceCents must be a positive integer');
  if (!isPosInt(ps.totalTickets)) problems.push('totalTickets must be a positive integer');
  if (!isPosInt(ps.gridRows) || !isPosInt(ps.gridCols)) problems.push('grid dimensions must be positive integers');
  if (!isPosInt(ps.matchCount)) problems.push('matchCount must be a positive integer');

  const cellCount = ps.gridRows * ps.gridCols;
  const symbolCount = ps.tiers.length;
  const seen = new Set<string>();
  for (const t of ps.tiers) {
    if (!(SYMBOL_IDS as readonly string[]).includes(t.symbol)) problems.push(`unknown symbol ${t.symbol}`);
    if (seen.has(t.symbol)) problems.push(`duplicate symbol ${t.symbol}`);
    seen.add(t.symbol);
    if (!isPosInt(t.prizeCents)) problems.push(`tier ${t.symbol}: prizeCents must be a positive integer`);
    if (!Number.isSafeInteger(t.targetWinners) || t.targetWinners < 0)
      problems.push(`tier ${t.symbol}: targetWinners must be a non-negative integer`);
    if (!t.iconRef) problems.push(`tier ${t.symbol}: iconRef is required`);
  }

  // Grid feasibility: a losing grid needs every symbol at most (matchCount-1)
  // times, and a winning grid needs the 8 other symbols to fill the rest the
  // same way. If the symbol set is too small, a ticket can't be built.
  const maxNonWinning = (symbolCount - 1) * (ps.matchCount - 1);
  if (cellCount > symbolCount * (ps.matchCount - 1)) problems.push('symbol set too small to build a losing grid');
  if (cellCount - ps.matchCount > maxNonWinning) problems.push('symbol set too small to build a winning grid');
  if (ps.matchCount > cellCount) problems.push('matchCount exceeds cell count');

  const s = summarizeParSheet(ps);
  if (s.totalWinners > ps.totalTickets) problems.push('Σ targetWinners exceeds totalTickets');
  if (s.totalWinners !== ps.declared.totalWinners)
    problems.push(`total winners ${s.totalWinners} != declared ${ps.declared.totalWinners}`);
  if (s.totalPayoutCents !== ps.declared.totalPayoutCents)
    problems.push(`total payout ${s.totalPayoutCents} != declared ${ps.declared.totalPayoutCents}`);
  // RTP check in integer arithmetic: payout * 10000 == bp * revenue
  if (s.totalPayoutCents * 10_000 !== ps.declared.rtpBasisPoints * s.totalRevenueCents)
    problems.push(`RTP ${(s.rtp * 100).toFixed(4)}% != declared ${(ps.declared.rtpBasisPoints / 100).toFixed(2)}%`);

  if (problems.length) throw new ParSheetError(problems);
  return s;
}

export function tierFor(ps: ParSheet, symbol: SymbolId): PrizeTier {
  const t = ps.tiers.find((x) => x.symbol === symbol);
  if (!t) throw new Error(`No tier for symbol ${symbol}`);
  return t;
}

/** Canonical JSON for hashing/signing the configuration (stable key order). */
export function canonicalParSheetJson(ps: ParSheet): string {
  return JSON.stringify({
    gameId: ps.gameId,
    parSheetVersion: ps.parSheetVersion,
    ticketPriceCents: ps.ticketPriceCents,
    totalTickets: ps.totalTickets,
    grid: [ps.gridRows, ps.gridCols],
    matchCount: ps.matchCount,
    tiers: ps.tiers.map((t) => [t.symbol, t.prizeCents, t.targetWinners]),
  });
}
