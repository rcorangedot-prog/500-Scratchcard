/**
 * Engine → UX message protocol.
 *
 * The UX is a pure presentation layer: it renders what these messages tell it
 * and sends player actions back to the engine. It never decides win/loss
 * (Dev Spec §9). Each message carries:
 *   - type       machine-readable event the UX switches on
 *   - messageId  stable catalog key for localisation (text is an English default)
 *   - cue        presentation cue (animation/sound) the UX should play
 *   - a11y       screen-reader text (Dev Spec §9 accessibility)
 *   - payload    typed data for that event
 *
 * Symbols are only ever sent for cells the player has revealed; the full grid
 * is never sent ahead of the reveal (Dev Spec §9 — no pre-fetch of outcomes).
 */

import type { SymbolId } from '../config/parSheet.js';

export type GameStatus = 'IDLE' | 'IN_PROGRESS' | 'REVEALED' | 'COMPLETE' | 'VOID';

export interface RevealedCell {
  readonly index: number;
  readonly row: number;
  readonly col: number;
  readonly symbol: SymbolId;
  readonly symbolName: string;
  readonly iconRef: string;
}

export interface UxPayloads {
  ENGINE_READY: { gameName: string; ticketPriceCents: number; currency: string; outcomeModel: string };
  GAME_RECOVERED: {
    ticketSerial: string;
    revealedCells: RevealedCell[];
    hiddenCellIndexes: number[];
    awaitingSettlement: boolean;
  };
  TICKET_PURCHASED: {
    ticketSerial: string;
    stakeCents: number;
    cellCount: number;
    rows: number;
    cols: number;
    balanceCents: number | null;
  };
  CELL_REVEALED: RevealedCell & { revealedCount: number; cellCount: number };
  ALL_CELLS_REVEALED: { grid: RevealedCell[] };
  RESULT_WIN: {
    winningSymbol: SymbolId;
    symbolName: string;
    iconRef: string;
    prizeCents: number;
    stakeCents: number;
    winningCells: number[];
    winLevel: WinLevel;
  };
  RESULT_NO_WIN: { stakeCents: number };
  PRIZE_CREDITED: { prizeCents: number; balanceCents: number | null };
  SETTLEMENT_PENDING: { prizeCents: number; reason: string };
  GAME_COMPLETE: { ticketSerial: string; prizeCents: number; status: GameStatus };
  INSUFFICIENT_FUNDS: { stakeCents: number; balanceCents: number | null };
  ACTION_REJECTED: { action: string; reason: string };
  MALFUNCTION: { code: string; stakeRefunded: boolean; ticketSerial: string | null };
}

export type UxMessageType = keyof UxPayloads;

/**
 * Win levels drive celebration intensity. A prize below the stake (tier A,
 * 0.50 on a 1.00 ticket) is presented as a partial return, not a "win"
 * celebration, so the UX never disguises a net loss as a win.
 */
export type WinLevel = 'PARTIAL_RETURN' | 'STAKE_BACK' | 'WIN' | 'BIG_WIN' | 'TOP_PRIZE';

export interface UxMessage<T extends UxMessageType = UxMessageType> {
  /** Monotonic per engine instance — the UX must process messages in order. */
  readonly seq: number;
  readonly type: T;
  readonly messageId: string;
  readonly text: string;
  readonly a11y: string;
  readonly cue: string | null;
  readonly gameRoundId: string | null;
  readonly timestamp: string;
  readonly payload: UxPayloads[T];
}

export type UxListener = (msg: UxMessage) => void;

