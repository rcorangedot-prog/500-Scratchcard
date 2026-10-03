/**
 * ScratchcardEngine — GLI-19-aligned game engine for the 3x3 Symbol Match game.
 *
 * Game cycle (one game at a time per engine instance / player session):
 *
 *   IDLE ──buyTicket()──► wager debited ──► RNG result requested & verified
 *        ──► outcome derived + independently evaluated ──► COMMITTED (persisted)
 *        ──► TICKET_PURCHASED sent to UX (no symbols)
 *   IN_PROGRESS ──revealCell()/revealAll()──► CELL_REVEALED per cell
 *   all cells revealed ──► REVEALED: ALL_CELLS_REVEALED + RESULT_WIN / RESULT_NO_WIN
 *        ──► prize credited ──► COMPLETE: GAME_COMPLETE ──► IDLE
 *
 * Key guarantees:
 *  - The outcome is fixed and persisted before anything is shown; the reveal
 *    order/speed chosen by the player cannot change it.
 *  - The UX only ever receives symbols for cells already revealed.
 *  - Any RNG, integrity or persistence failure before commit voids the game
 *    and refunds the stake ("malfunction voids all pays and plays").
 *  - An interrupted game (crash, disconnect) is restored on start() to the
 *    exact same outcome and reveal state, and settlement is retried
 *    idempotently.
 *  - Every action is serialised, so overlapping UX calls cannot race.
 */

import {
  PAR_SHEET_3X3,
  type ParSheet,
  type ParSheetSummary,
  type SymbolId,
  tierFor,
  validateParSheet,
} from '../config/parSheet.js';
import { FinitePoolModel, WeightedTierModel, type OutcomeModel } from '../math/outcomeModel.js';
import { DEFAULT_PARSERS, parseRngResult } from '../rng/resultString.js';
import {
  RngError,
  type RngProvider,
  type RngRequest,
  type RngResult,
  type RngResultParser,
  type RngResultVerifier,
} from '../rng/types.js';
import {
  CUES,
  defaultMoneyFormatter,
  renderTemplate,
  WIN_LEVEL_PRESENTATION,
  winLevelFor,
  type MessageId,
  type MoneyFormatter,
  type RevealedCell,
  type UxListener,
  type UxMessage,
  type UxMessageType,
  type UxPayloads,
} from '../ux/messages.js';
import type { GameRecord } from './gameRecord.js';
import {
  InMemoryPersistence,
  randomUuidIds,
  systemClock,
  type AuditEvent,
  type AuditHook,
  type ClockHook,
  type EngineSnapshot,
  type IdHook,
  type PersistenceHook,
  type WalletHook,
} from './hooks.js';
import { deriveOutcome, replayGame, type DerivedOutcome, type ReplayResult } from './outcome.js';

export const ENGINE_VERSION = '1.0.0';

export interface EngineOptions {
  /** RNG hook — the certified RNG's result strings drive every outcome. */
  readonly rng: RngProvider;
  readonly parSheet?: ParSheet;
  /** Extra/replacement result-string parsers for the RNG vendor's wire format. */
  readonly parsers?: readonly RngResultParser[];
  /** Authenticity check of each raw result string (signature/HMAC). */
  readonly verifier?: RngResultVerifier;
  /** 'FINITE_POOL' (default, par-sheet exact) or 'WEIGHTED' (per-play probability). */
  readonly outcomeModel?: 'FINITE_POOL' | 'WEIGHTED';
  /** Accept pre-determined ticket results from the RNG/central system. Default true. */
  readonly acceptTicketResults?: boolean;
  /** Refuse to start with an uncertified RNG provider. Default true. */
  readonly requireCertifiedRng?: boolean;
  readonly persistence?: PersistenceHook;
  readonly wallet?: WalletHook;
  readonly audit?: AuditHook;
  readonly clock?: ClockHook;
  readonly ids?: IdHook;
  /** Completed games kept for player game recall. Default 10. */
  readonly historySize?: number;
  /** 32-bit values requested per RNG call. Default 32 (a game typically uses ~11). */
  readonly rngValuesPerRequest?: number;
  readonly rngTimeoutMs?: number;
  readonly maxRngTopUps?: number;
  readonly currency?: string;
  readonly formatMoney?: MoneyFormatter;
  readonly onMessage?: UxListener;
}

