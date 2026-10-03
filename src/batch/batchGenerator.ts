/**
 * Fixed-pool batch generation (Dev Spec §5–7) — Node only.
 *
 *  1. Allocate exactly targetWinners per tier + the balancing losers.
 *  2. Fisher–Yates shuffle the pool with unbiased scaling from the RNG source.
 *  3. Build each ticket's grid (winning/losing construction rules).
 *  4. Assign sequential serials post-shuffle and an HMAC-SHA256 validation
 *     number over {ticket_id, batch_id, prize_tier} with a per-batch secret.
 *  5. Reconcile; the batch is "ready" only if it matches the Par Sheet exactly.
 *
 * Memory: the shuffled pool is held as one byte per ticket (tier index), and
 * tickets are streamed to the caller, so a 1,000,000 ticket batch needs ~1 MB
 * for the pool plus the validation-number uniqueness set.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { type ParSheet, type SymbolId, validateParSheet } from '../config/parSheet.js';
import { buildLosingGrid, buildWinningGrid, evaluateGrid } from '../math/grid.js';
import { reconcile, type ReconciliationReport } from '../math/reconcile.js';
import { type RandomSource, scaleUniform } from '../rng/randomStream.js';

export interface BatchTicket {
  readonly ticketId: string;
  readonly serialNumber: string;
  readonly validationNumber: string;
  readonly batchId: string;
  /** 9 symbols, row-major. */
  readonly grid: string;
  readonly winningSymbol: SymbolId | null;
  readonly prizeCents: number;
}

export interface BatchOptions {
  readonly batchId: string;
  /** Per-batch HMAC key from the secrets manager — never from source control. */
  readonly hmacKey: Uint8Array;
  readonly rng: RandomSource;
  /** Receives each ticket in serial order (e.g. write to DB / file). */
  readonly onTicket: (t: BatchTicket) => void;
  readonly serialPrefix?: string;
}

export interface BatchResult {
  readonly batchId: string;
  readonly ticketCount: number;
  readonly reconciliation: ReconciliationReport;
  readonly ready: boolean;
  readonly integrityErrors: number;
  readonly duplicateValidationNumbers: number;
}

const LOSE_INDEX = 255;

export function generateValidationNumber(key: Uint8Array, ticketId: string, batchId: string, tier: string): string {
  // 80 bits rendered as 20 hex chars, grouped for printing.
  const h = createHmac('sha256', key).update(`${ticketId}|${batchId}|${tier}`).digest('hex').slice(0, 20).toUpperCase();
  return h.match(/.{4}/g)!.join('-');
}

export function generateBatch(ps: ParSheet, opts: BatchOptions): BatchResult {
  validateParSheet(ps);
  if (opts.hmacKey.length < 32) throw new Error('hmacKey must be at least 256 bits');

  // 1. Allocation
  const pool = new Uint8Array(ps.totalTickets);
  let k = 0;
  ps.tiers.forEach((t, ti) => {
    pool.fill(ti, k, k + t.targetWinners);
    k += t.targetWinners;
  });
  pool.fill(LOSE_INDEX, k);

  // 2. Fisher–Yates shuffle (unbiased)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = scaleUniform(opts.rng, i + 1);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }

  // 3–4. Build, serialise, validate
  const intSrc = { nextInt: (n: number) => scaleUniform(opts.rng, n) };
  const counts: Record<string, number> = { LOSE: 0 };
  const seenValidation = new Set<string>();
  let integrityErrors = 0;
  let duplicates = 0;
  const prefix = opts.serialPrefix ?? ps.gameId;
  const width = String(ps.totalTickets).length;

  for (let i = 0; i < pool.length; i++) {
    const ti = pool[i]!;
    const symbol = ti === LOSE_INDEX ? null : ps.tiers[ti]!.symbol;
    const grid = symbol === null ? buildLosingGrid(ps, intSrc) : buildWinningGrid(ps, symbol, intSrc);
    const ev = evaluateGrid(ps, grid);
    if (!ev.valid || ev.winningSymbol !== symbol) integrityErrors++;
    const tierKey = symbol ?? 'LOSE';
    counts[tierKey] = (counts[tierKey] ?? 0) + 1;

    const ticketId = randomUUID();
    const validationNumber = generateValidationNumber(opts.hmacKey, ticketId, opts.batchId, tierKey);
    if (seenValidation.has(validationNumber)) duplicates++;
    seenValidation.add(validationNumber);

    opts.onTicket({
      ticketId,
      serialNumber: `${prefix}-${String(i + 1).padStart(width, '0')}`,
      validationNumber,
      batchId: opts.batchId,
      grid: grid.join(''),
      winningSymbol: ev.valid ? ev.winningSymbol : null,
      prizeCents: ev.valid ? ev.prizeCents : 0,
    });
  }

  // 5. Reconcile
  const reconciliation = reconcile(ps, counts);
  return {
    batchId: opts.batchId,
    ticketCount: pool.length,
    reconciliation,
    ready: reconciliation.exactMatch && integrityErrors === 0 && duplicates === 0,
    integrityErrors,
    duplicateValidationNumbers: duplicates,
  };
}