/** Message catalog: id → default English template. Hosts localise by messageId. */
export const MESSAGE_CATALOG = {
  MSG_ENGINE_READY: 'Buy a ticket for {price} to play.',
  MSG_GAME_RECOVERED: 'Welcome back — your unfinished ticket {serial} has been restored.',
  MSG_TICKET_PURCHASED: 'Ticket {serial} purchased. Scratch the 9 panels to reveal your symbols.',
  MSG_CELL_REVEALED: '{symbol}',
  MSG_ALL_REVEALED: 'All panels revealed.',
  MSG_WIN_PARTIAL_RETURN: 'Three {symbol} symbols — you get {prize} back.',
  MSG_WIN_STAKE_BACK: 'Three {symbol} symbols — you win {prize}.',
  MSG_WIN: 'Three {symbol} symbols — you win {prize}!',
  MSG_WIN_BIG: 'Big win! Three {symbol} symbols — you win {prize}!',
  MSG_WIN_TOP_PRIZE: 'TOP PRIZE! Three {symbol} symbols — you win {prize}!',
  MSG_NO_WIN: 'No three matching symbols. Not a winner this time.',
  MSG_PRIZE_CREDITED: '{prize} has been added to your balance.',
  MSG_SETTLEMENT_PENDING: 'Your prize of {prize} is being processed and will be credited shortly.',
  MSG_GAME_COMPLETE: 'Game complete.',
  MSG_INSUFFICIENT_FUNDS: 'Insufficient balance to buy a {price} ticket.',
  MSG_ACTION_REJECTED: 'That action is not available right now.',
  MSG_MALFUNCTION: 'A malfunction occurred. This game has been voided{refund}. Malfunction voids all pays and plays.',
} as const;

export type MessageId = keyof typeof MESSAGE_CATALOG;

/** Presentation cues the UX maps to animations/sounds. */
export const CUES = {
  READY: 'cue.ready',
  RECOVERED: 'cue.recovered',
  PURCHASE: 'cue.ticket_purchase',
  SCRATCH: 'cue.scratch_cell',
  WIN_PARTIAL_RETURN: 'cue.win_partial_return',
  WIN_STAKE_BACK: 'cue.win_stake_back',
  WIN: 'cue.win',
  WIN_BIG: 'cue.win_big',
  WIN_TOP_PRIZE: 'cue.win_top_prize',
  NO_WIN: 'cue.no_win',
  CREDIT: 'cue.prize_credited',
  PENDING: 'cue.settlement_pending',
  COMPLETE: 'cue.game_complete',
  ERROR: 'cue.error',
  MALFUNCTION: 'cue.malfunction',
} as const;

export function renderTemplate(id: MessageId, params: Record<string, string> = {}): string {
  return MESSAGE_CATALOG[id].replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? '');
}

export function winLevelFor(prizeCents: number, stakeCents: number, maxPrizeCents: number): WinLevel {
  if (prizeCents >= maxPrizeCents) return 'TOP_PRIZE';
  if (prizeCents < stakeCents) return 'PARTIAL_RETURN';
  if (prizeCents === stakeCents) return 'STAKE_BACK';
  if (prizeCents >= stakeCents * 50) return 'BIG_WIN';
  return 'WIN';
}

export const WIN_LEVEL_PRESENTATION: Record<WinLevel, { messageId: MessageId; cue: string }> = {
  PARTIAL_RETURN: { messageId: 'MSG_WIN_PARTIAL_RETURN', cue: CUES.WIN_PARTIAL_RETURN },
  STAKE_BACK: { messageId: 'MSG_WIN_STAKE_BACK', cue: CUES.WIN_STAKE_BACK },
  WIN: { messageId: 'MSG_WIN', cue: CUES.WIN },
  BIG_WIN: { messageId: 'MSG_WIN_BIG', cue: CUES.WIN_BIG },
  TOP_PRIZE: { messageId: 'MSG_WIN_TOP_PRIZE', cue: CUES.WIN_TOP_PRIZE },
};

export type MoneyFormatter = (cents: number) => string;

export function defaultMoneyFormatter(currencySymbol = '$'): MoneyFormatter {
  return (cents) => {
    const neg = cents < 0;
    const abs = Math.abs(cents);
    const units = Math.floor(abs / 100).toLocaleString('en-US');
    return `${neg ? '-' : ''}${currencySymbol}${units}.${String(abs % 100).padStart(2, '0')}`;
  };
}