export interface PublicGameView {
  readonly gameRoundId: string;
  readonly ticketSerial: string;
  readonly status: GameRecord['status'];
  readonly stakeCents: number;
  readonly revealedCells: RevealedCell[];
  readonly hiddenCellIndexes: number[];
  /** Only populated once every cell is revealed. */
  readonly result: { winningSymbol: SymbolId | null; prizeCents: number; winningCells: number[] } | null;
}

export interface PaytableRow {
  readonly symbol: SymbolId;
  readonly name: string;
  readonly iconRef: string;
  readonly prizeCents: number;
  readonly prize: string;
  readonly winnersPerPool: number;
  readonly odds: string;
}

export interface GameRules {
  readonly gameName: string;
  readonly ticketPrice: string;
  readonly howToPlay: string[];
  readonly paytable: PaytableRow[];
  readonly overallOdds: string;
  readonly returnToPlayer: string;
  readonly maxPrize: string;
  readonly notes: string[];
}

type Status = 'NOT_STARTED' | 'IDLE' | 'IN_PROGRESS' | 'REVEALED';

export class ScratchcardEngine {
  private readonly ps: ParSheet;
  private readonly summary: ParSheetSummary;
  private readonly parsers: readonly RngResultParser[];
  private readonly persistence: PersistenceHook;
  private readonly clock: ClockHook;
  private readonly ids: IdHook;
  private readonly fmt: MoneyFormatter;
  private readonly historySize: number;
  private readonly cellCount: number;

