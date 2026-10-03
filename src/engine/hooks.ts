/**
 * Host-platform hooks. The engine owns game rules and state; the host owns
 * money, storage, logging and identity. All hooks are optional except the
 * RNG provider (see rng/types.ts); defaults are in-memory and suitable for
 * development/testing only.
 */

import type { PoolState } from '../math/outcomeModel.js';
import type { GameRecord } from './gameRecord.js';

// ---------------------------------------------------------------- wallet

export interface WalletTransaction {
  /** Deterministic per game + action → the wallet MUST treat it as idempotent. */
  readonly transactionId: string;
  readonly gameRoundId: string;
  readonly playerId: string;
  readonly amountCents: number;
}

export type WalletResult =
  | { readonly ok: true; readonly balanceCents: number | null }
  | {
      readonly ok: false;
      readonly reason: 'INSUFFICIENT_FUNDS' | 'REJECTED' | 'ERROR';
      readonly balanceCents?: number | null;
    };

export interface WalletHook {
  debit(tx: WalletTransaction): Promise<WalletResult>;
  credit(tx: WalletTransaction): Promise<WalletResult>;
  refund(tx: WalletTransaction): Promise<WalletResult>;
}

// ---------------------------------------------------------------- persistence

export interface EngineSnapshot {
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly parSheetVersion: string;
  readonly outcomeModel: string;
  readonly ticketCounter: number;
  readonly pool: PoolState | null;
  /** Game in progress (null when idle). Restored on start-up for recovery. */
  readonly currentGame: GameRecord | null;
  /** Most recent completed/void games, newest first (game recall). */
  readonly history: readonly GameRecord[];
}

/**
 * Durable storage. save() must not resolve until the snapshot is durable:
 * the engine relies on it to commit an outcome BEFORE anything is shown.
 */
export interface PersistenceHook {
  load(): Promise<EngineSnapshot | null>;
  save(snapshot: EngineSnapshot): Promise<void>;
}

// ---------------------------------------------------------------- audit

export type AuditEventType =
  | 'ENGINE_STARTED'
  | 'GAME_RECOVERED'
  | 'WAGER_ACCEPTED'
  | 'WAGER_DECLINED'
  | 'RNG_REQUESTED'
  | 'RNG_RESULT_RECEIVED'
  | 'OUTCOME_COMMITTED'
  | 'CELL_REVEALED'
  | 'GAME_REVEALED'
  | 'PRIZE_CREDITED'
  | 'SETTLEMENT_FAILED'
  | 'GAME_COMPLETED'
  | 'GAME_VOIDED'
  | 'POOL_CYCLE_COMPLETED';

export interface AuditEvent {
  readonly type: AuditEventType;
  readonly at: string;
  readonly gameRoundId: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface AuditHook {
  record(event: AuditEvent): void | Promise<void>;
}

// ---------------------------------------------------------------- misc

export interface ClockHook {
  now(): Date;
}

export interface IdHook {
  newGameRoundId(): string;
}

// ---------------------------------------------------------------- defaults

export class InMemoryPersistence implements PersistenceHook {
  private data: string | null = null;
  async load(): Promise<EngineSnapshot | null> {
    return this.data ? (JSON.parse(this.data) as EngineSnapshot) : null;
  }
  async save(snapshot: EngineSnapshot): Promise<void> {
    // Serialise to prove the snapshot is plain data and to decouple from live objects.
    this.data = JSON.stringify(snapshot);
  }
}

export class InMemoryAudit implements AuditHook {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
}

/** Simple wallet for development and tests. Idempotent on transactionId. */
export class InMemoryWallet implements WalletHook {
  private readonly applied = new Map<string, WalletResult>();
  constructor(public balanceCents: number) {}

  private apply(tx: WalletTransaction, delta: number): WalletResult {
    const prior = this.applied.get(tx.transactionId);
    if (prior) return prior;
    if (!Number.isSafeInteger(tx.amountCents) || tx.amountCents < 0) return { ok: false, reason: 'REJECTED' };
    if (delta < 0 && this.balanceCents < tx.amountCents)
      return { ok: false, reason: 'INSUFFICIENT_FUNDS', balanceCents: this.balanceCents };
    this.balanceCents += delta;
    const r: WalletResult = { ok: true, balanceCents: this.balanceCents };
    this.applied.set(tx.transactionId, r);
    return r;
  }
  async debit(tx: WalletTransaction) {
    return this.apply(tx, -tx.amountCents);
  }
  async credit(tx: WalletTransaction) {
    return this.apply(tx, tx.amountCents);
  }
  async refund(tx: WalletTransaction) {
    return this.apply(tx, tx.amountCents);
  }
}

export const systemClock: ClockHook = { now: () => new Date() };

export const randomUuidIds: IdHook = {
  newGameRoundId: () => globalThis.crypto.randomUUID(),
};
