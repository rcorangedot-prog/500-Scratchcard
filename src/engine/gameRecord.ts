/**
 * The persisted record of one game round. It contains everything needed to
 * (a) resume an interrupted game, (b) show game recall to the player, and
 * (c) let an auditor replay the outcome from the stored raw RNG strings.
 */

import type { SymbolId } from '../config/parSheet.js';
import type { PoolState } from '../math/outcomeModel.js';

export type GameRecordStatus = 'IN_PROGRESS' | 'REVEALED' | 'COMPLETE' | 'VOID';

export interface GameRecord {
  readonly gameRoundId: string;
  ticketSerial: string;
  readonly playerId: string;
  readonly stakeCents: number;
  status: GameRecordStatus;

  /** Server-side only until revealed; never sent to the UX ahead of reveal. */
  grid: SymbolId[] | null;
  revealed: boolean[];
  winningSymbol: SymbolId | null;
  prizeCents: number;
  winningCells: number[];

  outcomeSource: 'RNG_VALUES' | 'RNG_TICKET' | null;
  rng: {
    rngId: string;
    certified: boolean;
    requestIds: string[];
    /** Raw result strings exactly as returned by the RNG, in order. */
    rawResults: string[];
    sequences: (string | null)[];
    valuesConsumed: number;
    rejections: number;
  };
  model: {
    kind: string;
    drawIndex: number | null;
    drawRange: number | null;
    /** Pool state immediately before this game's draw (FINITE_POOL only) — needed for replay. */
    poolBefore: PoolState | null;
  };
  readonly parSheet: { gameId: string; version: string };
  readonly engineVersion: string;

  settlement: { debited: boolean; credited: boolean; refunded: boolean };
  timestamps: {
    wagerAt: string;
    outcomeAt: string | null;
    revealedAt: string | null;
    completedAt: string | null;
  };
  voidReason: string | null;
}
