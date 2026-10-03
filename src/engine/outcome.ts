/**
 * Pure outcome derivation: RNG result(s) → tier → grid → independent evaluation.
 *
 * This is deliberately a pure function of (par sheet, model state, RNG
 * results) so the identical code path is used live and for replay.
 */

import type { ParSheet, SymbolId } from '../config/parSheet.js';
import { buildLosingGrid, buildWinningGrid, evaluateGrid, type Evaluation } from '../math/grid.js';
import { FinitePoolModel, WeightedTierModel, type OutcomeModel, type TierDraw } from '../math/outcomeModel.js';
import { RandomStream } from '../rng/randomStream.js';
import { parseRngResult } from '../rng/resultString.js';
import { RngError, type RngResult, type RngResultParser } from '../rng/types.js';
import type { GameRecord } from './gameRecord.js';

export class OutcomeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeIntegrityError';
  }
}

export interface DerivedOutcome {
  readonly source: 'RNG_VALUES' | 'RNG_TICKET';
  readonly draw: TierDraw | null;
  readonly grid: SymbolId[];
  readonly evaluation: Extract<Evaluation, { valid: true }>;
  readonly ticketSerial: string | null;
  readonly valuesConsumed: number;
  readonly rejections: number;
}

/**
 * Derives the outcome from already-parsed RNG results.
 * Throws RngError('RNG_EXHAUSTED') if more values are needed (caller tops up
 * and calls again with the extra result appended — derivation restarts from
 * the first value, so it stays a pure function of the full value sequence).
 */
export function deriveOutcome(ps: ParSheet, model: OutcomeModel, results: readonly RngResult[]): DerivedOutcome {
  const first = results[0];
  if (!first) throw new RngError('RNG_EXHAUSTED', 'no RNG results');

  if (first.kind === 'ticket') {
    if (results.length !== 1) throw new OutcomeIntegrityError('ticket result cannot be combined with other results');
    const grid = [...first.grid.toUpperCase()];
    const ev = evaluateGrid(ps, grid);
    if (!ev.valid) throw new OutcomeIntegrityError(`supplied ticket rejected: ${ev.reason}`);
    if (first.declaredSymbol !== null) {
      const d = first.declaredSymbol.trim().toUpperCase();
      const declared = d === '' || d === 'LOSE' || d === 'NONE' ? null : d;
      if (declared !== ev.winningSymbol)
        throw new OutcomeIntegrityError(
          `supplied ticket declares ${declared ?? 'no win'} but grid evaluates to ${ev.winningSymbol ?? 'no win'}`,
        );
    }
    return {
      source: 'RNG_TICKET',
      draw: null,
      grid: grid as SymbolId[],
      evaluation: ev,
      ticketSerial: first.ticketSerial,
      valuesConsumed: 0,
      rejections: 0,
    };
  }

  const values: number[] = [];
  for (const r of results) {
    if (r.kind !== 'values') throw new OutcomeIntegrityError('cannot mix ticket and value results');
    values.push(...r.values);
  }
  const stream = new RandomStream(values);
  const draw = model.drawTier(stream);
  const grid = draw.symbol === null ? buildLosingGrid(ps, stream) : buildWinningGrid(ps, draw.symbol, stream);
  const ev = evaluateGrid(ps, grid);
  // Construction and evaluation are independent; they must agree or the game is void.
  if (!ev.valid) throw new OutcomeIntegrityError(`constructed grid invalid: ${ev.reason}`);
  if (ev.winningSymbol !== draw.symbol)
    throw new OutcomeIntegrityError(`tier ${draw.symbol ?? 'LOSE'} built grid evaluating to ${ev.winningSymbol ?? 'LOSE'}`);
  return {
    source: 'RNG_VALUES',
    draw,
    grid,
    evaluation: ev,
    ticketSerial: null,
    valuesConsumed: stream.consumed,
    rejections: stream.rejections,
  };
}

export interface ReplayResult {
  readonly matches: boolean;
  readonly grid: SymbolId[];
  readonly prizeCents: number;
  readonly differences: string[];
}

/**
 * Independently re-derives a stored game from its raw RNG strings and checks
 * it against the record (game recall / regulator verification).
 */
export function replayGame(
  ps: ParSheet,
  record: GameRecord,
  parsers?: readonly RngResultParser[],
): ReplayResult {
  const results = record.rng.rawResults.map((r) => parseRngResult(r, parsers));
  const model: OutcomeModel =
    record.model.kind === 'FINITE_POOL' ? new FinitePoolModel(ps, record.model.poolBefore) : new WeightedTierModel(ps);
  const d = deriveOutcome(ps, model, results);
  const diffs: string[] = [];
  if (record.grid && d.grid.join('') !== record.grid.join('')) diffs.push(`grid ${d.grid.join('')} != ${record.grid.join('')}`);
  if (d.evaluation.prizeCents !== record.prizeCents) diffs.push(`prize ${d.evaluation.prizeCents} != ${record.prizeCents}`);
  if (d.evaluation.winningSymbol !== record.winningSymbol)
    diffs.push(`symbol ${d.evaluation.winningSymbol} != ${record.winningSymbol}`);
  if (d.draw && record.model.drawIndex !== null && d.draw.drawIndex !== record.model.drawIndex)
    diffs.push(`drawIndex ${d.draw.drawIndex} != ${record.model.drawIndex}`);
  return { matches: diffs.length === 0, grid: d.grid, prizeCents: d.evaluation.prizeCents, differences: diffs };
}
