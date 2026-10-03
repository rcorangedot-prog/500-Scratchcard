/**
 * Reconciliation of realised outcomes against the Par Sheet (Dev Spec AC-1,
 * AC-3, AC-8).
 */

import { type ParSheet, summarizeParSheet } from '../config/parSheet.js';

export interface TierReconciliation {
  readonly symbol: string;
  readonly expected: number;
  readonly actual: number;
  readonly prizeCents: number;
  readonly payoutCents: number;
}

export interface ReconciliationReport {
  readonly tickets: number;
  readonly tiers: TierReconciliation[];
  readonly losers: { expected: number; actual: number };
  readonly totalWinners: number;
  readonly totalPayoutCents: number;
  readonly revenueCents: number;
  readonly rtp: number;
  /** True only for a complete pool that matches the Par Sheet exactly. */
  readonly exactMatch: boolean;
  readonly problems: string[];
}

/** `counts` maps symbol → realised winners, plus "LOSE" → realised losers. */
export function reconcile(ps: ParSheet, counts: Readonly<Record<string, number>>): ReconciliationReport {
  const s = summarizeParSheet(ps);
  const problems: string[] = [];
  let totalWinners = 0;
  let totalPayoutCents = 0;
  const tiers = ps.tiers.map((t) => {
    const actual = counts[t.symbol] ?? 0;
    totalWinners += actual;
    totalPayoutCents += actual * t.prizeCents;
    if (actual !== t.targetWinners) problems.push(`tier ${t.symbol}: ${actual} != ${t.targetWinners}`);
    return { symbol: t.symbol, expected: t.targetWinners, actual, prizeCents: t.prizeCents, payoutCents: actual * t.prizeCents };
  });
  const losers = counts.LOSE ?? 0;
  if (losers !== s.totalLosers) problems.push(`losers: ${losers} != ${s.totalLosers}`);
  const tickets = totalWinners + losers;
  const revenueCents = tickets * ps.ticketPriceCents;
  if (totalPayoutCents !== ps.declared.totalPayoutCents)
    problems.push(`payout ${totalPayoutCents} != ${ps.declared.totalPayoutCents}`);
  return {
    tickets,
    tiers,
    losers: { expected: s.totalLosers, actual: losers },
    totalWinners,
    totalPayoutCents,
    revenueCents,
    rtp: revenueCents ? totalPayoutCents / revenueCents : 0,
    exactMatch: problems.length === 0,
    problems,
  };
}