  private model: OutcomeModel;
  private current: GameRecord | null = null;
  private history: GameRecord[] = [];
  private ticketCounter = 0;
  private started = false;
  private msgSeq = 0;
  private readonly listeners = new Set<UxListener>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: EngineOptions) {
    this.ps = opts.parSheet ?? PAR_SHEET_3X3;
    this.summary = validateParSheet(this.ps); // refuse to construct on a bad par sheet
    this.cellCount = this.summary.cellCount;
    this.parsers = opts.parsers ? [...opts.parsers, ...DEFAULT_PARSERS] : DEFAULT_PARSERS;
    this.persistence = opts.persistence ?? new InMemoryPersistence();
    this.clock = opts.clock ?? systemClock;
    this.ids = opts.ids ?? randomUuidIds;
    this.fmt = opts.formatMoney ?? defaultMoneyFormatter(opts.currency ?? '$');
    this.historySize = opts.historySize ?? 10;
    this.model = this.newModel(null);
    if (opts.onMessage) this.listeners.add(opts.onMessage);
  }

  // ===================================================================== UX wiring

  /** Subscribe the UX to engine messages. Returns an unsubscribe function. */
  subscribe(listener: UxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ===================================================================== lifecycle

  /** Validates configuration, restores persisted state and recovers any interrupted game. */
  start(): Promise<void> {
    return this.run(async () => {
      if (this.started) return;
      if (!this.opts.rng.certified && this.opts.requireCertifiedRng !== false)
        throw new RngError('RNG_UNCERTIFIED', `RNG provider ${this.opts.rng.rngId} is not certified`);

      const snap = await this.persistence.load();
      if (snap) {
        if (snap.gameId !== this.ps.gameId || snap.parSheetVersion !== this.ps.parSheetVersion)
          throw new Error(
            `persisted state is for ${snap.gameId} v${snap.parSheetVersion}, engine configured for ${this.ps.gameId} v${this.ps.parSheetVersion}`,
          );
        if (snap.outcomeModel !== this.model.kind)
          throw new Error(`persisted outcome model ${snap.outcomeModel} != configured ${this.model.kind}`);
        this.model = this.newModel(snap);
        this.ticketCounter = snap.ticketCounter;
        this.history = [...snap.history];
        this.current = snap.currentGame;
      }
      this.started = true;
      await this.audit('ENGINE_STARTED', null, {
        engineVersion: ENGINE_VERSION,
        gameId: this.ps.gameId,
        parSheetVersion: this.ps.parSheetVersion,
        outcomeModel: this.model.kind,
        rngId: this.opts.rng.rngId,
        rngCertified: this.opts.rng.certified,
      });
      this.emit('ENGINE_READY', 'MSG_ENGINE_READY', CUES.READY, null, { price: this.fmt(this.ps.ticketPriceCents) }, {
        gameName: this.ps.gameName,
        ticketPriceCents: this.ps.ticketPriceCents,
        currency: this.opts.currency ?? '$',
        outcomeModel: this.model.kind,
      });
      if (this.current) await this.recover(this.current);
    });
  }

  private async recover(g: GameRecord): Promise<void> {
    if (g.status === 'IN_PROGRESS' && !g.grid) {
      // Cannot happen with a well-behaved persistence hook (we persist only after commit).
      await this.voidGame(g, 'RECOVERY_WITHOUT_OUTCOME');
      return;
    }
    await this.audit('GAME_RECOVERED', g.gameRoundId, { status: g.status, ticketSerial: g.ticketSerial });
    this.emit('GAME_RECOVERED', 'MSG_GAME_RECOVERED', CUES.RECOVERED, g.gameRoundId, { serial: g.ticketSerial }, {
      ticketSerial: g.ticketSerial,
      revealedCells: this.revealedCells(g),
      hiddenCellIndexes: this.hiddenIndexes(g),
      awaitingSettlement: g.status === 'REVEALED',
    });
    if (g.status === 'REVEALED') {
      this.emitResult(g);
      await this.settle(g);
    }
  }

  // ===================================================================== player actions

  /**
   * Buys a ticket: debits the stake, obtains the outcome from the RNG and
   * commits it. Resolves to the public view (no symbols), or null if the
   * purchase was declined or voided (the UX has been told why).
   */
  buyTicket(opts: { playerId?: string } = {}): Promise<PublicGameView | null> {
    return this.run(async () => {
      this.assertStarted();
      if (this.current?.status === 'REVEALED') await this.settle(this.current);
      if (this.current) {
        this.reject('buyTicket', 'GAME_IN_PROGRESS');
        return null;
      }

      const now = this.nowIso();
      const g = this.newRecord(opts.playerId ?? 'anonymous', now);

      // 1. Wager
      let balanceCents: number | null = null;
      if (this.opts.wallet) {
        const res = await this.opts.wallet.debit(this.tx(g, 'debit', g.stakeCents));
        if (!res.ok) {
          await this.audit('WAGER_DECLINED', g.gameRoundId, { reason: res.reason });
          if (res.reason === 'INSUFFICIENT_FUNDS')
            this.emit(
              'INSUFFICIENT_FUNDS',
              'MSG_INSUFFICIENT_FUNDS',
              CUES.ERROR,
              null,
              { price: this.fmt(g.stakeCents) },
              { stakeCents: g.stakeCents, balanceCents: res.balanceCents ?? null },
            );
          else this.reject('buyTicket', `WALLET_${res.reason}`);
          return null;
        }
        balanceCents = res.balanceCents;
      }
      g.settlement.debited = true;
      await this.audit('WAGER_ACCEPTED', g.gameRoundId, { playerId: g.playerId, stakeCents: g.stakeCents });

      // 2. Outcome — derive, commit to the model, persist. Roll back on any failure.
      const modelBefore = this.model.snapshot();
      const counterBefore = this.ticketCounter;
      try {
        const d = await this.obtainOutcome(g);
        g.outcomeSource = d.source;
        g.grid = d.grid;
        g.winningSymbol = d.evaluation.winningSymbol;
        g.prizeCents = d.evaluation.prizeCents;
        g.winningCells = [...d.evaluation.winningCells];
        g.rng.valuesConsumed = d.valuesConsumed;
        g.rng.rejections = d.rejections;
        g.model.poolBefore = modelBefore;
        g.model.drawIndex = d.draw?.drawIndex ?? null;
        g.model.drawRange = d.draw?.drawRange ?? null;
        g.timestamps.outcomeAt = this.nowIso();
        if (d.draw) this.model.commit(d.draw);
        this.ticketCounter++;
        g.ticketSerial = d.ticketSerial ?? this.serialFor(this.ticketCounter);
        this.current = g;
        await this.persist();
      } catch (err) {
        this.model = this.newModel({ pool: modelBefore });
        this.ticketCounter = counterBefore;
        this.current = null;
        await this.voidGame(g, errorCode(err), err);
        return null;
      }

      await this.audit('OUTCOME_COMMITTED', g.gameRoundId, {
        ticketSerial: g.ticketSerial,
        outcomeSource: g.outcomeSource,
        tier: g.winningSymbol ?? 'LOSE',
        prizeCents: g.prizeCents,
        rngId: g.rng.rngId,
        rngSequences: g.rng.sequences,
        drawIndex: g.model.drawIndex,
        drawRange: g.model.drawRange,
      });
      if (this.model instanceof FinitePoolModel && this.model.remainingTickets === 0)
        await this.audit('POOL_CYCLE_COMPLETED', g.gameRoundId, this.model.snapshot() as unknown as Record<string, unknown>);

      this.emit('TICKET_PURCHASED', 'MSG_TICKET_PURCHASED', CUES.PURCHASE, g.gameRoundId, { serial: g.ticketSerial }, {
        ticketSerial: g.ticketSerial,
        stakeCents: g.stakeCents,
        cellCount: this.cellCount,
        rows: this.ps.gridRows,
        cols: this.ps.gridCols,
        balanceCents,
      });
      return this.view(g);
    });
  }

  /** Player scratches one panel (row-major index 0–8). */
  revealCell(index: number): Promise<void> {
    return this.run(async () => {
      this.assertStarted();
      const g = this.current;
      if (!g || g.status !== 'IN_PROGRESS') return this.reject('revealCell', 'NO_GAME_IN_PROGRESS');
      if (!Number.isInteger(index) || index < 0 || index >= this.cellCount)
        return this.reject('revealCell', 'INVALID_CELL');
      if (g.revealed[index]) return this.reject('revealCell', 'ALREADY_REVEALED');
      g.revealed[index] = true;
      await this.persist();
      await this.audit('CELL_REVEALED', g.gameRoundId, { index });
      this.emitCell(g, index);
      if (g.revealed.every(Boolean)) await this.finalize(g);
    });
  }

  /** "Reveal all" button — reveals remaining panels in row-major order. */
  revealAll(): Promise<void> {
    return this.run(async () => {
      this.assertStarted();
      const g = this.current;
      if (!g || g.status !== 'IN_PROGRESS') return this.reject('revealAll', 'NO_GAME_IN_PROGRESS');
      await this.revealRemaining(g);
    });
  }

  /**
   * Host/server-side completion of an abandoned game (e.g. after a session
   * timeout): reveals all panels and settles. Outcome is unchanged.
   */
  completeInterruptedGame(): Promise<void> {
    return this.run(async () => {
      this.assertStarted();
      const g = this.current;
      if (!g) return;
      if (g.status === 'IN_PROGRESS') await this.revealRemaining(g);
      else if (g.status === 'REVEALED') await this.settle(g);
    });
  }

  /** Retries a prize credit that the wallet previously failed. */
  retrySettlement(): Promise<boolean> {
    return this.run(async () => {
      this.assertStarted();
      if (this.current?.status !== 'REVEALED') return false;
      return this.settle(this.current);
    });
  }

  // ===================================================================== queries

  getStatus(): { status: Status; game: PublicGameView | null } {
    if (!this.started) return { status: 'NOT_STARTED', game: null };
    if (!this.current) return { status: 'IDLE', game: null };
    return { status: this.current.status === 'REVEALED' ? 'REVEALED' : 'IN_PROGRESS', game: this.view(this.current) };
  }

  /** Completed/void games, newest first — for the player's game-recall screen. */
  getHistory(): GameRecord[] {
    return this.history.map((g) => structuredClone(g));
  }

  /** Re-derives a stored game from its raw RNG strings (audit / dispute resolution). */
  replay(record: GameRecord): ReplayResult {
    return replayGame(this.ps, record, this.parsers);
  }

  /** Rules, paytable and disclosures for the help screen. */
  getRules(): GameRules {
    const ps = this.ps;
    const odds = (n: number) => `1 in ${(ps.totalTickets / n).toFixed(2)}`;
    return {
      gameName: ps.gameName,
      ticketPrice: this.fmt(ps.ticketPriceCents),
      howToPlay: [
        `Each ticket costs ${this.fmt(ps.ticketPriceCents)} and has a ${ps.gridRows}×${ps.gridCols} grid of ${this.cellCount} hidden panels.`,
        'Scratch each panel, or use Reveal All, to uncover your symbols.',
        `Find ${ps.matchCount} or more of the same symbol anywhere in the grid to win the prize shown for that symbol.`,
        'Only one prize can be won per ticket.',
      ],
      paytable: ps.tiers.map((t) => ({
        symbol: t.symbol,
        name: t.name,
        iconRef: t.iconRef,
        prizeCents: t.prizeCents,
        prize: this.fmt(t.prizeCents),
        winnersPerPool: t.targetWinners,
        odds: odds(t.targetWinners),
      })),
      overallOdds: odds(this.summary.totalWinners),
      returnToPlayer: `${(this.summary.rtp * 100).toFixed(2)}%`,
      maxPrize: this.fmt(this.summary.maxPrizeCents),
      notes: [
        'The outcome of each ticket is determined by a certified random number generator at the moment of purchase, before any panel is revealed. The order or speed in which panels are revealed does not affect the result.',
        this.model.kind === 'FINITE_POOL'
          ? `Odds are based on a pool of ${ps.totalTickets.toLocaleString('en-US')} tickets containing exactly the number of prizes shown.`
          : `Odds shown are the probability of each prize on every ticket.`,
        'If play is interrupted, your ticket is restored with the same outcome when you return.',
        'Malfunction voids all pays and plays.',
      ],
    };
  }

  // ===================================================================== internals

  private async obtainOutcome(g: GameRecord): Promise<DerivedOutcome> {
    const rng = this.opts.rng;
    const max = this.opts.maxRngTopUps ?? 3;
    const results: RngResult[] = [];
    for (let attempt = 0; ; attempt++) {
      const req: RngRequest = {
        requestId: `${g.gameRoundId}:${attempt}`,
        gameId: this.ps.gameId,
        gameRoundId: g.gameRoundId,
        purpose: attempt === 0 ? 'GAME_OUTCOME' : 'GAME_OUTCOME_TOPUP',
        count: this.opts.rngValuesPerRequest ?? 32,
        requestedAt: this.nowIso(),
      };
      await this.audit('RNG_REQUESTED', g.gameRoundId, { requestId: req.requestId, count: req.count, rngId: rng.rngId });
      let raw: string;
      try {
        raw = await withTimeout(Promise.resolve().then(() => rng.getResult(req)), this.opts.rngTimeoutMs ?? 5_000);
      } catch (err) {
        if (err instanceof RngError) throw err;
        throw new RngError('RNG_UNAVAILABLE', `RNG provider failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      g.rng.requestIds.push(req.requestId);
      g.rng.rawResults.push(raw);
      await this.audit('RNG_RESULT_RECEIVED', g.gameRoundId, { requestId: req.requestId, raw });

      if (this.opts.verifier && !(await this.opts.verifier.verify(raw, req)))
        throw new RngError('RNG_VERIFY_FAILED', 'RNG result failed authenticity verification');
      const parsed = parseRngResult(raw, this.parsers);
      if (parsed.requestId !== req.requestId)
        throw new RngError('RNG_REQUEST_MISMATCH', `result is for ${parsed.requestId}, expected ${req.requestId}`);
      if (parsed.rngId !== rng.rngId)
        throw new RngError('RNG_REQUEST_MISMATCH', `result from RNG ${parsed.rngId}, expected ${rng.rngId}`);
      if (parsed.kind === 'ticket' && this.opts.acceptTicketResults === false)
        throw new RngError('RNG_PARSE_FAILED', 'ticket results are disabled');
      g.rng.sequences.push(parsed.sequence);
      results.push(parsed);

      try {
        return deriveOutcome(this.ps, this.model, results);
      } catch (err) {
        if (err instanceof RngError && err.code === 'RNG_EXHAUSTED' && attempt < max) continue;
        throw err;
      }
    }
  }

  private async revealRemaining(g: GameRecord): Promise<void> {
    const newly = this.hiddenIndexes(g);
    for (const i of newly) g.revealed[i] = true;
    await this.persist();
    for (const i of newly) {
      await this.audit('CELL_REVEALED', g.gameRoundId, { index: i });
      this.emitCell(g, i);
    }
    await this.finalize(g);
  }

  private async finalize(g: GameRecord): Promise<void> {
    g.status = 'REVEALED';
    g.timestamps.revealedAt = this.nowIso();
    await this.persist();
    await this.audit('GAME_REVEALED', g.gameRoundId, { tier: g.winningSymbol ?? 'LOSE', prizeCents: g.prizeCents });
    this.emit('ALL_CELLS_REVEALED', 'MSG_ALL_REVEALED', null, g.gameRoundId, {}, { grid: this.revealedCells(g) });
    this.emitResult(g);
    await this.settle(g);
  }

  /** Credits the prize (idempotent transaction id) and completes the game. */
  private async settle(g: GameRecord): Promise<boolean> {
    let balanceCents: number | null = null;
    if (g.prizeCents > 0 && !g.settlement.credited) {
      if (this.opts.wallet) {
        let res;
        try {
          res = await this.opts.wallet.credit(this.tx(g, 'credit', g.prizeCents));
        } catch (err) {
          res = { ok: false as const, reason: 'ERROR' as const, detail: String(err) };
        }
        if (!res.ok) {
          await this.audit('SETTLEMENT_FAILED', g.gameRoundId, { reason: res.reason, prizeCents: g.prizeCents });
          this.emit(
            'SETTLEMENT_PENDING',
            'MSG_SETTLEMENT_PENDING',
            CUES.PENDING,
            g.gameRoundId,
            { prize: this.fmt(g.prizeCents) },
            { prizeCents: g.prizeCents, reason: res.reason },
          );
          return false;
        }
        balanceCents = res.balanceCents;
      }
      g.settlement.credited = true;
      await this.audit('PRIZE_CREDITED', g.gameRoundId, { prizeCents: g.prizeCents });
      this.emit('PRIZE_CREDITED', 'MSG_PRIZE_CREDITED', CUES.CREDIT, g.gameRoundId, { prize: this.fmt(g.prizeCents) }, {
        prizeCents: g.prizeCents,
        balanceCents,
      });
    }
    g.status = 'COMPLETE';
    g.timestamps.completedAt = this.nowIso();
    this.pushHistory(g);
    this.current = null;
    await this.persist();
    await this.audit('GAME_COMPLETED', g.gameRoundId, { prizeCents: g.prizeCents });
    this.emit('GAME_COMPLETE', 'MSG_GAME_COMPLETE', CUES.COMPLETE, g.gameRoundId, {}, {
      ticketSerial: g.ticketSerial,
      prizeCents: g.prizeCents,
      status: 'COMPLETE',
    });
    return true;
  }

  private async voidGame(g: GameRecord, code: string, err?: unknown): Promise<void> {
    g.status = 'VOID';
    g.voidReason = err instanceof Error ? `${code}: ${err.message}` : code;
    g.grid = null; // never retain/show an outcome from a voided game
    g.prizeCents = 0;
    g.winningSymbol = null;
    g.winningCells = [];
    g.timestamps.completedAt = this.nowIso();
    let refunded = false;
    if (g.settlement.debited && this.opts.wallet) {
      try {
        const r = await this.opts.wallet.refund(this.tx(g, 'refund', g.stakeCents));
        refunded = r.ok;
      } catch {
        refunded = false;
      }
    } else if (g.settlement.debited) {
      refunded = true; // no wallet hook: host settles externally from the VOID record
    }
    g.settlement.refunded = refunded;
    this.pushHistory(g);
    try {
      await this.persist();
    } catch {
      /* best effort — the audit trail below still records the void */
    }
    await this.audit('GAME_VOIDED', g.gameRoundId, { reason: g.voidReason, refunded });
    this.emit(
      'MALFUNCTION',
      'MSG_MALFUNCTION',
      CUES.MALFUNCTION,
      g.gameRoundId,
      { refund: refunded ? ' and your stake has been refunded' : '' },
      { code, stakeRefunded: refunded, ticketSerial: null },
    );
  }

  private emitCell(g: GameRecord, index: number): void {
    const cell = this.cell(g, index);
    const revealedCount = g.revealed.filter(Boolean).length;
    this.emit(
      'CELL_REVEALED',
      'MSG_CELL_REVEALED',
      CUES.SCRATCH,
      g.gameRoundId,
      { symbol: cell.symbolName },
      { ...cell, revealedCount, cellCount: this.cellCount },
      `Row ${cell.row + 1}, column ${cell.col + 1}: ${cell.symbolName}. ${revealedCount} of ${this.cellCount} revealed.`,
    );
  }

  private emitResult(g: GameRecord): void {
    if (g.winningSymbol) {
      const tier = tierFor(this.ps, g.winningSymbol);
      const level = winLevelFor(g.prizeCents, g.stakeCents, this.summary.maxPrizeCents);
      const pres = WIN_LEVEL_PRESENTATION[level];
      this.emit(
        'RESULT_WIN',
        pres.messageId,
        pres.cue,
        g.gameRoundId,
        { symbol: tier.name, prize: this.fmt(g.prizeCents) },
        {
          winningSymbol: g.winningSymbol,
          symbolName: tier.name,
          iconRef: tier.iconRef,
          prizeCents: g.prizeCents,
          stakeCents: g.stakeCents,
          winningCells: [...g.winningCells],
          winLevel: level,
        },
      );
    } else {
      this.emit('RESULT_NO_WIN', 'MSG_NO_WIN', CUES.NO_WIN, g.gameRoundId, {}, { stakeCents: g.stakeCents });
    }
  }

  private reject(action: string, reason: string): void {
    this.emit('ACTION_REJECTED', 'MSG_ACTION_REJECTED', null, this.current?.gameRoundId ?? null, {}, { action, reason });
  }

  private emit<T extends UxMessageType>(
    type: T,
    messageId: MessageId,
    cue: string | null,
    gameRoundId: string | null,
    params: Record<string, string>,
    payload: UxPayloads[T],
    a11y?: string,
  ): void {
    const text = renderTemplate(messageId, params);
    const msg: UxMessage<T> = Object.freeze({
      seq: ++this.msgSeq,
      type,
      messageId,
      text,
      a11y: a11y ?? text,
      cue,
      gameRoundId,
      timestamp: this.nowIso(),
      payload,
    });
    for (const l of this.listeners) {
      try {
        l(msg as UxMessage);
      } catch {
        /* a faulty UX listener must never break the game cycle */
      }
    }
  }

  private cell(g: GameRecord, index: number): RevealedCell {
    const symbol = g.grid![index]!;
    const tier = tierFor(this.ps, symbol);
    return {
      index,
      row: Math.floor(index / this.ps.gridCols),
      col: index % this.ps.gridCols,
      symbol,
      symbolName: tier.name,
      iconRef: tier.iconRef,
    };
  }

  private revealedCells(g: GameRecord): RevealedCell[] {
    if (!g.grid) return [];
    return g.revealed.flatMap((r, i) => (r ? [this.cell(g, i)] : []));
  }

  private hiddenIndexes(g: GameRecord): number[] {
    return g.revealed.flatMap((r, i) => (r ? [] : [i]));
  }

  private view(g: GameRecord): PublicGameView {
    const done = g.status === 'REVEALED' || g.status === 'COMPLETE';
    return {
      gameRoundId: g.gameRoundId,
      ticketSerial: g.ticketSerial,
      status: g.status,
      stakeCents: g.stakeCents,
      revealedCells: this.revealedCells(g),
      hiddenCellIndexes: this.hiddenIndexes(g),
      result: done ? { winningSymbol: g.winningSymbol, prizeCents: g.prizeCents, winningCells: [...g.winningCells] } : null,
    };
  }

  private newRecord(playerId: string, now: string): GameRecord {
    return {
      gameRoundId: this.ids.newGameRoundId(),
      ticketSerial: '',
      playerId,
      stakeCents: this.ps.ticketPriceCents,
      status: 'IN_PROGRESS',
      grid: null,
      revealed: new Array<boolean>(this.cellCount).fill(false),
      winningSymbol: null,
      prizeCents: 0,
      winningCells: [],
      outcomeSource: null,
      rng: {
        rngId: this.opts.rng.rngId,
        certified: this.opts.rng.certified,
        requestIds: [],
        rawResults: [],
        sequences: [],
        valuesConsumed: 0,
        rejections: 0,
      },
      model: { kind: this.model.kind, drawIndex: null, drawRange: null, poolBefore: null },
      parSheet: { gameId: this.ps.gameId, version: this.ps.parSheetVersion },
      engineVersion: ENGINE_VERSION,
      settlement: { debited: false, credited: false, refunded: false },
      timestamps: { wagerAt: now, outcomeAt: null, revealedAt: null, completedAt: null },
      voidReason: null,
    };
  }

  private newModel(snap: Pick<EngineSnapshot, 'pool'> | null): OutcomeModel {
    return (this.opts.outcomeModel ?? 'FINITE_POOL') === 'FINITE_POOL'
      ? new FinitePoolModel(this.ps, snap?.pool ?? null)
      : new WeightedTierModel(this.ps);
  }

  private serialFor(n: number): string {
    const cycle = this.model.snapshot()?.poolCycle ?? 0;
    return `${this.ps.gameId}-${String(cycle).padStart(3, '0')}-${String(n).padStart(9, '0')}`;
  }

  private tx(g: GameRecord, action: string, amountCents: number) {
    return { transactionId: `${g.gameRoundId}:${action}`, gameRoundId: g.gameRoundId, playerId: g.playerId, amountCents };
  }

  private pushHistory(g: GameRecord): void {
    this.history.unshift(g);
    if (this.history.length > this.historySize) this.history.length = this.historySize;
  }

  private persist(): Promise<void> {
    const snap: EngineSnapshot = {
      schemaVersion: 1,
      gameId: this.ps.gameId,
      parSheetVersion: this.ps.parSheetVersion,
      outcomeModel: this.model.kind,
      ticketCounter: this.ticketCounter,
      pool: this.model.snapshot(),
      currentGame: this.current ? structuredClone(this.current) : null,
      history: this.history.map((h) => structuredClone(h)),
    };
    return this.persistence.save(snap);
  }

  private async audit(type: AuditEvent['type'], gameRoundId: string | null, data: Record<string, unknown>) {
    if (!this.opts.audit) return;
    await this.opts.audit.record({ type, at: this.nowIso(), gameRoundId, data });
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('engine not started — call start() first');
  }

  /** Serialises all actions so concurrent UX calls cannot interleave. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

function errorCode(err: unknown): string {
  if (err instanceof RngError) return err.code;
  if (err instanceof Error && err.name === 'OutcomeIntegrityError') return 'OUTCOME_INTEGRITY';
  return 'ENGINE_FAULT';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RngError('RNG_TIMEOUT', `RNG did not respond within ${ms}ms`)), ms);
    }),
  ]);
}
